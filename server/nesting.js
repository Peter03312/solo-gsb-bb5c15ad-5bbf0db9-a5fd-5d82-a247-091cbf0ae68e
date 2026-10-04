'use strict';
// ============================================================================
// 排样引擎
//  坐标系：布料 x ∈ [0, fabricWidth]，y ∈ [0, fabricLength]。
//  每件裁片以本地多边形 + 平移 (x,y) 表示；orientation ∈ {0,180}。
//  允许边界接触（重叠面积必须为 0）。目标：尽量缩短实际占用长度。
//
//  放置策略：bottom-left 启发式 —— 为每件裁片枚举锚点（顶点-顶点
//  接触点、贴边点），从锚点反复“向下滑、向左滑”直到无法移动，取占用长度
//  最小的方案。三角化只做一次并随障碍物复用；锚点先用包围盒可行性剪枝。
// ============================================================================

const G = require('./geometry');

const EPS = 1e-9;

/** 构造障碍物：{poly, bbox, ts(三角集)} */
function makeObstacle(poly) {
  return { poly, bbox: G.bboxOf(poly), ts: G.makeTriSet(poly) };
}

/**
 * 向下（y 减小方向）平移时 piece 与各障碍物的“首次接触距离”。
 * 纯平移下，内部重叠必始于以下三类边界接触之一，取全部事件的最小正值即
 * 为安全下滑量（接触位置重叠面积为 0，边界接触允许）：
 *   A. 裁片顶点 p 碰到障碍边（在 p.x 处的边高）
 *   B. 障碍顶点 q 碰到裁片边（在 q.x 处的裁片边高）
 *   C. 顶点-顶点（x 相同）
 * 竖边只能在端点被碰到，已由 C 覆盖。
 */
function downContact(poly, obstacles, pbbox) {
  let dmin = pbbox[1] > -EPS ? pbbox[1] : Infinity; // 布幅底边 y=0

  for (const obs of obstacles) {
    const ob = obs.bbox;
    if (ob[0] >= pbbox[2] - EPS || ob[2] <= pbbox[0] + EPS) continue; // x 不交
    const op = obs.poly;
    for (const [px, py] of poly) {
      for (let i = 0; i < op.length; i++) {
        const a = op[i], b = op[(i + 1) % op.length];
        if (Math.abs(b[0] - a[0]) > EPS) {
          const cy = a[1] + (b[1] - a[1]) * (px - a[0]) / (b[0] - a[0]);
          const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
          if (cy >= lo - EPS && cy <= hi + EPS && py - cy > -EPS) {
            if (py - cy < dmin) dmin = py - cy;
          }
        }
        // 顶点-顶点
        for (const [qx, qy] of op) {
          if (Math.abs(px - qx) <= EPS && py - qy > -EPS && py - qy < dmin) dmin = py - qy;
        }
      }
    }
    for (const [qx, qy] of op) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (Math.abs(b[0] - a[0]) > EPS) {
          const ey = a[1] + (b[1] - a[1]) * (qx - a[0]) / (b[0] - a[0]);
          const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
          if (qx >= Math.min(a[0], b[0]) - EPS && qx <= Math.max(a[0], b[0]) + EPS &&
              ey - qy > -EPS && ey - qy < dmin) dmin = ey - qy;
        }
      }
    }
  }
  return Number.isFinite(dmin) ? dmin : null;
}

/** 向左（x 减小方向）平移的首次接触距离（downContact 的水平镜像） */
function leftContact(poly, obstacles, pbbox) {
  let dmin = pbbox[0] > -EPS ? pbbox[0] : Infinity; // 布幅左边 x=0

  for (const obs of obstacles) {
    const ob = obs.bbox;
    if (ob[1] >= pbbox[3] - EPS || ob[3] <= pbbox[1] + EPS) continue; // y 不交
    const op = obs.poly;
    for (const [px, py] of poly) {
      for (let i = 0; i < op.length; i++) {
        const a = op[i], b = op[(i + 1) % op.length];
        if (Math.abs(b[1] - a[1]) > EPS) {
          // 斜边：交点 x
          const cx = a[0] + (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]);
          if (cx >= Math.min(a[0], b[0]) - EPS && cx <= Math.max(a[0], b[0]) + EPS &&
              px - cx > -EPS && px - cx < dmin) dmin = px - cx;
        }
        // 竖边：裁片顶点左移碰到障碍竖边
        if (Math.abs(b[0] - a[0]) <= EPS &&
            py > Math.min(a[1], b[1]) - EPS && py < Math.max(a[1], b[1]) + EPS &&
            px - a[0] > -EPS && px - a[0] < dmin) dmin = px - a[0];
        // 顶点-顶点
        for (const [qx, qy] of op) {
          if (Math.abs(py - qy) <= EPS && px - qx > -EPS && px - qx < dmin) dmin = px - qx;
        }
      }
    }
    for (const [qx, qy] of op) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (Math.abs(b[1] - a[1]) > EPS) {
          const ex = a[0] + (b[0] - a[0]) * (qy - a[1]) / (b[1] - a[1]);
          if (qy >= Math.min(a[1], b[1]) - EPS && qy <= Math.max(a[1], b[1]) + EPS &&
              ex - qx > -EPS && ex - qx < dmin) dmin = ex - qx;
        }
        // 障碍顶点左移碰到裁片竖边
        if (Math.abs(b[0] - a[0]) <= EPS &&
            qy > Math.min(a[1], b[1]) - EPS && qy < Math.max(a[1], b[1]) + EPS &&
            a[0] - qx > -EPS && a[0] - qx < dmin) dmin = a[0] - qx;
      }
    }
  }
  return Number.isFinite(dmin) ? dmin : null;
}

/** 判断世界包围盒是否完全在布幅内（边界允许） */
function bboxInsideFabric(b, width, length) {
  return b[0] >= -EPS && b[2] <= width + EPS && b[1] >= -EPS && b[3] <= length + EPS;
}

/**
 * 从锚点 (ax,ay) 开始 bottom-left 滑动，返回 {x,y}（浮点）或 null。
 * 每步取首次接触距离一次到位；最终再做一次精确重叠校验兜底。
 */
function settle(orientedPoly, localBBox, tsBase, ax, ay, orientation, obstacles, width, length) {
  let x = ax, y = ay;
  const wbAt = (xx, yy) => [localBBox[0] + xx, localBBox[1] + yy, localBBox[2] + xx, localBBox[3] + yy];
  if (!bboxInsideFabric(wbAt(x, y), width, length)) return null;
  for (const obs of obstacles) {
    if (G.bboxesOverlap(wbAt(x, y), obs.bbox) &&
        G.triSetsOverlap(G.translateTriSet(tsBase, x, y), obs.ts)) return null;
  }

  for (let iter = 0; iter < 400; iter++) {
    let moved = false;
    let world = orientedPoly.map(p => [p[0] + x, p[1] + y]);
    const dDown = downContact(world, obstacles, wbAt(x, y));
    if (dDown !== null && dDown > EPS) { y -= dDown; moved = true; }

    world = orientedPoly.map(p => [p[0] + x, p[1] + y]);
    const dLeft = leftContact(world, obstacles, wbAt(x, y));
    if (dLeft !== null && dLeft > EPS) { x -= dLeft; moved = true; }

    if (!moved) break;
  }

  if (!bboxInsideFabric(wbAt(x, y), width, length)) return null;
  for (const obs of obstacles) {
    if (G.bboxesOverlap(wbAt(x, y), obs.bbox) &&
        G.triSetsOverlap(G.translateTriSet(tsBase, x, y), obs.ts)) return null;
  }
  return { x, y };
}

/** 整数位置最终校验：布幅 + 精确重叠面积 */
function validPosition(orientedPoly, localBBox, tsBase, x, y, obstacles, width, length) {
  const wb = [localBBox[0] + x, localBBox[1] + y, localBBox[2] + x, localBBox[3] + y];
  if (!bboxInsideFabric(wb, width, length)) return false;
  let ts = null;
  for (const obs of obstacles) {
    if (!G.bboxesOverlap(wb, obs.bbox)) continue;
    if (!ts) ts = G.translateTriSet(tsBase, x, y);
    if (G.triSetsOverlap(ts, obs.ts)) return false;
  }
  return true;
}

/** 把浮点位置取整为整数毫米，在小范围内找最佳合法整数位置（优先更低、更左） */
function snapInteger(orientedPoly, localBBox, tsBase, pos, orientation, obstacles, width, length) {
  if (!pos) return null;
  const cands = [];
  for (const yy of [Math.ceil(pos.y), Math.floor(pos.y), Math.round(pos.y)]) {
    for (const xx of [Math.round(pos.x), Math.floor(pos.x), Math.ceil(pos.x)]) {
      cands.push([xx, yy]);
    }
  }
  cands.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
  for (const [ix, iy] of cands) {
    if (Number.isInteger(ix) && Number.isInteger(iy) &&
        validPosition(orientedPoly, localBBox, tsBase, ix, iy, obstacles, width, length)) {
      return { x: ix, y: iy };
    }
  }
  return null;
}

/**
 * 取多边形的“左下包络”顶点：局部最低点（下滑接触）、局部最左点（左滑接触）
 * 及包围盒角点。这些是 bottom-left 滑动中唯一可能成为支撑接触的顶点。
 */
function lowerLeftEnvelope(poly) {
  const n = poly.length;
  const set = new Map();
  const add = p => set.set(p[0] + ':' + p[1], p);
  const b = G.bboxOf(poly);
  for (let i = 0; i < n; i++) {
    const p = poly[i], prev = poly[(i - 1 + n) % n], next = poly[(i + 1) % n];
    if (p[1] <= prev[1] + EPS && p[1] <= next[1] + EPS) add(p); // 局部最低
    if (p[0] <= prev[0] + EPS && p[0] <= next[0] + EPS) add(p); // 局部最左
    if (Math.abs(p[0] - b[0]) <= EPS && Math.abs(p[1] - b[1]) <= EPS) add(p);
    if (Math.abs(p[0] - b[2]) <= EPS && Math.abs(p[1] - b[1]) <= EPS) add(p);
  }
  return [...set.values()];
}

/** 障碍的“上/右包络”支撑顶点：局部最高、局部最右 */
function upperRightEnvelope(poly) {
  const n = poly.length;
  const set = new Map();
  const add = p => set.set(p[0] + ':' + p[1], p);
  const b = G.bboxOf(poly);
  for (let i = 0; i < n; i++) {
    const p = poly[i], prev = poly[(i - 1 + n) % n], next = poly[(i + 1) % n];
    if (p[1] >= prev[1] - EPS && p[1] >= next[1] - EPS) add(p); // 局部最高
    if (p[0] >= prev[0] - EPS && p[0] >= next[0] - EPS) add(p); // 局部最右
    if (Math.abs(p[0] - b[0]) <= EPS && Math.abs(p[1] - b[3]) <= EPS) add(p);
    if (Math.abs(p[0] - b[2]) <= EPS && Math.abs(p[1] - b[3]) <= EPS) add(p);
  }
  return [...set.values()];
}

/**
 * 为某件裁片生成候选锚点（NFP bottom-left 接触点，O(障碍顶点数)）。
 * 锚点以“本地多边形平移量”表示。
 */
function candidateAnchors(oriented, localBBox, tsBase, obstacles, width, length) {
  const [lminX, , lmaxX, lmaxY] = localBBox;
  const anchors = new Map();
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // 包围盒可行性剪枝
    if (localBBox[0] + x < -EPS || lmaxX + x > width + EPS) return;
    if (localBBox[1] + y < -EPS || lmaxY + y > length + EPS) return;
    const key = Math.round(x * 1000) + ',' + Math.round(y * 1000);
    if (!anchors.has(key)) anchors.set(key, [x, y]);
  };

  add(0, 0);
  add(width - lmaxX, 0); // 包围盒右边贴布幅右边

  const sp = lowerLeftEnvelope(oriented);
  // piece 最左顶点、最低顶点（贴底行对齐用）
  const minXpts = sp.filter(p => Math.abs(p[0] - lminX) <= EPS);

  for (const obs of obstacles) {
    const [ominX, , omaxX, omaxY] = obs.bbox;
    const top = upperRightEnvelope(obs.poly);

    // ① 站在障碍上/右肩：piece 下/左顶点对齐障碍上/右支撑顶点
    for (const v of sp) {
      for (const u of top) add(u[0] - v[0], u[1] - v[1]);
    }
    // ② 沿障碍最高水平高度滑动时，x 与障碍各顶点对齐
    for (const v of sp) {
      for (const u of obs.poly) add(u[0] - v[0], omaxY - v[1]);
    }
    // ③ 立于障碍 bbox 顶部、裁片左右边与 bbox 左右对齐（凹形保守锚点）
    for (const v of sp) {
      add(ominX - v[0], omaxY - v[1]);
      add(omaxX - v[0], omaxY - v[1]);
    }
    add(ominX - lmaxX, omaxY);
    add(omaxX - lminX, omaxY);
    // ④ 贴底行：x 与障碍各顶点对齐
    for (const v of minXpts.length ? minXpts : [oriented[0]]) {
      for (const u of obs.poly) add(u[0] - v[0], -v[1]);
    }
  }
  return [...anchors.values()];
}

/** 尝试放置一件裁片，返回最佳整数位置 {x,y,orientation,usedLen} 或 null */
function placeOne(localPoly, rotatable, obstacles, width, length, bestLimit) {
  const orientations = rotatable ? [0, 180] : [0];
  let best = null;
  for (const orientation of orientations) {
    const oriented = orientation === 180 ? G.rotate180(localPoly) : localPoly;
    const localBBox = G.bboxOf(oriented);
    const tsBase = G.makeTriSet(oriented);
    const anchors = candidateAnchors(oriented, localBBox, tsBase, obstacles, width, length);

    // 锚点按“滑到底的可能 y”粗排：先试落在障碍物顶部的锚点
    for (const [ax, ay] of anchors) {
      const settled = settle(oriented, localBBox, tsBase, ax, ay, orientation, obstacles, width, length);
      const snapped = snapInteger(oriented, localBBox, tsBase, settled, orientation, obstacles, width, length);
      if (!snapped) continue;
      const usedLen = localBBox[3] + snapped.y;
      if (!best || usedLen < best.usedLen - EPS ||
          (Math.abs(usedLen - best.usedLen) <= EPS && snapped.x < best.x)) {
        best = { x: snapped.x, y: snapped.y, orientation, usedLen };
      }
    }
  }
  return best;
}

/**
 * 主排样入口。
 * @param {object} cfg {width, length}
 * @param {Array} defects [{x,y,w,h}]
 * @param {Array} pieces  [{id,name,polygon,quantity,rotatable,
 *                          placement:{x,y,orientation}|null(未放置), locked}]
 * @returns {{placements:Map|Array, unplaced:[{pieceId,index,name,reason}], usedLength, complete}}
 */
function nest(cfg, defects, pieces) {
  const { width, length } = cfg;
  const obstacles = [];

  // 瑕疵（矩形）始终为固定障碍
  for (const d of defects) {
    const poly = [
      [d.x, d.y], [d.x + d.w, d.y], [d.x + d.w, d.y + d.h], [d.x, d.y + d.h],
    ];
    obstacles.push(Object.assign(makeObstacle(poly), { kind: 'defect', ref: d.id }));
  }

  // 展开裁片实例；锁定件保持原位并作为障碍
  const instances = [];
  const lockedErrors = [];
  for (const p of pieces) {
    for (let i = 0; i < p.quantity; i++) {
      const pl = Array.isArray(p.placement) ? p.placement[i] : (i === 0 ? p.placement : null);
      instances.push({ pieceId: p.id, name: p.name, index: i + 1, polygon: p.polygon,
        rotatable: !!p.rotatable, locked: !!pl && !!pl.locked, placement: pl || null });
    }
  }

  // 先放锁定件（校验：越界/与瑕疵或其他锁定件内部重叠即失败，原方案保持不变）
  const locked = instances.filter(v => v.locked);
  const free = instances.filter(v => !v.locked);

  for (const inst of locked) {
    const { x, y, orientation } = inst.placement;
    if (!inst.rotatable && orientation === 180) {
      lockedErrors.push({ object: `${inst.name} #${inst.index}`, reason: '该裁片禁止旋转，却处于 180° 方向' });
      continue;
    }
    const world = G.toWorld(inst.polygon, x, y, orientation);
    if (!bboxInsideFabric(G.bboxOf(world), width, length)) {
      lockedErrors.push({ object: `${inst.name} #${inst.index}`, reason: `锁定位置超出布幅（包围盒 ${JSON.stringify(G.bboxOf(world))}，布幅 ${width}×${length}）` });
      continue;
    }
    for (const obs of obstacles) {
      if (G.polygonsOverlap(world, obs.poly)) {
        lockedErrors.push({ object: `${inst.name} #${inst.index}`, reason: `锁定位置与${obs.kind === 'defect' ? '瑕疵区' : '锁定裁片'}${obs.ref != null ? ' ' + obs.ref : ''}内部重叠` });
      }
    }
    obstacles.push(Object.assign(makeObstacle(world), { kind: 'piece', ref: `${inst.name} #${inst.index}` }));
  }

  if (lockedErrors.length) {
    return { ok: false, conflicts: lockedErrors };
  }

  // 两种实例顺序各跑一次：面积降序；长边（包围盒 max 边）降序。取放得更多者。
  const orders = [
    free.slice().sort((a, b) => G.polygonArea(b.polygon) - G.polygonArea(a.polygon)),
    free.slice().sort((a, b) => {
      const ba = G.bboxOf(a.polygon), bb = G.bboxOf(b.polygon);
      return Math.max(bb[2] - bb[0], bb[3] - bb[1]) - Math.max(ba[2] - ba[0], ba[3] - ba[1]);
    }),
  ];

  let bestRun = null;

  for (const order of orders) {
    const runObstacles = obstacles.slice();
    const placed = locked.map(v => ({
      pieceId: v.pieceId, index: v.index, name: v.name,
      x: v.placement.x, y: v.placement.y, orientation: v.placement.orientation,
      locked: true,
    }));
    const unplaced = [];
    let usedLength = 0;
    for (const v of locked) {
      const wb = G.bboxOf(G.toWorld(v.polygon, v.placement.x, v.placement.y, v.placement.orientation));
      if (wb[3] > usedLength) usedLength = wb[3];
    }

    for (const inst of order) {
      const hit = placeOne(inst.polygon, inst.rotatable, runObstacles, width, length);
      if (!hit) {
        unplaced.push({ pieceId: inst.pieceId, index: inst.index, name: inst.name,
          reason: '剩余空间无法容纳该裁片（在现有锁定件/瑕疵/已排裁片约束下）' });
        continue;
      }
      const world = G.toWorld(inst.polygon, hit.x, hit.y, hit.orientation);
      runObstacles.push(Object.assign(makeObstacle(world), { kind: 'piece', ref: `${inst.name} #${inst.index}` }));
      placed.push({ pieceId: inst.pieceId, index: inst.index, name: inst.name,
        x: hit.x, y: hit.y, orientation: hit.orientation, locked: false });
      usedLength = Math.max(usedLength, hit.usedLen);
    }

    if (!bestRun || placed.length > bestRun.placed.length ||
        (placed.length === bestRun.placed.length && usedLength < bestRun.usedLength)) {
      bestRun = { placed, unplaced, usedLength };
    }
  }

  // 按 pieceId/index 整理输出
  bestRun.placed.sort((a, b) => (a.pieceId - b.pieceId) || (a.index - b.index));
  bestRun.unplaced.sort((a, b) => (a.pieceId - b.pieceId) || (a.index - b.index));
  return {
    ok: true,
    placements: bestRun.placed,
    unplaced: bestRun.unplaced,
    usedLength: bestRun.usedLength,
    complete: bestRun.unplaced.length === 0,
  };
}

module.exports = { nest, placeOne, settle };
