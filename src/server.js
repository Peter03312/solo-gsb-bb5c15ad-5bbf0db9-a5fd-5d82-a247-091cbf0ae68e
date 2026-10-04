'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const geom = require('./geom');
const { optimize } = require('./nest');
const { validateJobInput } = require('./validate');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 数据访问辅助 ----------

function loadFull(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const defects = db.prepare('SELECT id, x, y, w, h FROM defects WHERE job_id = ?').all(jobId);
  const types = db.prepare('SELECT * FROM piece_types WHERE job_id = ?').all(jobId);
  const placements = db
    .prepare(
      `SELECT p.*, t.name, t.allow_rotate, t.bw, t.bh
       FROM placements p JOIN piece_types t ON t.id = p.piece_type_id
       WHERE p.job_id = ? ORDER BY p.id`
    )
    .all(jobId);
  return { job, defects, types, placements };
}

/** 重算实际占用长度与方案状态（complete / partial / draft） */
function recompute(jobId) {
  const cnt = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(placed), 0) AS placed FROM placements WHERE job_id = ?')
    .get(jobId);
  const ml = db
    .prepare(
      `SELECT MAX(p.y + t.bh) AS ml FROM placements p
       JOIN piece_types t ON t.id = p.piece_type_id
       WHERE p.job_id = ? AND p.placed = 1`
    )
    .get(jobId).ml;
  const used = ml == null ? 0 : ml;
  const cur = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId).status;
  let status;
  if (cnt.placed === cnt.total) status = 'complete';
  else status = cur === 'draft' ? 'draft' : 'partial';
  db.prepare('UPDATE jobs SET used_length = ?, status = ? WHERE id = ?').run(used, status, jobId);
}

/** 组装完整方案状态（API 返回） */
function jobState(jobId) {
  const full = loadFull(jobId);
  if (!full) return null;
  const { job, defects, types, placements } = full;
  return {
    job: {
      id: job.id,
      name: job.name,
      fabricWidth: job.fabric_width,
      fabricLength: job.fabric_length,
      status: job.status,
      usedLength: job.used_length,
      createdAt: job.created_at,
    },
    defects,
    pieceTypes: types.map((t) => ({
      id: t.id,
      name: t.name,
      vertices: JSON.parse(t.vertices),
      quantity: t.quantity,
      allowRotate: !!t.allow_rotate,
      bw: t.bw,
      bh: t.bh,
    })),
    placements: placements.map((p) => ({
      id: p.id,
      pieceTypeId: p.piece_type_id,
      name: p.name,
      seq: p.seq,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      placed: !!p.placed,
      locked: !!p.locked,
      allowRotate: !!p.allow_rotate,
      bw: p.bw,
      bh: p.bh,
    })),
    unplaced: placements
      .filter((p) => !p.placed)
      .map((p) => ({ id: p.id, name: p.name, seq: p.seq })),
  };
}

// ---------- 路由 ----------

app.get('/api/jobs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT j.id, j.name, j.fabric_width AS fabricWidth, j.fabric_length AS fabricLength,
              j.status, j.used_length AS usedLength, j.created_at AS createdAt,
              (SELECT COUNT(*) FROM placements p WHERE p.job_id = j.id) AS pieceCount
       FROM jobs j ORDER BY j.id DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/jobs', (req, res) => {
  const { errors, value } = validateJobInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: '输入不合法，未创建方案', details: errors });
  }
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO jobs (name, fabric_width, fabric_length) VALUES (?, ?, ?)')
      .run(value.name, value.fabricWidth, value.fabricLength);
    const jobId = info.lastInsertRowid;
    const insD = db.prepare('INSERT INTO defects (job_id, x, y, w, h) VALUES (?, ?, ?, ?, ?)');
    for (const d of value.defects) insD.run(jobId, d.x, d.y, d.w, d.h);
    const insT = db.prepare(
      'INSERT INTO piece_types (job_id, name, vertices, quantity, allow_rotate, bw, bh) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insP = db.prepare('INSERT INTO placements (job_id, piece_type_id, seq) VALUES (?, ?, ?)');
    for (const p of value.pieces) {
      const t = insT.run(jobId, p.name, JSON.stringify(p.vertices), p.quantity, p.allowRotate ? 1 : 0, p.bw, p.bh);
      for (let s = 1; s <= p.quantity; s++) insP.run(jobId, t.lastInsertRowid, s);
    }
    return jobId;
  });
  const jobId = tx();
  res.status(201).json(jobState(jobId));
});

app.get('/api/jobs/:id', (req, res) => {
  const state = jobState(Number(req.params.id));
  if (!state) return res.status(404).json({ error: '方案不存在' });
  res.json(state);
});

app.delete('/api/jobs/:id', (req, res) => {
  const info = db.prepare('DELETE FROM jobs WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: '方案不存在' });
  res.status(204).end();
});

/** 优化排样：锁定件与瑕疵固定，重新排入全部未锁定裁片 */
app.post('/api/jobs/:id/optimize', (req, res) => {
  const full = loadFull(Number(req.params.id));
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { job, defects, types, placements } = full;
  const typeById = new Map(types.map((t) => [t.id, t]));

  const locked = placements.filter((p) => p.placed && p.locked);
  const rest = placements.filter((p) => !(p.placed && p.locked));

  const result = optimize({
    W: job.fabric_width,
    L: job.fabric_length,
    defects,
    locked: locked.map((p) => {
      const t = typeById.get(p.piece_type_id);
      return {
        key: p.id,
        verts: JSON.parse(t.vertices),
        rot: p.rotation,
        x: p.x,
        y: p.y,
        w: t.bw,
        h: t.bh,
      };
    }),
    pieces: rest.map((p) => {
      const t = typeById.get(p.piece_type_id);
      const verts = JSON.parse(t.vertices);
      return {
        key: p.id,
        maskKey: 'T' + t.id,
        verts,
        allowRotate: !!t.allow_rotate,
        w: t.bw,
        h: t.bh,
        area: Math.abs(geom.area2(verts)) / 2,
      };
    }),
  });

  const lockedIds = new Set(locked.map((p) => p.id));
  const upd = db.prepare('UPDATE placements SET x = ?, y = ?, rotation = ?, placed = 1, locked = 0 WHERE id = ?');
  const clr = db.prepare('UPDATE placements SET x = NULL, y = NULL, rotation = 0, placed = 0, locked = 0 WHERE id = ?');
  const status = result.unplaced.length === 0 ? 'complete' : 'partial';
  const tx = db.transaction(() => {
    for (const pl of result.placements) {
      if (lockedIds.has(pl.key)) continue; // 锁定件保持不动
      upd.run(pl.x, pl.y, pl.rotation, pl.key);
    }
    for (const u of result.unplaced) clr.run(u.key);
    db.prepare('UPDATE jobs SET used_length = ?, status = ? WHERE id = ?').run(result.usedLength, status, job.id);
  });
  tx();
  res.json(jobState(job.id));
});

/** 手动移动（或未排入件手动放入）：冲突时指出对象并保持原方案 */
app.post('/api/jobs/:id/placements/:pid/move', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const full = loadFull(jobId);
  if (!full) return res.status(404).json({ error: '方案不存在' });
  const { job, defects, types, placements } = full;
  const placement = placements.find((p) => p.id === pid);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  const label = `裁片「${placement.name}#${placement.seq}」`;

  if (placement.locked) {
    return res.status(409).json({ error: `${label}已锁定，请先解锁再移动`, conflicts: [label] });
  }
  const { x, y, rotation } = req.body || {};
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(rotation)) {
    return res.status(400).json({ error: '位置与旋转角度必须为整数（x, y 单位 mm；rotation 为 0 或 180）' });
  }
  if (rotation !== 0 && rotation !== 180) {
    return res.status(400).json({ error: '旋转角度仅支持 0° 或 180°' });
  }
  if (rotation === 180 && !placement.allow_rotate) {
    return res.status(409).json({ error: `${label}不允许旋转（禁旋转件须保持原方向）`, conflicts: [label] });
  }
  const w = placement.bw;
  const h = placement.bh;
  if (x < 0 || y < 0 || x + w > job.fabric_width || y + h > job.fabric_length) {
    return res.status(409).json({
      error: `${label}移动后超出布幅范围（位置需满足 0≤x≤${job.fabric_width - w}, 0≤y≤${job.fabric_length - h}），已保留原方案`,
      conflicts: [label],
    });
  }

  const type = types.find((t) => t.id === placement.piece_type_id);
  const verts = JSON.parse(type.vertices);
  const abs = geom.toAbsolute(verts, rotation, w, h, x, y);

  const conflicts = [];
  for (const d of defects) {
    if (geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h))) {
      conflicts.push(`瑕疵区#${d.id}（${d.x},${d.y} ${d.w}×${d.h}mm）`);
    }
  }
  for (const q of placements) {
    if (q.id === pid || !q.placed) continue;
    const qt = types.find((t) => t.id === q.piece_type_id);
    const qAbs = geom.toAbsolute(JSON.parse(qt.vertices), q.rotation, qt.bw, qt.bh, q.x, q.y);
    if (geom.polygonsInteriorOverlap(abs, qAbs)) {
      conflicts.push(`裁片「${q.name}#${q.seq}」${q.locked ? '（已锁定）' : ''}`);
    }
  }
  if (conflicts.length > 0) {
    return res.status(409).json({ error: `${label}移动后与以下对象冲突，已保留原方案`, conflicts });
  }

  db.prepare('UPDATE placements SET x = ?, y = ?, rotation = ?, placed = 1 WHERE id = ?').run(x, y, rotation, pid);
  recompute(jobId);
  res.json(jobState(jobId));
});

/** 锁定 / 解锁（锁定件与瑕疵在优化中始终固定） */
app.post('/api/jobs/:id/placements/:pid/lock', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const placement = db
    .prepare(
      `SELECT p.*, t.name FROM placements p JOIN piece_types t ON t.id = p.piece_type_id
       WHERE p.id = ? AND p.job_id = ?`
    )
    .get(pid, jobId);
  if (!placement) return res.status(404).json({ error: '裁片不存在' });
  const locked = !!(req.body && req.body.locked);
  if (locked && !placement.placed) {
    return res.status(400).json({ error: `裁片「${placement.name}#${placement.seq}」尚未排入，不能锁定` });
  }
  db.prepare('UPDATE placements SET locked = ? WHERE id = ?').run(locked ? 1 : 0, pid);
  res.json(jobState(jobId));
});

/** 移回未排区（同时解除锁定） */
app.post('/api/jobs/:id/placements/:pid/unplace', (req, res) => {
  const jobId = Number(req.params.id);
  const pid = Number(req.params.pid);
  const info = db
    .prepare('UPDATE placements SET x = NULL, y = NULL, rotation = 0, placed = 0, locked = 0 WHERE id = ? AND job_id = ?')
    .run(pid, jobId);
  if (info.changes === 0) return res.status(404).json({ error: '裁片不存在' });
  recompute(jobId);
  res.json(jobState(jobId));
});

// ---------- 错误处理与启动 ----------

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`布料裁片排样系统已启动：http://localhost:${PORT}`);
});
