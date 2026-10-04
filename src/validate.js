'use strict';

const geom = require('./geom');

/** 规模限制（小型工作室量级，同时约束栅格内存与计算时间） */
const LIMITS = {
  maxWidth: 5000,          // 布幅最大 5m
  maxLength: 100000,       // 可用长度最大 100m
  maxAreaCells: 150000000, // 布幅×长度栅格上限（约 150MB）
  maxDefects: 100,
  maxPieceTypes: 200,
  maxQuantityPerType: 200,
  maxTotalPieces: 1000,
};

function isInt(v) {
  return Number.isInteger(v);
}

/**
 * 校验创建方案的输入。返回 { errors: [string], value }。
 * 所有错误均指明出错对象；errors 非空时 value 为 null。
 */
function validateJobInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { errors: ['请求体为空或格式不正确'], value: null };
  }

  // ---- 基本信息 ----
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : '未命名方案';

  const W = body.fabricWidth;
  const L = body.fabricLength;
  if (!isInt(W) || W < 1 || W > LIMITS.maxWidth) {
    errors.push(`布幅宽度：必须为 1~${LIMITS.maxWidth} 的整数毫米`);
  }
  if (!isInt(L) || L < 1 || L > LIMITS.maxLength) {
    errors.push(`可用长度：必须为 1~${LIMITS.maxLength} 的整数毫米`);
  }
  if (isInt(W) && isInt(L) && W > 0 && L > 0 && W * L > LIMITS.maxAreaCells) {
    errors.push(`布幅面积 ${W}×${L}mm 超出系统上限（${LIMITS.maxAreaCells} 平方毫米）`);
  }

  // ---- 瑕疵区 ----
  const defects = [];
  const rawDefects = Array.isArray(body.defects) ? body.defects : [];
  if (rawDefects.length > LIMITS.maxDefects) {
    errors.push(`瑕疵区数量过多（最多 ${LIMITS.maxDefects} 个）`);
  }
  rawDefects.slice(0, LIMITS.maxDefects).forEach((d, i) => {
    const tag = `瑕疵区#${i + 1}`;
    if (!d || !isInt(d.x) || !isInt(d.y) || !isInt(d.w) || !isInt(d.h)) {
      errors.push(`${tag}：坐标与尺寸必须为整数毫米`);
      return;
    }
    if (d.w < 1 || d.h < 1) {
      errors.push(`${tag}：宽度与高度必须 ≥ 1mm`);
      return;
    }
    if (isInt(W) && isInt(L) && (d.x < 0 || d.y < 0 || d.x + d.w > W || d.y + d.h > L)) {
      errors.push(`${tag}：矩形 (${d.x},${d.y},${d.w}×${d.h}) 超出布幅范围`);
      return;
    }
    defects.push({ x: d.x, y: d.y, w: d.w, h: d.h });
  });

  // ---- 裁片型号 ----
  const pieces = [];
  const rawPieces = Array.isArray(body.pieces) ? body.pieces : [];
  if (rawPieces.length < 1) errors.push('至少需要一种裁片');
  if (rawPieces.length > LIMITS.maxPieceTypes) {
    errors.push(`裁片型号过多（最多 ${LIMITS.maxPieceTypes} 种）`);
  }
  let totalPieces = 0;
  rawPieces.slice(0, LIMITS.maxPieceTypes).forEach((p, i) => {
    const pname = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 50) : `裁片${i + 1}`;
    const tag = `裁片「${pname}」`;
    let bad = false;

    const err = geom.validatePolygon(p.vertices);
    if (err) {
      errors.push(`${tag}：${err}`);
      bad = true;
    }
    if (!isInt(p.quantity) || p.quantity < 1 || p.quantity > LIMITS.maxQuantityPerType) {
      errors.push(`${tag}：件数必须为 1~${LIMITS.maxQuantityPerType} 的整数`);
      bad = true;
    }
    if (bad) return;

    const norm = geom.normalize(p.vertices);
    if (isInt(W) && norm.w > W) {
      errors.push(`${tag}：外接宽度 ${norm.w}mm 超出布幅 ${W}mm（旋转 180° 不改变外接尺寸），永远无法排入`);
      return;
    }
    if (isInt(L) && norm.h > L) {
      errors.push(`${tag}：外接长度 ${norm.h}mm 超出可用长度 ${L}mm，永远无法排入`);
      return;
    }
    totalPieces += p.quantity;
    pieces.push({
      name: pname,
      vertices: norm.pts,
      quantity: p.quantity,
      allowRotate: p.allowRotate === true,
      bw: norm.w,
      bh: norm.h,
    });
  });
  if (totalPieces > LIMITS.maxTotalPieces) {
    errors.push(`裁片总件数 ${totalPieces} 超出上限（${LIMITS.maxTotalPieces} 件）`);
  }

  if (errors.length > 0) return { errors, value: null };
  return { errors, value: { name, fabricWidth: W, fabricLength: L, defects, pieces } };
}

module.exports = { validateJobInput, LIMITS };
