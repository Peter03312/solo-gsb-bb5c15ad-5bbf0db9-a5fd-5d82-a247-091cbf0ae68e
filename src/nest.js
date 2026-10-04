'use strict';

const { rotate180 } = require('./geom');

/**
 * 排样优化器（整数毫米）。
 *
 * 方法：1mm 占用栅格 + 左下（bottom-left）启发式 + 压实局部搜索。
 * 栅格占用判定为保守判定：格子被占用 当且仅当 多边形内部与格子内部有正面积交集。
 * 因此“两件裁片无共同占用格” ⇒ 精确几何上内部也必不重叠（安全）；
 * 反之栅格可能在斜边附近留出约 1mm 的空隙（保守，属正常排样余量）。
 * 手动移动与冲突校验使用 geom 模块的精确判定，边界接触完全允许。
 *
 * 目标：在布幅宽度 W、可用长度 L（均为整数毫米）内放置全部裁片，并尽量缩短实际占用长度。
 * 位置优劣：占用长度（y+h）最小 → 与已放置件/布边接触周长最大 → x 最小。
 */

class Grid {
  constructor(W, L) {
    this.W = W;
    this.L = L;
    this.rows = 0; // 已分配行数（按需增长，避免一次性分配整卷长度）
    this.data = new Uint8Array(0); // 0=空闲 1=占用
  }

  ensureRows(r) {
    if (r <= this.rows) return;
    let nr = this.rows === 0 ? 1024 : this.rows * 2;
    if (nr < r) nr = r;
    if (nr > this.L) nr = this.L;
    const nd = new Uint8Array(this.W * nr);
    nd.set(this.data);
    this.data = nd;
    this.rows = nr;
  }

  fillRect(x, y, w, h) {
    this.ensureRows(y + h);
    for (let yy = y; yy < y + h; yy++) {
      this.data.fill(1, yy * this.W + x, yy * this.W + x + w);
    }
  }

  /** 掩码放于 (px,py) 时，返回最低的冲突栅格行号；无冲突返回 -1。调用前需 ensureRows。 */
  testMask(mask, px, py) {
    const W = this.W;
    const data = this.data;
    for (let r = 0; r < mask.h; r++) {
      const runs = mask.rows[r];
      if (runs.length === 0) continue;
      const base = (py + r) * W + px;
      for (let k = 0; k < runs.length; k++) {
        const a = runs[k][0];
        const b = runs[k][1];
        for (let x = a; x <= b; x++) {
          if (data[base + x] !== 0) return py + r;
        }
      }
    }
    return -1;
  }

  /** 将掩码区域写为 val（1=占用，0=清除；各裁片栅格互不相交，清除安全） */
  markMask(mask, px, py, val) {
    const W = this.W;
    for (let r = 0; r < mask.h; r++) {
      const base = (py + r) * W + px;
      const runs = mask.rows[r];
      for (let k = 0; k < runs.length; k++) {
        this.data.fill(val, base + runs[k][0], base + runs[k][1] + 1);
      }
    }
  }

  /** 接触周长评分：掩码边界与已占用格/布幅边界相邻的边数（越大越紧凑） */
  contactScore(mask, px, py) {
    const W = this.W;
    const L = this.L;
    const data = this.data;
    let score = 0;
    for (let r = 0; r < mask.h; r++) {
      const gy = py + r;
      const rowBase = gy * W;
      const runs = mask.rows[r];
      for (let k = 0; k < runs.length; k++) {
        const a = runs[k][0];
        const b = runs[k][1];
        const lx = px + a;
        const rx = px + b;
        if (lx === 0 || data[rowBase + lx - 1] !== 0) score++;
        if (rx === W - 1 || data[rowBase + rx + 1] !== 0) score++;
        const up = gy === 0 ? 1 : 0;
        const downRow = gy + 1;
        for (let x = a; x <= b; x++) {
          const gx = px + x;
          if (up || data[rowBase - W + gx] !== 0) score++;
          if (downRow >= L || (downRow < this.rows && data[rowBase + W + gx] !== 0)) score++;
        }
      }
    }
    return score;
  }
}

/** 边穿过的开放格子标记（细长多边形可能不覆盖任何格子中心，需补充） */
function markEdgeCells(occ, w, h, a, b) {
  const ts = [0, 1];
  if (b[0] !== a[0]) {
    const lo = Math.min(a[0], b[0]);
    const hi = Math.max(a[0], b[0]);
    for (let k = lo + 1; k <= hi - 1; k++) ts.push((k - a[0]) / (b[0] - a[0]));
  }
  if (b[1] !== a[1]) {
    const lo = Math.min(a[1], b[1]);
    const hi = Math.max(a[1], b[1]);
    for (let k = lo + 1; k <= hi - 1; k++) ts.push((k - a[1]) / (b[1] - a[1]));
  }
  ts.sort((p, q) => p - q);
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-12) continue;
    const tm = (t0 + t1) / 2;
    const mx = a[0] + tm * (b[0] - a[0]);
    const my = a[1] + tm * (b[1] - a[1]);
    const fx = Math.floor(mx);
    const fy = Math.floor(my);
    // 仅当边严格穿过格子内部（非沿格线）时标记
    if (mx !== fx && my !== fy && fx >= 0 && fy >= 0 && fx < w && fy < h) {
      occ[fy * w + fx] = 1;
    }
  }
}

/**
 * 由归一化多边形构建栅格掩码：{ w, h, rows: [[[x0,x1],...], ...] }。
 * 占用语义：多边形内部与格子内部有正面积交集（边界接触不算）。
 */
function buildMask(pts, w, h) {
  const occ = new Uint8Array(w * h);
  const n = pts.length;
  // 1) 扫描线填充：采样点为格子中心 (x+0.5, y+0.5)，中心落在闭多边形上即占用。
  //    中心为半整数坐标，永远不会与整数顶点/水平边重合，无退化情形。
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if ((a[1] < cy) !== (b[1] < cy)) {
        xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    if (xs.length === 0) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const lo = Math.max(0, Math.ceil(xs[k] - 0.5));
      const hi = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      if (hi >= lo) occ.fill(1, y * w + lo, y * w + hi + 1);
    }
  }
  // 2) 边穿过的格子（覆盖细长突出部分）
  for (let i = 0; i < n; i++) {
    markEdgeCells(occ, w, h, pts[i], pts[(i + 1) % n]);
  }
  // 3) 压缩为行区间
  const rows = [];
  for (let y = 0; y < h; y++) {
    const runs = [];
    let x = 0;
    while (x < w) {
      if (occ[y * w + x]) {
        let x2 = x + 1;
        while (x2 < w && occ[y * w + x2]) x2++;
        runs.push([x, x2 - 1]);
        x = x2;
      } else {
        x++;
      }
    }
    rows.push(runs);
  }
  return { w, h, rows };
}

/** 位置比较：更优返回 true（占用长度小 → 接触周长大 → x 小） */
function betterPos(pos, best) {
  if (!best) return true;
  if (pos.top !== best.top) return pos.top < best.top;
  if (pos.contact !== best.contact) return pos.contact > best.contact;
  return pos.x < best.x;
}

/** 在候选 x 列上为掩码寻找最优位置 */
function findPosition(grid, mask, candidateXs, L) {
  let best = null;
  for (const px of candidateXs) {
    if (px < 0 || px + mask.w > grid.W) continue;
    let y = 0;
    while (y + mask.h <= L) {
      grid.ensureRows(y + mask.h);
      const hit = grid.testMask(mask, px, y);
      if (hit < 0) {
        const cand = { x: px, y, top: y + mask.h, contact: grid.contactScore(mask, px, y) };
        if (betterPos(cand, best)) best = cand;
        break;
      }
      y = hit + 1; // 跳过冲突行
    }
  }
  return best;
}

/**
 * 执行排样。
 * @param {object} input
 *   W, L            布幅宽度 / 可用长度（mm）
 *   defects         [{x,y,w,h}] 瑕疵区（始终固定）
 *   locked          [{key, verts, rot, x, y, w, h}] 锁定裁片（始终固定，verts 为归一化顶点）
 *   pieces          [{key, maskKey, verts, allowRotate, w, h, area}] 待排裁片
 * @returns { placements: [{key,x,y,rotation,h}], unplaced: [{key,reason}], usedLength }
 */
function optimize({ W, L, defects, locked, pieces }) {
  const grid = new Grid(W, L);
  const rects = []; // 已占用外接矩形 {x, w}，用于生成候选 x
  const maskCache = new Map();

  function getMask(maskKey, rot, verts, w, h) {
    const ck = maskKey + ':' + rot;
    let m = maskCache.get(ck);
    if (!m) {
      m = buildMask(rot === 180 ? rotate180(verts, w, h) : verts, w, h);
      maskCache.set(ck, m);
    }
    return m;
  }

  function candidatesFor(maskW) {
    const set = new Set([0, W - maskW]);
    for (const r of rects) {
      set.add(r.x + r.w); // 左缘对齐到障碍物右缘
      set.add(r.x - maskW); // 右缘对齐到障碍物左缘
    }
    return [...set].sort((a, b) => a - b);
  }

  for (const d of defects) {
    grid.fillRect(d.x, d.y, d.w, d.h);
    rects.push({ x: d.x, w: d.w });
  }

  const placements = [];
  const unplaced = [];
  const movables = []; // placements 中可重新优化项的引用

  // 锁定裁片：按原位置原方向写入栅格（视同固定障碍）
  for (const lp of locked) {
    const mask = getMask('L' + lp.key, lp.rot, lp.verts, lp.w, lp.h);
    grid.ensureRows(lp.y + lp.h);
    grid.markMask(mask, lp.x, lp.y, 1);
    rects.push({ x: lp.x, w: lp.w });
    placements.push({ key: lp.key, x: lp.x, y: lp.y, rotation: lp.rot, h: lp.h });
  }

  function findBest(p) {
    const masks = [{ rot: 0, mask: getMask(p.maskKey, 0, p.verts, p.w, p.h) }];
    if (p.allowRotate) {
      masks.push({ rot: 180, mask: getMask(p.maskKey, 180, p.verts, p.w, p.h) });
    }
    let best = null;
    for (const m of masks) {
      const pos = findPosition(grid, m.mask, candidatesFor(m.mask.w), L);
      if (pos) {
        const cand = { ...pos, rot: m.rot, mask: m.mask };
        if (
          !best ||
          betterPos(cand, best) ||
          (cand.top === best.top && cand.contact === best.contact && cand.x === best.x && m.rot < best.rot)
        ) {
          best = cand;
        }
      }
    }
    return best;
  }

  function putDown(p, best) {
    grid.markMask(best.mask, best.x, best.y, 1);
    const rect = { x: best.x, w: p.w };
    rects.push(rect);
    const rec = {
      key: p.key, x: best.x, y: best.y, rotation: best.rot, h: p.h,
      _p: p, _mask: best.mask, _rect: rect, _top: best.top, _contact: best.contact,
    };
    placements.push(rec);
    movables.push(rec);
    return rec;
  }

  // 初始放置：面积降序（大件先排）
  const sorted = [...pieces].sort((a, b) => b.area - a.area);
  const deferred = [];
  for (const p of sorted) {
    if (p.w > W) {
      unplaced.push({ key: p.key, reason: `裁片外接宽度 ${p.w}mm 超出布幅 ${W}mm` });
      continue;
    }
    const best = findBest(p);
    if (!best) {
      deferred.push(p);
      continue;
    }
    putDown(p, best);
  }

  // 压实：逐件取出重排，严格更优才接受（锁定件不参与）
  for (let round = 0; round < 3; round++) {
    let improved = false;
    for (const rec of movables) {
      grid.markMask(rec._mask, rec.x, rec.y, 0);
      rects.splice(rects.indexOf(rec._rect), 1);
      const best = findBest(rec._p);
      if (
        best &&
        (best.top < rec._top ||
          (best.top === rec._top && best.contact > rec._contact) ||
          (best.top === rec._top && best.contact === rec._contact && best.x < rec.x))
      ) {
        rec.x = best.x;
        rec.y = best.y;
        rec.rotation = best.rot;
        rec._mask = best.mask;
        rec._top = best.top;
        rec._contact = best.contact;
        improved = true;
      }
      rec._rect.x = rec.x;
      grid.markMask(rec._mask, rec.x, rec.y, 1);
      rects.push(rec._rect);
    }
    if (!improved) break;
  }

  // 重试此前放不下的裁片（压实后可能出现空位）
  for (const p of deferred) {
    const best = findBest(p);
    if (best) {
      putDown(p, best);
    } else {
      unplaced.push({ key: p.key, reason: `可用长度 ${L}mm 内找不到可行位置` });
    }
  }

  let usedLength = 0;
  for (const pl of placements) {
    if (pl.y + pl.h > usedLength) usedLength = pl.y + pl.h;
  }
  return {
    placements: placements.map((p) => ({ key: p.key, x: p.x, y: p.y, rotation: p.rotation, h: p.h })),
    unplaced,
    usedLength,
  };
}

module.exports = { optimize, buildMask, Grid };
