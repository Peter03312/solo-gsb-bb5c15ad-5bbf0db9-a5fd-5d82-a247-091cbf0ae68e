'use strict';
// ============================================================================
// 前端：状态管理 + 画布渲染/拖拽 + 表单 CRUD
// ============================================================================

const $ = id => document.getElementById(id);

let state = null;          // /api/state 返回的完整状态
let lastRun = null;        // 最近一次优化结果（usedLength/complete/unplaced）
let scale = 0.3;           // 像素 / 毫米
let selected = null;       // {pieceId, index}
let drag = null;           // 拖拽状态
let editingPieceId = null;

const PIECE_COLORS = ['#93c5fd', '#86efac', '#fcd34d', '#f9a8d4', '#c4b5fd',
  '#fdba74', '#67e8f9', '#bef264', '#fda4af', '#a5b4fc'];

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败 (${res.status})`),
    { conflicts: data.conflicts || null, status: res.status });
  return data;
}

function applyState(next) {
  state = next;
  if (next.run) { lastRun = next.run; delete next.run; }
  // 若选中项已不存在则取消选中
  if (selected && !placementOf(selected.pieceId, selected.index)) selected = null;
  renderAll();
}

// ---------------------------------------------------------------------------
// 几何小工具（与后端同语义的前端版本，用于渲染与命中检测）
// ---------------------------------------------------------------------------
function bbox(poly) {
  let a = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of poly) {
    a[0] = Math.min(a[0], x); a[1] = Math.min(a[1], y);
    a[2] = Math.max(a[2], x); a[3] = Math.max(a[3], y);
  }
  return a;
}
function rotate180(poly) {
  const [x0, y0, x1, y1] = bbox(poly);
  return poly.map(([x, y]) => [x0 + x1 - x, y0 + y1 - y]);
}
function worldPoly(piece, pl) {
  const src = pl.orientation === 180 ? rotate180(piece.polygon) : piece.polygon;
  return src.map(([x, y]) => [x + pl.x, y + pl.y]);
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) &&
        p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pieceById(id) { return state.pieces.find(p => p.id === id); }
function placementOf(pieceId, index) {
  return state.placements.find(p => p.pieceId === pieceId && p.index === index);
}

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

function fitWidth() {
  const w = $('canvas-scroll').clientWidth - 24;
  scale = Math.max(0.02, Math.min(2, w / state.config.width));
  updateZoomLabel();
  renderCanvas();
}
function updateZoomLabel() { $('zoom-label').textContent = Math.round(scale * 100) + '%'; }

function mmToPx([x, y]) { return [x * scale, y * scale]; }

function renderCanvas() {
  if (!state || !state.config) return;
  const { width, length } = state.config;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.ceil(width * scale), ch = Math.ceil(length * scale);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = cw * dpr; canvas.height = ch * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  // 布底
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  // 100mm 网格
  ctx.strokeStyle = '#eef1f4'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = 100; gx < width; gx += 100) {
    ctx.moveTo(gx * scale, 0); ctx.lineTo(gx * scale, ch);
  }
  for (let gy = 100; gy < length; gy += 100) {
    ctx.moveTo(0, gy * scale); ctx.lineTo(cw, gy * scale);
  }
  ctx.stroke();
  // 布边
  ctx.strokeStyle = '#9aa3ad'; ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, cw, ch);

  // 瑕疵区（红色斜纹）
  for (const d of state.defects) {
    const x = d.x * scale, y = d.y * scale, w = d.w * scale, h = d.h * scale;
    ctx.fillStyle = 'rgba(220,38,38,.12)';
    ctx.fillRect(x, y, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = 'rgba(220,38,38,.55)'; ctx.lineWidth = 1;
    const step = 8;
    for (let t = -h; t < w + h; t += step) {
      ctx.beginPath(); ctx.moveTo(x + t, y + h); ctx.lineTo(x + t + h, y); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    if (w > 26 && h > 16) {
      ctx.fillStyle = '#b91c1c'; ctx.font = '11px sans-serif';
      ctx.fillText(`瑕疵 #${d.id}`, x + 4, y + 13);
    }
  }

  // 已放置裁片
  for (const pl of state.placements) {
    const piece = pieceById(pl.pieceId);
    if (!piece) continue;
    let poly = worldPoly(piece, pl);
    if (drag && drag.key === pl.pieceId + ':' + pl.index && drag.dx !== undefined) {
      poly = poly.map(([x, y]) => [x + drag.dx, y + drag.dy]);
    }
    const isSel = selected && selected.pieceId === pl.pieceId && selected.index === pl.index;
    const color = PIECE_COLORS[(pl.pieceId - 1) % PIECE_COLORS.length];

    ctx.beginPath();
    poly.forEach(([x, y], i) => {
      const [px, py] = mmToPx([x, y]);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = pl.locked ? 'rgba(252,211,77,.75)' : color + 'cc';
    ctx.fill();
    ctx.lineWidth = isSel ? 2.5 : 1.2;
    ctx.strokeStyle = pl.locked ? '#b45309' : (isSel ? '#1d4ed8' : '#374151');
    if (drag && drag.key === pl.pieceId + ':' + pl.index) {
      ctx.setLineDash([6, 4]); ctx.strokeStyle = '#1d4ed8';
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 标签
    const b = bbox(poly);
    const cx = (b[0] + b[2]) / 2 * scale, cy = (b[1] + b[3]) / 2 * scale;
    const label = `${piece.name} #${pl.index}${pl.orientation === 180 ? ' ⟲' : ''}${pl.locked ? ' 🔒' : ''}`;
    ctx.font = `${pl.locked ? 'bold ' : ''}${Math.max(10, Math.min(15, scale * 40))}px sans-serif`;
    if (ctx.measureText(label).width < (b[2] - b[0]) * scale - 6) {
      ctx.fillStyle = '#111827'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy);
    }
  }

  // 实际占用长度线
  const used = currentUsedLength();
  if (used > 0) {
    const y = used * scale;
    ctx.strokeStyle = '#10b981'; ctx.lineWidth = 1.5; ctx.setLineDash([10, 6]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#047857'; ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`实际占用长度 ${used} mm`, 8, Math.max(14, y - 6));
  }
}

/** 已放置裁片包围盒的最大 y（拖拽中计入预览偏移） */
function currentUsedLength() {
  let m = 0;
  for (const pl of state.placements) {
    const piece = pieceById(pl.pieceId);
    if (!piece) continue;
    let b = bbox(worldPoly(piece, pl));
    if (drag && drag.key === pl.pieceId + ':' + pl.index) b[3] += drag.dy || 0;
    m = Math.max(m, b[3]);
  }
  return m;
}

// ---------------------------------------------------------------------------
// 画布交互：点选 / 拖拽
// ---------------------------------------------------------------------------
function eventToMm(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
}

function hitTest(p) {
  // 后绘制的在上层，倒序命中
  for (let i = state.placements.length - 1; i >= 0; i--) {
    const pl = state.placements[i];
    const piece = pieceById(pl.pieceId);
    if (!piece) continue;
    let poly = worldPoly(piece, pl);
    if (pointInPoly(p, poly)) return { pieceId: pl.pieceId, index: pl.index, locked: pl.locked };
  }
  return null;
}

canvas.addEventListener('mousedown', e => {
  const p = eventToMm(e);
  const hit = hitTest(p);
  if (!hit) { selected = null; updateSelectionBar(); renderCanvas(); return; }
  selected = { pieceId: hit.pieceId, index: hit.index };
  updateSelectionBar();
  renderCanvas();
  if (hit.locked) return;
  const pl = placementOf(hit.pieceId, hit.index);
  drag = {
    key: hit.pieceId + ':' + hit.index,
    pieceId: hit.pieceId, index: hit.index,
    startX: e.clientX, startY: e.clientY,
    origX: pl.x, origY: pl.y, dx: 0, dy: 0, moved: false,
  };
  canvas.classList.add('dragging');
});

window.addEventListener('mousemove', e => {
  if (!drag) {
    // hover 光标
    if (state) {
      const hit = hitTest(eventToMm(e));
      canvas.classList.toggle('hover', !!hit);
    }
    return;
  }
  drag.dx = Math.round((e.clientX - drag.startX) / scale);
  drag.dy = Math.round((e.clientY - drag.startY) / scale);
  if (drag.dx !== 0 || drag.dy !== 0) drag.moved = true;
  renderCanvas();
});

window.addEventListener('mouseup', async () => {
  if (!drag) return;
  const d = drag; drag = null;
  canvas.classList.remove('dragging');
  if (d.moved && (d.dx !== 0 || d.dy !== 0)) {
    const nx = d.origX + d.dx, ny = d.origY + d.dy;
    try {
      const next = await api('POST', '/api/placements/move',
        { pieceId: d.pieceId, index: d.index, x: nx, y: ny });
      applyState(next);
      showOk(`已移动到 (${nx}, ${ny})`);
    } catch (err) {
      applyState(await api('GET', '/api/state')); // 恢复原方案
      showConflicts(err.message, err.conflicts);
    }
  }
  renderCanvas();
});

$('btn-zoom-in').onclick = () => { scale = Math.min(2, scale * 1.2); updateZoomLabel(); renderCanvas(); };
$('btn-zoom-out').onclick = () => { scale = Math.max(0.02, scale / 1.2); updateZoomLabel(); renderCanvas(); };
$('btn-fit').onclick = fitWidth;

// ---------------------------------------------------------------------------
// 选中条
// ---------------------------------------------------------------------------
function updateSelectionBar() {
  const bar = $('selection-bar');
  if (!selected) { bar.hidden = true; return; }
  const pl = placementOf(selected.pieceId, selected.index);
  const piece = pieceById(selected.pieceId);
  if (!pl || !piece) { bar.hidden = true; return; }
  bar.hidden = false;
  $('sel-desc').textContent = `${piece.name} #${pl.index}（${pl.orientation === 180 ? '旋转 180°' : '原方向'}${pl.locked ? '，已锁定' : ''}）`;
  $('sel-x').value = pl.x; $('sel-y').value = pl.y;
  const rotBtn = $('btn-rotate');
  rotBtn.hidden = !piece.rotatable || pl.locked;
  const lockBtn = $('btn-lock');
  lockBtn.textContent = pl.locked ? '🔓 解锁' : '🔒 锁定';
  $('sel-x').disabled = pl.locked;
  $('sel-y').disabled = pl.locked;
  $('btn-move-apply').disabled = pl.locked;
  $('btn-move-apply').title = pl.locked ? '已锁定，移动前请先解锁' : '';
}

$('btn-lock').onclick = async () => {
  if (!selected) return;
  const pl = placementOf(selected.pieceId, selected.index);
  const next = await api('POST', '/api/placements/lock',
    { pieceId: selected.pieceId, index: selected.index, locked: !pl.locked });
  applyState(next);
  showOk(pl.locked ? '已解锁' : '已锁定，重新优化时该裁片保持不动');
};

$('btn-rotate').onclick = async () => {
  if (!selected) return;
  const pl = placementOf(selected.pieceId, selected.index);
  const orient = pl.orientation === 180 ? 0 : 180;
  try {
    const next = await api('POST', '/api/placements/move',
      { pieceId: selected.pieceId, index: selected.index, x: pl.x, y: pl.y, orientation: orient });
    applyState(next);
    showOk(orient === 180 ? '已旋转 180°' : '已恢复原方向');
  } catch (err) { showConflicts(err.message, err.conflicts); }
};

$('btn-move-apply').onclick = async () => {
  if (!selected) return;
  const x = parseInt($('sel-x').value, 10), y = parseInt($('sel-y').value, 10);
  if (!Number.isInteger(x) || !Number.isInteger(y)) { showError('坐标必须为整数毫米'); return; }
  try {
    const next = await api('POST', '/api/placements/move',
      { pieceId: selected.pieceId, index: selected.index, x, y });
    applyState(next);
    showOk(`已移动到 (${x}, ${y})`);
  } catch (err) { showConflicts(err.message, err.conflicts); }
};

// ---------------------------------------------------------------------------
// 左侧表单
// ---------------------------------------------------------------------------
function renderLists() {
  // 瑕疵
  const dl = $('defect-list');
  dl.innerHTML = '';
  for (const d of state.defects) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="row1">
        <span class="name">瑕疵 #${d.id}</span>
        <span class="ops"><button class="danger" data-id="${d.id}">删除</button></span>
      </div>
      <span class="meta">(${d.x}, ${d.y})　${d.w} × ${d.h} mm</span>`;
    li.querySelector('button').onclick = async () => {
      try { applyState(await api('DELETE', `/api/defects/${d.id}`)); showOk('已删除瑕疵区'); }
      catch (err) { showConflicts(err.message, err.conflicts); }
    };
    dl.appendChild(li);
  }

  // 裁片
  const pl = $('piece-list');
  pl.innerHTML = '';
  const placedByPiece = new Map();
  for (const p of state.placements) {
    if (!placedByPiece.has(p.pieceId)) placedByPiece.set(p.pieceId, []);
    placedByPiece.get(p.pieceId).push(p);
  }
  for (const p of state.pieces) {
    const li = document.createElement('li');
    const b = bbox(p.polygon);
    const placed = (placedByPiece.get(p.id) || []).length;
    const lockedN = (placedByPiece.get(p.id) || []).filter(x => x.locked).length;
    li.innerHTML = `<div class="row1">
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="ops">
          <button data-act="edit" data-id="${p.id}">编辑</button>
          <button class="danger" data-act="del" data-id="${p.id}">删除</button>
        </span>
      </div>
      <span class="meta">
        件数 ${p.quantity}（已排 ${placed}${lockedN ? `，锁定 ${lockedN}` : ''}）
        · 外框 ${b[2] - b[0]} × ${b[3] - b[1]} mm
        <span class="badge ${p.rotatable ? 'yes' : 'no'}">${p.rotatable ? '可旋转180°' : '禁旋转'}</span>
      </span>`;
    li.querySelector('[data-act="edit"]').onclick = () => openPieceEditor(p);
    li.querySelector('[data-act="del"]').onclick = async () => {
      try { applyState(await api('DELETE', `/api/pieces/${p.id}`)); showOk('已删除裁片'); }
      catch (err) { showConflicts(err.message, err.conflicts); }
    };
    pl.appendChild(li);
  }

  $('cfg-width').value = state.config.width;
  $('cfg-length').value = state.config.length;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 布料参数
$('btn-cfg-save').onclick = async () => {
  const width = parseInt($('cfg-width').value, 10);
  const length = parseInt($('cfg-length').value, 10);
  try {
    applyState(await api('PUT', '/api/config', { width, length }));
    showOk('布料参数已保存');
  } catch (err) { showConflicts(err.message, err.conflicts); }
};

// 添加瑕疵
$('btn-def-add').onclick = async () => {
  const body = {
    x: parseInt($('def-x').value, 10), y: parseInt($('def-y').value, 10),
    w: parseInt($('def-w').value, 10), h: parseInt($('def-h').value, 10),
  };
  try { applyState(await api('POST', '/api/defects', body)); showOk('瑕疵区已添加'); }
  catch (err) { showConflicts(err.message, err.conflicts); }
};

// 裁片编辑
function polygonToText(poly) { return poly.map(p => p.join(',')).join('\n'); }
function textToPolygon(text) {
  return text.trim().split(/\r?\n/).map(line => {
    const parts = line.split(/[,\s]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1]];
  });
}
function openPieceEditor(p) {
  const ed = $('piece-editor');
  ed.open = true;
  editingPieceId = p ? p.id : null;
  $('piece-editor-title').textContent = p ? '✎ 编辑裁片' : '+ 添加裁片';
  $('pc-name').value = p ? p.name : '';
  $('pc-polygon').value = p ? polygonToText(p.polygon) : '0,0\n600,0\n600,800\n0,800';
  $('pc-qty').value = p ? p.quantity : 1;
  $('pc-rot').checked = p ? p.rotatable : false;
  $('btn-pc-cancel').hidden = !p;
}
$('btn-pc-cancel').onclick = () => { $('piece-editor').open = false; editingPieceId = null; };

$('btn-pc-save').onclick = async () => {
  const body = {
    name: $('pc-name').value,
    polygon: textToPolygon($('pc-polygon').value),
    quantity: parseInt($('pc-qty').value, 10),
    rotatable: $('pc-rot').checked,
  };
  try {
    let next;
    if (editingPieceId) next = await api('PUT', `/api/pieces/${editingPieceId}`, body);
    else next = await api('POST', '/api/pieces', body);
    applyState(next);
    $('piece-editor').open = false; editingPieceId = null;
    showOk('裁片已保存');
  } catch (err) { showConflicts(err.message, err.conflicts); }
};

// 重新优化
$('btn-optimize').onclick = async () => {
  $('btn-optimize').disabled = true;
  try {
    const next = await api('POST', '/api/optimize');
    lastRun = next.run;
    delete next.run;
    applyState(next);
    if (lastRun.complete) {
      showOk(`排样完成：全部裁片已排入，实际占用长度 ${lastRun.usedLength} mm`);
    } else {
      // 部分结果绝不能标为完成方案
      showUnplaced(lastRun);
    }
  } catch (err) { showConflicts(err.message, err.conflicts); }
  finally { $('btn-optimize').disabled = false; }
};

// ---------------------------------------------------------------------------
// 消息与状态栏
// ---------------------------------------------------------------------------
function showMsg(title, items, kind) {
  const box = $('msg-box');
  box.hidden = false;
  box.className = kind;
  const list = items && items.length
    ? `<ul>${items.map(c => `<li><b>${escapeHtml(c.object || '')}</b>：${escapeHtml(c.reason || '')}</li>`).join('')}</ul>`
    : '';
  box.innerHTML = `<div class="msg-title">${escapeHtml(title)}</div>${list}`;
  setTimeout(() => { if (kind === 'ok') box.hidden = true; }, 4000);
}
const showOk = msg => showMsg('✓ ' + msg, null, 'ok');
const showError = msg => showMsg('✗ ' + msg, null, 'err');
const showConflicts = (msg, conflicts) =>
  showMsg('✗ ' + msg + '（现有方案保持不变）', conflicts, 'err');
function showUnplaced(run) {
  const items = run.unplaced.map(u => ({ object: `${u.name} #${u.index}`, reason: u.reason }));
  showMsg(`✗ 方案未完成：${run.unplaced.length} 件裁片未能排入（当前为部分结果，非完成方案），已排入部分实际占用长度 ${run.usedLength} mm`,
    items, 'err');
}

function renderStatus() {
  if (!state || !state.config) return;
  const t = $('status-text');
  const used = currentUsedLength();
  const unplaced = lastRun ? lastRun.unplaced.length : null;
  t.innerHTML = `布幅 ${state.config.width} × ${state.config.length} mm ｜ 已放置 ${state.placements.length} 件`;
  const sl = $('status-length');
  if (lastRun) {
    if (lastRun.complete) {
      sl.style.color = '#059669';
      sl.textContent = `✓ 完成方案 · 实际占用长度 ${lastRun.usedLength} mm`;
    } else {
      sl.style.color = '#dc2626';
      sl.textContent = `✗ 未完成 · ${lastRun.unplaced.length} 件未排入 · 当前占用 ${used} mm`;
    }
  } else {
    sl.style.color = '#6b7280';
    sl.textContent = used ? `当前占用长度 ${used} mm（尚未运行优化）` : '';
  }
}

function renderAll() {
  renderLists();
  renderStatus();
  updateSelectionBar();
  renderCanvas();
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
(async function init() {
  try {
    const s = await api('GET', '/api/state');
    state = s;
    if (s.lastRun) lastRun = s.lastRun;
    renderAll();
    fitWidth();
  } catch (err) {
    $('status-text').textContent = '加载失败：' + err.message;
  }
})();

window.addEventListener('resize', () => renderCanvas());
