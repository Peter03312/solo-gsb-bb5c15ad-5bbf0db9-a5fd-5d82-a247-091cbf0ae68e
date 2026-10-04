'use strict';
// ============================================================================
// HTTP 服务：静态页面 + JSON API。
// 任何非法输入或冲突均返回 400/409，错误信息指出具体对象，且不改动现有方案。
// ============================================================================

const path = require('path');
const express = require('express');
const G = require('./geometry');
const nesting = require('./nesting');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

db.open();

// ---------------------------------------------------------------------------
// 校验辅助
// ---------------------------------------------------------------------------

function isPosInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

function conflict(res, conflicts) {
  return res.status(409).json({ error: '存在冲突，未改动现有方案', conflicts });
}

/** 组装排样引擎所需裁片数据（含每实例的当前放置） */
function buildNestInput(state) {
  const byPiece = new Map(state.pieces.map(p => [p.id, p]));
  const placementsMap = new Map();
  for (const pl of state.placements) {
    const key = pl.pieceId;
    if (!placementsMap.has(key)) placementsMap.set(key, []);
    placementsMap.get(key).push(pl);
  }
  const pieces = state.pieces.map(p => ({
    id: p.id, name: p.name, polygon: p.polygon, quantity: p.quantity,
    rotatable: p.rotatable,
    placement: (placementsMap.get(p.id) || []).sort((a, b) => a.index - b.index),
  }));
  return { pieces, placementsMap, byPiece };
}

/** 检查一组放置的内部一致性，返回冲突列表（用于配置/瑕疵/几何变更） */
function checkConsistency(state, piecesOverride) {
  const cfg = state.config;
  const conflicts = [];
  const pieces = piecesOverride || state.pieces;
  const polyOf = new Map(pieces.map(p => [p.id, p]));

  // 瑕疵矩形
  const defectPolys = state.defects.map(d => ({
    id: d.id,
    poly: [[d.x, d.y], [d.x + d.w, d.y], [d.x + d.w, d.y + d.h], [d.x, d.y + d.h]],
  }));
  for (const d of defectPolys) {
    const b = G.bboxOf(d.poly);
    if (b[0] < 0 || b[1] < 0 || b[2] > cfg.width || b[3] > cfg.length) {
      conflicts.push({ object: `瑕疵区 #${d.id}`, reason: '超出布幅范围' });
    }
  }

  const worldPlaced = [];
  for (const pl of state.placements) {
    const piece = polyOf.get(pl.pieceId);
    if (!piece) continue;
    if (pl.index > piece.quantity) {
      conflicts.push({ object: `${piece.name} #${pl.index}`, reason: '件数小于已放置的序号' });
      continue;
    }
    if (!piece.rotatable && pl.orientation === 180) {
      conflicts.push({ object: `${piece.name} #${pl.index}`, reason: '该裁片禁止旋转，却处于 180° 方向' });
    }
    const world = G.toWorld(piece.polygon, pl.x, pl.y, pl.orientation);
    const b = G.bboxOf(world);
    if (b[0] < 0 || b[1] < 0 || b[2] > cfg.width || b[3] > cfg.length) {
      conflicts.push({ object: `${piece.name} #${pl.index}`, reason: `超出布幅（包围盒到 ${b[2]}×${b[3]}，布幅 ${cfg.width}×${cfg.length}）` });
    }
    for (const d of defectPolys) {
      if (G.polygonsOverlap(world, d.poly)) {
        conflicts.push({ object: `${piece.name} #${pl.index}`, reason: `与瑕疵区 #${d.id} 内部重叠` });
      }
    }
    worldPlaced.push({ pl, piece, world });
  }
  for (let i = 0; i < worldPlaced.length; i++) {
    for (let j = i + 1; j < worldPlaced.length; j++) {
      if (G.polygonsOverlap(worldPlaced[i].world, worldPlaced[j].world)) {
        const a = worldPlaced[i], b = worldPlaced[j];
        conflicts.push({
          object: `${a.piece.name} #${a.pl.index}`,
          reason: `与 ${b.piece.name} #${b.pl.index} 内部重叠`,
        });
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/state', (req, res) => {
  res.json(db.getState());
});

// ---- 布料配置 -------------------------------------------------------------
app.put('/api/config', (req, res) => {
  const { width, length } = req.body || {};
  if (!isPosInt(width) || !isPosInt(length)) {
    return badRequest(res, '布幅宽度与可用长度必须为正整数（毫米）');
  }
  const state = db.getState();
  const trial = { ...state, config: { width, length } };
  const conflicts = checkConsistency(trial);
  if (conflicts.length) return conflict(res, conflicts);
  db.updateConfig(width, length);
  res.json(db.getState());
});

// ---- 瑕疵区 ---------------------------------------------------------------
app.post('/api/defects', (req, res) => {
  const { x, y, w, h } = req.body || {};
  for (const [k, v] of [['x', x], ['y', y], ['w', w], ['h', h]]) {
    if (!Number.isInteger(v)) return badRequest(res, `瑕疵区参数 ${k} 必须为整数（毫米）`);
  }
  if (w <= 0 || h <= 0) return badRequest(res, '瑕疵区宽高必须为正整数');
  const state = db.getState();
  if (x < 0 || y < 0 || x + w > state.config.width || y + h > state.config.length) {
    return badRequest(res, '瑕疵区必须完整落在布幅内');
  }
  const id = db.addDefect(x, y, w, h);
  const trial = db.getState();
  const conflicts = checkConsistency(trial);
  if (conflicts.length) {
    db.removeDefect(id); // 回滚，保持原方案
    return conflict(res, conflicts);
  }
  res.json(trial);
});

app.delete('/api/defects/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.removeDefect(id)) return res.status(404).json({ error: `瑕疵区 #${id} 不存在` });
  res.json(db.getState());
});

// ---- 裁片模板 -------------------------------------------------------------
function parsePieceBody(body) {
  const name = (body.name || '').toString().trim();
  if (!name) return { error: '裁片名称不能为空' };
  let polygon = body.polygon;
  if (typeof polygon === 'string') {
    // 支持每行 "x,y" 的文本输入
    try {
      polygon = JSON.parse(polygon);
    } catch (_) {
      polygon = polygon.trim().split(/\r?\n/).map(line => {
        const parts = line.split(/[,\s]+/).filter(Boolean).map(Number);
        return [parts[0], parts[1]];
      });
    }
  }
  const polyErr = G.validatePolygon(polygon);
  if (polyErr) return { error: `裁片「${name}」轮廓非法：${polyErr}` };
  if (!isPosInt(body.quantity) || body.quantity > 999) {
    return { error: `裁片「${name}」件数必须为 1..999 的整数` };
  }
  const rotatable = !!body.rotatable;
  return { value: { name, polygon, quantity: body.quantity, rotatable } };
}

app.post('/api/pieces', (req, res) => {
  const parsed = parsePieceBody(req.body || {});
  if (parsed.error) return badRequest(res, parsed.error);
  const id = db.addPiece(parsed.value);
  res.json(db.getState());
});

app.put('/api/pieces/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const state = db.getState();
  const old = state.pieces.find(p => p.id === id);
  if (!old) return res.status(404).json({ error: `裁片 #${id} 不存在` });

  const body = { name: req.body.name ?? old.name, polygon: req.body.polygon ?? old.polygon,
    quantity: req.body.quantity ?? old.quantity, rotatable: req.body.rotatable ?? old.rotatable };
  const parsed = parsePieceBody(body);
  if (parsed.error) return badRequest(res, parsed.error);
  const next = parsed.value;

  // 缩减件数时若要删除锁定件则拒绝
  if (next.quantity < old.quantity) {
    const lockedRemoved = state.placements
      .filter(pl => pl.pieceId === id && pl.index > next.quantity && pl.locked);
    if (lockedRemoved.length) {
      return conflict(res, lockedRemoved.map(pl => ({
        object: `${old.name} #${pl.index}`, reason: '该裁片已锁定，不能通过减少件数将其移除',
      })));
    }
  }
  const trialPieces = state.pieces.map(p => p.id === id
    ? { ...p, name: next.name, polygon: next.polygon, quantity: next.quantity, rotatable: next.rotatable }
    : p);
  const trial = { ...state, pieces: trialPieces };
  const conflicts = checkConsistency(trial);
  if (conflicts.length) return conflict(res, conflicts);

  db.updatePiece(id, next);
  // 缩减件数：删除超出的未锁定放置
  for (const pl of state.placements) {
    if (pl.pieceId === id && pl.index > next.quantity) db.deletePlacement(id, pl.index);
  }
  res.json(db.getState());
});

app.delete('/api/pieces/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const state = db.getState();
  const old = state.pieces.find(p => p.id === id);
  if (!old) return res.status(404).json({ error: `裁片 #${id} 不存在` });
  const locked = state.placements.filter(pl => pl.pieceId === id && pl.locked);
  if (locked.length) {
    return conflict(res, locked.map(pl => ({
      object: `${old.name} #${pl.index}`, reason: '该裁片已锁定，不能删除',
    })));
  }
  db.removePiece(id);
  res.json(db.getState());
});

// ---- 手动移动 / 锁定 ------------------------------------------------------
app.post('/api/placements/move', (req, res) => {
  const { pieceId, index, x, y, orientation } = req.body || {};
  const state = db.getState();
  const piece = state.pieces.find(p => p.id === pieceId);
  if (!piece) return res.status(404).json({ error: '裁片不存在' });
  if (!Number.isInteger(index) || index < 1 || index > piece.quantity) {
    return badRequest(res, `${piece.name}：件序号非法（应在 1..${piece.quantity}）`);
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return badRequest(res, `${piece.name} #${index}：移动目标坐标必须为整数毫米`);
  }
  const cur = state.placements.find(pl => pl.pieceId === pieceId && pl.index === index);
  if (cur && cur.locked) {
    return conflict(res, [{ object: `${piece.name} #${index}`, reason: '该裁片已锁定，移动前请先解锁' }]);
  }
  const nextOrient = orientation === undefined ? (cur ? cur.orientation : 0) : orientation;
  if (![0, 180].includes(nextOrient)) {
    return badRequest(res, `${piece.name} #${index}：方向只能是 0 或 180`);
  }
  if (!piece.rotatable && nextOrient === 180) {
    return conflict(res, [{ object: `${piece.name} #${index}`, reason: '该裁片禁止旋转 180°' }]);
  }

  const world = G.toWorld(piece.polygon, x, y, nextOrient);
  const b = G.bboxOf(world);
  const conflicts = [];
  if (b[0] < 0 || b[1] < 0 || b[2] > state.config.width || b[3] > state.config.length) {
    conflicts.push({ object: `${piece.name} #${index}`,
      reason: `移动后超出布幅（包围盒到 ${b[2]}×${b[3]}，布幅 ${state.config.width}×${state.config.length}）` });
  }
  for (const d of state.defects) {
    const dp = [[d.x, d.y], [d.x + d.w, d.y], [d.x + d.w, d.y + d.h], [d.x, d.y + d.h]];
    if (G.polygonsOverlap(world, dp)) {
      conflicts.push({ object: `${piece.name} #${index}`, reason: `移动后与瑕疵区 #${d.id} 内部重叠` });
    }
  }
  for (const other of state.placements) {
    if (other.pieceId === pieceId && other.index === index) continue;
    const op = state.pieces.find(p => p.id === other.pieceId);
    const ow = G.toWorld(op.polygon, other.x, other.y, other.orientation);
    if (G.polygonsOverlap(world, ow)) {
      conflicts.push({ object: `${piece.name} #${index}`, reason: `移动后与 ${op.name} #${other.index} 内部重叠` });
    }
  }
  if (conflicts.length) return conflict(res, conflicts);

  db.updatePlacement(pieceId, index, x, y, nextOrient, !!(cur && cur.locked));
  res.json(db.getState());
});

app.post('/api/placements/lock', (req, res) => {
  const { pieceId, index, locked } = req.body || {};
  const state = db.getState();
  const piece = state.pieces.find(p => p.id === pieceId);
  if (!piece) return res.status(404).json({ error: '裁片不存在' });
  const cur = state.placements.find(pl => pl.pieceId === pieceId && pl.index === index);
  if (!cur) return badRequest(res, `${piece.name} #${index} 尚未排入布料，无法锁定`);
  db.updatePlacement(pieceId, index, cur.x, cur.y, cur.orientation, !!locked);
  res.json(db.getState());
});

// ---- 重新优化 -------------------------------------------------------------
app.post('/api/optimize', (req, res) => {
  const state = db.getState();
  const { pieces } = buildNestInput(state);
  const result = nesting.nest(state.config, state.defects, pieces);
  if (!result.ok) return conflict(res, result.conflicts);
  db.replacePlacements(result.placements, result.unplaced);
  db.recordRun(result.usedLength, result.complete, result.unplaced);
  res.json({ ...db.getState(), run: {
    usedLength: result.usedLength, complete: result.complete, unplaced: result.unplaced } });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误：' + err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`布料裁片排样应用已启动：http://localhost:${PORT}`);
});
