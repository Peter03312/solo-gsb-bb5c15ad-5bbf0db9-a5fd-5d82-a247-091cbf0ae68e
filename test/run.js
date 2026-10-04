'use strict';

const assert = require('assert');
const geom = require('../src/geom');
const { optimize } = require('../src/nest');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
    process.exitCode = 1;
  }
}

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/** 排样结果不变量校验：边界、两两不重叠、不压瑕疵、锁定件不动 */
function verifyLayout({ W, L, defects, locked, result, typesByKey }) {
  const absOf = (pl) => {
    const t = typesByKey.get(pl.key);
    return geom.toAbsolute(t.verts, pl.rotation, t.w, t.h, pl.x, pl.y);
  };
  const polys = result.placements.map((pl) => ({ pl, abs: absOf(pl) }));
  for (const { pl, abs } of polys) {
    for (const [x, y] of abs) {
      assert(x >= 0 && x <= W && y >= 0 && y <= L, `裁片 ${pl.key} 顶点 (${x},${y}) 超出布幅`);
    }
    for (const d of defects) {
      assert(
        !geom.polygonsInteriorOverlap(abs, geom.rectPoly(d.x, d.y, d.w, d.h)),
        `裁片 ${pl.key} 与瑕疵区 (${d.x},${d.y},${d.w},${d.h}) 重叠`
      );
    }
  }
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      assert(
        !geom.polygonsInteriorOverlap(polys[i].abs, polys[j].abs),
        `裁片 ${polys[i].pl.key} 与 ${polys[j].pl.key} 内部重叠`
      );
    }
  }
  for (const lp of locked) {
    const got = result.placements.find((p) => p.key === lp.key);
    assert(got, '锁定件丢失');
    assert(got.x === lp.x && got.y === lp.y && got.rotation === lp.rot, '锁定件位置被改变');
  }
}

// ---------------- 几何：轮廓校验 ----------------
console.log('几何：轮廓校验');
test('合法矩形通过', () => {
  assert.strictEqual(geom.validatePolygon(rect(0, 0, 10, 10)), null);
});
test('凹多边形（L 形）通过', () => {
  assert.strictEqual(
    geom.validatePolygon([[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]]),
    null
  );
});
test('自交（蝴蝶结）被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 10], [10, 0], [0, 10]]));
});
test('零面积被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [5, 5], [10, 10]]));
});
test('重复相邻顶点被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 0], [10, 0], [0, 10]]));
});
test('非整数坐标被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10.5, 0], [0, 10]]));
});
test('顶点数不足被拒绝', () => {
  assert(geom.validatePolygon([[0, 0], [10, 0]]));
});

// ---------------- 几何：内部重叠（边界接触允许） ----------------
console.log('几何：内部重叠判定');
test('边接触的矩形不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10)));
});
test('部分共边（T 型接触）不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(3, 10, 4, 8)));
});
test('角点接触不重叠', () => {
  assert(!geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(10, 10, 5, 5)));
});
test('正面积重叠被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(9, 0, 10, 10)));
});
test('完全重合被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(0, 0, 10, 10)));
});
test('包含关系被检出', () => {
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), rect(2, 2, 3, 3)));
});
test('内接菱形（顶点全在对方边界上）被检出', () => {
  const diamond = [[5, 0], [10, 5], [5, 10], [0, 5]];
  assert(geom.polygonsInteriorOverlap(rect(0, 0, 10, 10), diamond));
});
test('旋转 180° 后与原向不重叠（相邻放置）', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, 40, 0);
  assert(!geom.polygonsInteriorOverlap(a, b));
});
test('旋转 180° 互补拼接（共斜边）不重叠', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, 0, 0); // 与 a 恰好拼满同一矩形，仅共斜边
  assert(!geom.polygonsInteriorOverlap(a, b));
});
test('旋转 180° 错位放置重叠被检出', () => {
  const tri = [[0, 0], [40, 0], [0, 30]];
  const a = geom.toAbsolute(tri, 0, 40, 30, 0, 0);
  const b = geom.toAbsolute(tri, 180, 40, 30, -10, 0);
  assert(geom.polygonsInteriorOverlap(a, b));
});

// ---------------- 排样 ----------------
console.log('排样优化器');
test('矩形排样：全部排入且无重叠，占用长度正确', () => {
  const W = 1000, L = 2000;
  const defects = [{ x: 0, y: 0, w: 100, h: 100 }];
  const mk = (key) => ({
    key, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000,
  });
  const pieces = [mk('a'), mk('b'), mk('c'), mk('d')];
  const result = optimize({ W, L, defects, locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0, '应全部排入');
  assert.strictEqual(result.placements.length, 4);
  assert(result.usedLength <= 1100, `占用长度 ${result.usedLength} 应 ≤ 1100`);
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects, locked: [], result, typesByKey });
});

test('超出布幅宽度的裁片列入未排入', () => {
  const result = optimize({
    W: 1000, L: 2000, defects: [], locked: [],
    pieces: [{ key: 'big', maskKey: 'b', verts: rect(0, 0, 1200, 100), allowRotate: true, w: 1200, h: 100, area: 120000 }],
  });
  assert.strictEqual(result.unplaced.length, 1);
  assert(/超出布幅/.test(result.unplaced[0].reason));
});

test('长度不足时列入未排入', () => {
  const pieces = [];
  for (let i = 0; i < 5; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000 });
  }
  const result = optimize({ W: 1000, L: 1000, defects: [], locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 1, '应恰有 1 件放不下');
  assert.strictEqual(result.placements.length, 4);
});

test('锁定件保持固定，其余绕开', () => {
  const locked = [{ key: 'L1', verts: rect(0, 0, 500, 500), rot: 0, x: 250, y: 100, w: 500, h: 500 }];
  const pieces = [];
  for (let i = 0; i < 3; i++) {
    pieces.push({ key: 'p' + i, maskKey: 'r', verts: rect(0, 0, 500, 500), allowRotate: false, w: 500, h: 500, area: 250000 });
  }
  const result = optimize({ W: 1000, L: 2000, defects: [], locked, pieces });
  assert.strictEqual(result.unplaced.length, 0);
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  typesByKey.set('L1', { verts: rect(0, 0, 500, 500), w: 500, h: 500 });
  verifyLayout({ W: 1000, L: 2000, defects: [], locked, result, typesByKey });
});

test('禁旋转件保持 0°，可旋转件角度合法', () => {
  const lshape = [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]];
  const pieces = [
    { key: 'a', maskKey: 'L', verts: lshape, allowRotate: true, w: 300, h: 300, area: 50000 },
    { key: 'b', maskKey: 'L', verts: lshape, allowRotate: false, w: 300, h: 300, area: 50000 },
    { key: 'c', maskKey: 'L', verts: lshape, allowRotate: false, w: 300, h: 300, area: 50000 },
  ];
  const result = optimize({ W: 400, L: 2000, defects: [], locked: [], pieces });
  assert.strictEqual(result.unplaced.length, 0);
  for (const pl of result.placements) {
    if (pl.key === 'a') assert(pl.rotation === 0 || pl.rotation === 180);
    else assert.strictEqual(pl.rotation, 0, '禁旋转件不得旋转');
  }
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W: 400, L: 2000, defects: [], locked: [], result, typesByKey });
});

test('随机矩形压力测试（不变量）', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const W = 1600, L = 6000;
  const defects = [
    { x: 700, y: 800, w: 150, h: 200 },
    { x: 200, y: 3000, w: 300, h: 120 },
  ];
  const pieces = [];
  for (let i = 0; i < 30; i++) {
    const w = 100 + Math.floor(rnd() * 400);
    const h = 100 + Math.floor(rnd() * 500);
    pieces.push({
      key: 'r' + i, maskKey: 'r' + i, verts: rect(0, 0, w, h),
      allowRotate: rnd() < 0.5, w, h, area: w * h,
    });
  }
  const result = optimize({ W, L, defects, locked: [], pieces });
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects, locked: [], result, typesByKey });
  assert(result.usedLength <= L);
  console.log(`    （随机测试：排入 ${result.placements.length}/30，占用长度 ${result.usedLength}mm）`);
});

test('随机多边形（含凹形/三角）压力测试（不变量）', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const W = 1600, L = 8000;
  const shapes = [
    [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]], // L 形
    [[0, 0], [400, 0], [0, 300]],                                     // 三角形
    [[0, 0], [250, 0], [250, 150], [125, 220], [0, 150]],             // 五边形
  ];
  const pieces = [];
  for (let i = 0; i < 24; i++) {
    const verts = shapes[i % shapes.length];
    const w = Math.max(...verts.map((v) => v[0]));
    const h = Math.max(...verts.map((v) => v[1]));
    pieces.push({
      key: 's' + i, maskKey: 's' + (i % shapes.length), verts,
      allowRotate: rnd() < 0.5, w, h, area: Math.abs(geom.area2(verts)) / 2,
    });
  }
  const result = optimize({ W, L, defects: [], locked: [], pieces });
  const typesByKey = new Map(pieces.map((p) => [p.key, p]));
  verifyLayout({ W, L, defects: [], locked: [], result, typesByKey });
  console.log(`    （随机测试：排入 ${result.placements.length}/24，占用长度 ${result.usedLength}mm）`);
});

console.log(`\n${passed} 项测试${process.exitCode ? '，存在失败' : '全部通过'}。`);
