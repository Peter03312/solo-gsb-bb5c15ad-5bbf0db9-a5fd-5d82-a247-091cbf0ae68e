'use strict';
// ============================================================================
// 几何引擎：坐标均为整数毫米。多边形为简单多边形（无自交、面积非零）。
// 重叠判定以“内部重叠”为准（重叠面积 > 0 才算冲突，边/点接触允许）。
// ============================================================================

const EPS = 1e-9;

/** 包围盒 [minX, minY, maxX, maxY] */
function bboxOf(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function bboxesOverlap(a, b) {
  return a[0] < b[2] - EPS && a[2] > b[0] + EPS &&
         a[1] < b[3] - EPS && a[3] > b[1] + EPS;
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

/** 有向面积的两倍（正值表示逆时针） */
function signedArea2(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s;
}

function eqPoint(a, b) {
  return Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS;
}

/** 点 p 是否在线段 [a,b] 上 */
function pointOnSegment(p, a, b) {
  if (Math.abs(cross(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1])) > EPS) return false;
  return Math.min(a[0], b[0]) - EPS <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPS &&
         Math.min(a[1], b[1]) - EPS <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPS;
}

/** 线段是否相交；includeTouch=true 时端点接触/共线接触也算 */
function segmentsIntersect(p1, p2, q1, q2, includeTouch) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = q2[0] - q1[0], d2y = q2[1] - q1[1];
  const den = cross(d1x, d1y, d2x, d2y);
  const tx = q1[0] - p1[0], ty = q1[1] - p1[1];
  if (Math.abs(den) > EPS) {
    const t = cross(tx, ty, d2x, d2y) / den;
    const u = cross(tx, ty, d1x, d1y) / den;
    const inside = includeTouch
      ? (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS)
      : (t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS);
    if (inside) {
      // 端点落在另一线段上时属于“接触”，内部相交判定不算
      if (!includeTouch) {
        if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return false;
        // 交点恰为某条线段端点
        const ix = p1[0] + d1x * t, iy = p1[1] + d1y * t;
        if (eqPoint([ix, iy], p1) || eqPoint([ix, iy], p2) ||
            eqPoint([ix, iy], q1) || eqPoint([ix, iy], q2)) return false;
      }
      return true;
    }
    return false;
  }
  // 平行
  if (!includeTouch) return false;
  if (Math.abs(cross(tx, ty, d1x, d1y)) > EPS) return false; // 不共线
  return pointOnSegment(p1, q1, q2) || pointOnSegment(p2, q1, q2) ||
         pointOnSegment(q1, p1, p2) || pointOnSegment(q2, p1, p2);
}

/**
 * 校验简单多边形：
 *  - 至少 3 个顶点，坐标为整数
 *  - 无重复顶点
 *  - 非退化（面积非零）
 *  - 任意两条非相邻边无交叉（端点接触同样不允许：会造成自接触）
 */
function validatePolygon(poly) {
  if (!Array.isArray(poly) || poly.length < 3) {
    return '多边形至少需要 3 个顶点';
  }
  for (const p of poly) {
    if (!Array.isArray(p) || p.length !== 2 ||
        !Number.isFinite(p[0]) || !Number.isFinite(p[1]) ||
        !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
      return '多边形顶点必须是整数坐标 [x, y]';
    }
  }
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      if (poly[i][0] === poly[j][0] && poly[i][1] === poly[j][1]) {
        return `多边形存在重复顶点：(${poly[i][0]}, ${poly[i][1]})`;
      }
    }
  }
  if (Math.abs(signedArea2(poly)) < EPS) return '多边形面积为 0（退化图形）';
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const e1 = [poly[i], poly[(i + 1) % n]];
    for (let j = i + 1; j < n; j++) {
      const adjacent = (i === j) || ((i + 1) % n === j) || ((j + 1) % n === i);
      if (adjacent) continue;
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n], true)) {
        return `多边形自交：边 (${poly[i][0]},${poly[i][1]})-(${poly[(i + 1) % n][0]},${poly[(i + 1) % n][1]}) 与 (${poly[j][0]},${poly[j][1]})-(${poly[(j + 1) % n][0]},${poly[(j + 1) % n][1]}) 相交`;
      }
    }
  }
  return null;
}

/** 去掉连续共线顶点（耳切前的预处理），逆时针返回 */
function normalizePoly(poly) {
  let pts = poly.map(p => [p[0], p[1]]);
  if (signedArea2(pts) < 0) pts.reverse();
  // 去除共线中间点
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    if (Math.abs(cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1])) > EPS) {
      out.push(b);
    }
  }
  return out.length >= 3 ? out : pts;
}

/** 耳切法三角化，返回 [[x1,y1,x2,y2,x3,y3], ...]（逆时针） */
function triangulate(poly) {
  const pts = normalizePoly(poly);
  const n = pts.length;
  if (n === 3) return [[...pts[0], ...pts[1], ...pts[2]]];

  const pointInTriangle = (p, a, b, c) => {
    const d1 = cross(p[0] - a[0], p[1] - a[1], b[0] - a[0], b[1] - a[1]);
    const d2 = cross(p[0] - b[0], p[1] - b[1], c[0] - b[0], c[1] - b[1]);
    const d3 = cross(p[0] - c[0], p[1] - c[1], a[0] - c[0], a[1] - c[1]);
    const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
    const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
    return !(hasNeg && hasPos); // 边界上也算在内（因此可防止跨过共线点切耳）
  };

  let indices = pts.map((_, i) => i);
  const tris = [];
  let guard = 0;
  while (indices.length > 3 && guard++ < 10 * n) {
    let earFound = false;
    for (let k = 0; k < indices.length; k++) {
      const i0 = indices[(k - 1 + indices.length) % indices.length];
      const i1 = indices[k];
      const i2 = indices[(k + 1) % indices.length];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      if (cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]) <= EPS) continue;
      let containsOther = false;
      for (const idx of indices) {
        if (idx === i0 || idx === i1 || idx === i2) continue;
        if (pointInTriangle(pts[idx], a, b, c)) { containsOther = true; break; }
      }
      if (containsOther) continue;
      tris.push([...a, ...b, ...c]);
      indices.splice(k, 1);
      earFound = true;
      break;
    }
    if (!earFound) break; // 理论上简单多边形必有耳；保险起见退出
  }
  if (indices.length === 3) {
    tris.push([...pts[indices[0]], ...pts[indices[1]], ...pts[indices[2]]]);
  }
  if (tris.length === 0) throw new Error('多边形三角化失败');
  return tris;
}

/** 180° 旋转（绕裁片包围盒中心，旋转后包围盒不变，坐标平移回原位） */
function rotate180(poly) {
  const [minX, minY, maxX, maxY] = bboxOf(poly);
  return poly.map(([x, y]) => [minX + maxX - x, minY + maxY - y]);
}

/** 本地坐标 -> 世界坐标（平移 dx,dy；orientation 为 180 时先旋转） */
function toWorld(poly, x, y, orientation) {
  const src = orientation === 180 ? rotate180(poly) : poly;
  return src.map(([px, py]) => [px + x, py + y]);
}

/** 多边形面积（绝对值） */
function polygonArea(poly) {
  return Math.abs(signedArea2(poly)) / 2;
}

/** 点是否在多边形内部或边界上（射线法） */
function pointInPoly(p, poly) {
  const [px, py] = p;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (pointOnSegment(p, poly[i], poly[j])) return true;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ----------------------------------------------------------------------------
// Sutherland-Hodgman 裁剪：用 clipPoly 裁剪 subjectPoly，返回相交区域多边形
// ----------------------------------------------------------------------------
function clipPolygon(subject, clipPoly) {
  let output = subject.slice();
  for (let i = 0; i < clipPoly.length; i++) {
    const cp1 = clipPoly[(i - 1 + clipPoly.length) % clipPoly.length];
    const cp2 = clipPoly[i];
    if (output.length === 0) return [];
    const input = output;
    output = [];
    let s = input[input.length - 1];
    for (const e of input) {
      const eIn = cross(cp2[0] - cp1[0], cp2[1] - cp1[1], e[0] - cp1[0], e[1] - cp1[1]) >= -EPS;
      const sIn = cross(cp2[0] - cp1[0], cp2[1] - cp1[1], s[0] - cp1[0], s[1] - cp1[1]) >= -EPS;
      if (eIn) {
        if (!sIn) output.push(lineIntersection(s, e, cp1, cp2));
        output.push(e);
      } else if (sIn) {
        output.push(lineIntersection(s, e, cp1, cp2));
      }
      s = e;
    }
  }
  return output;
}

function lineIntersection(p1, p2, q1, q2) {
  const dx1 = p2[0] - p1[0], dy1 = p2[1] - p1[1];
  const dx2 = q2[0] - q1[0], dy2 = q2[1] - q1[1];
  const t = cross(q1[0] - p1[0], q1[1] - p1[1], dx2, dy2) / cross(dx1, dy1, dx2, dy2);
  return [p1[0] + dx1 * t, p1[1] + dy1 * t];
}

/** 两多边形是否存在“内部重叠”（重叠面积 > 0）。a/b 可为任意简单多边形。 */
function polygonsOverlap(a, b) {
  return triSetsOverlap(makeTriSet(a), makeTriSet(b));
}

/** 预计算多边形三角集（供需要反复平移同一多边形的调用方复用） */
function makeTriSet(poly) {
  return triangulate(poly).map(t => {
    const pts = [[t[0], t[1]], [t[2], t[3]], [t[4], t[5]]];
    return { pts, bbox: bboxOf(pts) };
  });
}

/** 平移三角集（不重新三角化） */
function translateTriSet(ts, dx, dy) {
  return ts.map(t => {
    const pts = t.pts.map(p => [p[0] + dx, p[1] + dy]);
    return { pts, bbox: [t.bbox[0] + dx, t.bbox[1] + dy, t.bbox[2] + dx, t.bbox[3] + dy] };
  });
}

/** 两个三角集是否存在正面积交集（凹多边形也精确） */
function triSetsOverlap(ta, tb) {
  for (const a of ta) {
    for (const b of tb) {
      if (!bboxesOverlap(a.bbox, b.bbox)) continue;
      const inter = clipPolygon(a.pts, b.pts);
      if (inter.length >= 3 && polygonArea(inter) > 1e-6) return true;
    }
  }
  return false;
}

module.exports = {
  EPS,
  bboxOf,
  bboxesOverlap,
  signedArea2,
  polygonArea,
  validatePolygon,
  normalizePoly,
  triangulate,
  makeTriSet,
  translateTriSet,
  triSetsOverlap,
  rotate180,
  toWorld,
  pointInPoly,
  polygonsOverlap,
  segmentsIntersect,
};
