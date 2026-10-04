'use strict';
// 简单断言测试：node tests/geometry.test.js
const assert = require('assert');
const G = require('../server/geometry');
const { nest } = require('../server/nesting');

let n = 0;
function ok(name, fn) { fn(); console.log(`  ✓ ${name}`); n++; }

console.log('几何引擎测试');

ok('矩形面积', () => {
  assert.strictEqual(G.polygonArea([[0, 0], [10, 0], [10, 5], [0, 5]]), 50);
});

ok('自交多边形被拒', () => {
  const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10]];
  assert.ok(G.validatePolygon(bowtie));
});

ok('合法矩形通过', () => {
  assert.strictEqual(G.validatePolygon([[0, 0], [10, 0], [10, 5], [0, 5]]), null);
});

ok('非整数坐标被拒', () => {
  assert.ok(G.validatePolygon([[0, 0], [1.5, 0], [1.5, 5], [0, 5]]));
});

ok('L 形凹多边形通过且可三角化', () => {
  const l = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  assert.strictEqual(G.validatePolygon(l), null);
  const tris = G.triangulate(l);
  const area = tris.reduce((s, t) => s + G.polygonArea([[t[0], t[1]], [t[2], t[3]], [t[4], t[5]]]), 0);
  assert.ok(Math.abs(area - G.polygonArea(l)) < 1e-6);
});

ok('边接触不算内部重叠', () => {
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b = [[10, 0], [20, 0], [20, 10], [10, 10]];
  assert.strictEqual(G.polygonsOverlap(a, b), false);
});

ok('一像素重叠算冲突', () => {
  const a = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const b = [[9, 0], [20, 0], [20, 10], [9, 10]];
  assert.strictEqual(G.polygonsOverlap(a, b), true);
});

ok('凹多边形相咬检测', () => {
  const l = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const bite = [[1, 5], [3, 5], [3, 9], [1, 9]]; // 伸进 L 的竖臂
  assert.strictEqual(G.polygonsOverlap(l, bite), true);
  const inNotch = [[5, 5], [9, 5], [9, 9], [5, 9]]; // 落在凹口里，不重叠
  assert.strictEqual(G.polygonsOverlap(l, inNotch), false);
});

ok('180° 旋转包围盒不变', () => {
  const p = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const r = G.rotate180(p);
  assert.deepStrictEqual(G.bboxOf(r), G.bboxOf(p));
});

ok('点在凹多边形凹口外', () => {
  const l = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  assert.strictEqual(G.pointInPoly([7, 7], l), false);
  assert.strictEqual(G.pointInPoly([2, 2], l), true);
});

console.log('排样引擎测试');

ok('两片矩形排入并接触布边', () => {
  const r = nest(
    { width: 200, length: 1000 },
    [],
    [{ id: 1, name: '片', polygon: [[0, 0], [100, 0], [100, 50], [0, 50]],
       quantity: 2, rotatable: false, placement: [] }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.placements.length, 2);
  assert.strictEqual(r.usedLength, 50);
});

ok('布幅太窄时无法放入', () => {
  const r = nest(
    { width: 50, length: 1000 },
    [],
    [{ id: 1, name: '片', polygon: [[0, 0], [100, 0], [100, 50], [0, 50]],
       quantity: 1, rotatable: false, placement: [] }]);
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.unplaced.length, 1);
});

ok('瑕疵区被避开', () => {
  const r = nest(
    { width: 100, length: 1000 },
    [{ id: 1, x: 0, y: 0, w: 100, h: 60 }], // 底部整条瑕疵
    [{ id: 1, name: '片', polygon: [[0, 0], [50, 0], [50, 50], [0, 50]],
       quantity: 1, rotatable: false, placement: [] }]);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.placements[0].y >= 60, true);
});

ok('锁定件固定，其余围绕排布', () => {
  const r = nest(
    { width: 200, length: 1000 }, [],
    [{ id: 1, name: '锁', polygon: [[0, 0], [100, 0], [100, 50], [0, 50]],
       quantity: 1, rotatable: false,
       placement: [{ x: 50, y: 200, orientation: 0, locked: true }] },
     { id: 2, name: '新', polygon: [[0, 0], [100, 0], [100, 50], [0, 50]],
       quantity: 1, rotatable: false, placement: [] }]);
  assert.strictEqual(r.ok, true);
  const lock = r.placements.find(p => p.pieceId === 1);
  assert.strictEqual(lock.x, 50);
  assert.strictEqual(lock.y, 200);
  assert.strictEqual(lock.locked, true);
});

ok('锁定件与瑕疵冲突时报错且不给方案', () => {
  const r = nest(
    { width: 200, length: 1000 },
    [{ id: 7, x: 0, y: 0, w: 200, h: 100 }],
    [{ id: 1, name: '锁', polygon: [[0, 0], [100, 0], [100, 50], [0, 50]],
       quantity: 1, rotatable: false,
       placement: [{ x: 0, y: 0, orientation: 0, locked: true }] }]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts[0].object.includes('锁'));
});

ok('禁旋转件保持原方向', () => {
  const r = nest(
    { width: 300, length: 1000 }, [],
    [{ id: 1, name: '片', polygon: [[0, 0], [100, 0], [100, 40], [40, 40], [40, 60], [0, 60]],
       quantity: 1, rotatable: false, placement: [] }]);
  assert.strictEqual(r.placements[0].orientation, 0);
});

ok('输出坐标均为整数', () => {
  const r = nest(
    { width: 333, length: 1000 }, [],
    [{ id: 1, name: '片',
       polygon: [[0, 0], [127, 0], [127, 33], [50, 33], [50, 91], [0, 91]],
       quantity: 5, rotatable: true, placement: [] }]);
  for (const p of r.placements) {
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y));
  }
});

ok('所有放置互不重叠且在布幅内（随机压力）', () => {
  const polys = [
    [[0, 0], [120, 0], [120, 80], [0, 80]],
    [[0, 0], [90, 0], [90, 60], [30, 60], [30, 140], [0, 140]],
    [[0, 0], [60, 0], [60, 60], [0, 60]],
  ];
  const r = nest({ width: 400, length: 6000 }, [],
    polys.map((polygon, id) => ({ id: id + 1, name: 'p' + id, polygon,
      quantity: 4, rotatable: true, placement: [] })));
  assert.strictEqual(r.complete, true);
  const worlds = r.placements.map(pl => {
    const poly = polys[pl.pieceId - 1];
    return G.toWorld(poly, pl.x, pl.y, pl.orientation);
  });
  for (let i = 0; i < worlds.length; i++) {
    const b = G.bboxOf(worlds[i]);
    assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= 400 + 1e-6 && b[3] <= 6000 + 1e-6);
    for (let j = i + 1; j < worlds.length; j++) {
      assert.strictEqual(G.polygonsOverlap(worlds[i], worlds[j]), false);
    }
  }
});

ok('非零原点多边形也能贴左下角', () => {
  // 顶点从 (10,10) 起算的三角形
  const tri = [[10, 10], [60, 10], [10, 60]];
  const r = nest({ width: 500, length: 1000 }, [],
    [{ id: 1, name: '三角', polygon: tri, quantity: 1, rotatable: false, placement: [] }]);
  assert.strictEqual(r.complete, true);
  const p = r.placements[0];
  // 平移后包围盒左下角应为 (0,0)
  const world = G.toWorld(tri, p.x, p.y, 0);
  assert.deepStrictEqual(G.bboxOf(world).slice(0, 2), [0, 0]);
});

ok('允许旋转时 180° 可用于更优排布', () => {
  // 宽扁片两块 + 窄幅；180° 不改变包围盒，但结果必须合法
  const p = [[0, 0], [200, 0], [200, 60], [0, 60]];
  const r = nest({ width: 210, length: 1000 }, [],
    [{ id: 1, name: '片', polygon: p, quantity: 2, rotatable: true, placement: [] }]);
  assert.strictEqual(r.complete, true);
  for (const pl of r.placements) assert.ok([0, 180].includes(pl.orientation));
});

ok('斜边裁片接触：直角三角形两块不重叠', () => {
  const tri = [[0, 0], [100, 0], [0, 100]];
  const r = nest({ width: 500, length: 1000 }, [],
    [{ id: 1, name: '三角', polygon: tri, quantity: 3, rotatable: true, placement: [] }]);
  assert.strictEqual(r.complete, true);
  const ws = r.placements.map(pl => G.toWorld(tri, pl.x, pl.y, pl.orientation));
  for (let i = 0; i < ws.length; i++)
    for (let j = i + 1; j < ws.length; j++)
      assert.strictEqual(G.polygonsOverlap(ws[i], ws[j]), false);
});

ok('锁定件占位导致未锁定件排不下时列入 unplaced', () => {
  // 布幅 200×240：两块 100×100 锁定件铺满底部整行，剩余竖向高度仅 140；
  // 新片 150×150 无法放入（任何 x 都需要 150 高）
  const r = nest(
    { width: 200, length: 240 }, [],
    [{ id: 1, name: '锁', polygon: [[0, 0], [100, 0], [100, 100], [0, 100]],
       quantity: 2, rotatable: false,
       placement: [{ x: 0, y: 0, orientation: 0, locked: true },
                   { x: 100, y: 0, orientation: 0, locked: true }] },
     { id: 2, name: '新', polygon: [[0, 0], [150, 0], [150, 150], [0, 150]],
       quantity: 1, rotatable: false, placement: [] }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.unplaced[0].pieceId, 2);
});

console.log(`\n全部 ${n} 项测试通过`);