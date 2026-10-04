'use strict';

/* ================= 状态与工具 ================= */

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');
const PAD = 36; // 画布留白 px

let state = null;        // 当前方案完整状态（GET /api/jobs/:id 返回）
let scale = 0.25;        // px / mm
let selectedId = null;   // 选中的 placement id
let drag = null;         // 拖拽状态
let defectRows = [];     // 新建表单：瑕疵区行
let pieceRows = [];      // 新建表单：裁片卡片

const PALETTE = [
  '#f4a261', '#2a9d8f', '#e9c46a', '#8ab17d', '#577590',
  '#9d4edd', '#ef476f', '#118ab2', '#06d6a0', '#ffb703',
  '#6d597a', '#43aa8b',
];

function typeColor(pieceTypeId) {
  const idx = state ? state.pieceTypes.findIndex((t) => t.id === pieceTypeId) : 0;
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.data = data;
    throw err;
  }
  return data;
}

function showMsg(text, isError) {
  const el = $('msg');
  el.textContent = text;
  el.className = isError ? 'error' : 'info';
  if (!text) el.className = '';
}

function showApiError(err, prefix) {
  let text = (prefix ? prefix + '：' : '') + err.message;
  if (err.data && Array.isArray(err.data.details) && err.data.details.length) {
    text += '\n' + err.data.details.map((d) => '· ' + d).join('\n');
  }
  if (err.data && Array.isArray(err.data.conflicts) && err.data.conflicts.length) {
    text += '\n冲突对象：' + err.data.conflicts.join('、');
  }
  showMsg(text, true);
}

/* ================= 方案列表 ================= */

async function refreshJobList(selectId) {
  const jobs = await api('GET', '/api/jobs');
  const sel = $('jobSelect');
  sel.innerHTML = '<option value="">（请选择方案）</option>';
  for (const j of jobs) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `#${j.id} ${j.name}（${j.fabricWidth}×${j.fabricLength}mm，${j.pieceCount}件）`;
    sel.appendChild(opt);
  }
  if (selectId) sel.value = String(selectId);
}

async function openJob(id) {
  state = await api('GET', `/api/jobs/${id}`);
  selectedId = null;
  showMsg('', false);
  fitScale();
  renderAll();
}

/* ================= 渲染 ================= */

function fitScale() {
  if (!state) return;
  const wrap = $('canvasWrap');
  const s = (wrap.clientWidth - PAD * 2 - 20) / state.job.fabricWidth;
  scale = Math.min(s, 30000 / state.job.fabricLength, 4);
  scale = Math.max(scale, 0.005);
}

function renderAll() {
  renderToolbar();
  renderUnplaced();
  renderSelPanel();
  setupCanvas();
  draw();
}

function renderToolbar() {
  const btn = $('btnOptimize');
  const badge = $('statusBadge');
  const used = $('usedLen');
  if (!state) {
    btn.disabled = true;
    badge.textContent = '未加载方案';
    badge.className = 'badge';
    used.textContent = '';
    return;
  }
  btn.disabled = false;
  const st = state.job.status;
  const nUn = state.unplaced.length;
  if (st === 'complete') {
    badge.textContent = '完整方案 ✓（全部裁片已排入）';
    badge.className = 'badge complete';
  } else if (st === 'partial') {
    badge.textContent = `部分方案（${nUn} 件未排入，非完成方案）`;
    badge.className = 'badge partial';
  } else {
    badge.textContent = '草稿（尚未优化）';
    badge.className = 'badge draft';
  }
  used.textContent = `实际占用长度：${state.job.usedLength} mm`;
}

function renderUnplaced() {
  const el = $('unplacedPanel');
  if (!state || state.unplaced.length === 0) {
    el.className = '';
    el.innerHTML = '';
    return;
  }
  el.className = 'show';
  el.innerHTML = `<b>未排入裁片（${state.unplaced.length} 件）：</b>`;
  for (const u of state.unplaced) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (u.id === selectedId ? ' sel' : '');
    chip.textContent = `${u.name}#${u.seq}`;
    chip.onclick = () => {
      selectedId = u.id;
      renderAll();
    };
    el.appendChild(chip);
  }
  const tip = document.createElement('div');
  tip.className = 'hint';
  tip.textContent = '点击裁片可在左侧输入坐标手动排入，或调整布幅/锁定件后重新优化。';
  el.appendChild(tip);
}

function findPlacement(id) {
  return state ? state.placements.find((p) => p.id === id) : null;
}

function renderSelPanel() {
  const panel = $('selPanel');
  const p = findPlacement(selectedId);
  if (!p) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  $('selInfo').innerHTML =
    `<b>${p.name}#${p.seq}</b>　外接 ${p.bw}×${p.bh}mm　` +
    (p.placed ? `当前 (${p.x}, ${p.y}) ${p.rotation}°` : '<span style="color:#ef6c00">未排入</span>') +
    (p.locked ? '　🔒已锁定' : '');
  $('selX').value = p.placed ? p.x : 0;
  $('selY').value = p.placed ? p.y : 0;
  $('selRot').value = String(p.rotation);
  $('selRot').querySelector('option[value="180"]').disabled = !p.allowRotate;
  $('selLocked').checked = p.locked;
  $('selLocked').disabled = !p.placed;
}

/* ================= 画布 ================= */

function absVertsOf(p) {
  const t = state.pieceTypes.find((t) => t.id === p.pieceTypeId);
  const vs = t.vertices;
  if (p.rotation === 180) return vs.map(([x, y]) => [p.x + t.bw - x, p.y + t.bh - y]);
  return vs.map(([x, y]) => [p.x + x, p.y + y]);
}

function setupCanvas() {
  if (!state) {
    cv.width = 10;
    cv.height = 10;
    return;
  }
  const cssW = state.job.fabricWidth * scale + PAD * 2;
  const cssH = state.job.fabricLength * scale + PAD * 2;
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function mmX(x) { return PAD + x * scale; }
function mmY(y) { return PAD + y * scale; }

function draw() {
  if (!state) return;
  const W = state.job.fabricWidth;
  const L = state.job.fabricLength;
  const cssW = W * scale + PAD * 2;
  const cssH = L * scale + PAD * 2;
  ctx.clearRect(0, 0, cssW, cssH);

  // 布幅底
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(mmX(0), mmY(0), W * scale, L * scale);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mmX(0), mmY(0), W * scale, L * scale);

  // 网格与标尺
  const step = scale * 100 >= 8 ? 100 : scale * 500 >= 8 ? 500 : 1000;
  ctx.strokeStyle = '#eee';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < W; x += step) { ctx.moveTo(mmX(x), mmY(0)); ctx.lineTo(mmX(x), mmY(L)); }
  for (let y = step; y < L; y += step) { ctx.moveTo(mmX(0), mmY(y)); ctx.lineTo(mmX(W), mmY(y)); }
  ctx.stroke();
  if (scale * 500 >= 24) {
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    for (let y = 0; y <= L; y += 500) ctx.fillText(String(y), mmX(0) - 4, mmY(y) + 3);
    ctx.textAlign = 'left';
    for (let x = 0; x <= W; x += 500) ctx.fillText(String(x), mmX(x) + 2, mmY(0) - 4);
  }

  // 瑕疵区
  for (const d of state.defects) {
    ctx.fillStyle = 'rgba(229,57,53,0.30)';
    ctx.fillRect(mmX(d.x), mmY(d.y), d.w * scale, d.h * scale);
    ctx.strokeStyle = '#c62828';
    ctx.lineWidth = 1;
    ctx.strokeRect(mmX(d.x), mmY(d.y), d.w * scale, d.h * scale);
    if (d.w * scale > 34 && d.h * scale > 12) {
      ctx.fillStyle = '#b71c1c';
      ctx.font = '10px sans-serif';
      ctx.fillText('瑕疵', mmX(d.x) + 3, mmY(d.y) + 11);
    }
  }

  // 裁片
  for (const p of state.placements) {
    if (!p.placed) continue;
    const isDrag = drag && drag.pid === p.id && drag.moved;
    const px = isDrag ? drag.curX : p.x;
    const py = isDrag ? drag.curY : p.y;
    const t = state.pieceTypes.find((t) => t.id === p.pieceTypeId);
    const vs = t.vertices.map(([x, y]) =>
      p.rotation === 180 ? [px + t.bw - x, py + t.bh - y] : [px + x, py + y]
    );
    ctx.beginPath();
    vs.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(mmX(x), mmY(y)) : ctx.lineTo(mmX(x), mmY(y))));
    ctx.closePath();
    ctx.fillStyle = typeColor(p.pieceTypeId) + (isDrag ? '99' : 'cc');
    ctx.fill();
    ctx.lineWidth = p.id === selectedId ? 2.5 : 1;
    ctx.strokeStyle = p.id === selectedId ? '#0d47a1' : '#444';
    if (isDrag) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 标签
    const cx = vs.reduce((s, v) => s + v[0], 0) / vs.length;
    const cy = vs.reduce((s, v) => s + v[1], 0) / vs.length;
    if (p.bw * scale > 44 && p.bh * scale > 13) {
      ctx.fillStyle = '#1a1a1a';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${p.name}#${p.seq}${p.rotation === 180 ? ' ⟲180°' : ''}`, mmX(cx), mmY(cy) + 4);
      ctx.textAlign = 'left';
    }
    if (p.locked) {
      ctx.font = '11px sans-serif';
      ctx.fillText('🔒', mmX(cx) - 6, mmY(cy) - 6);
    }
  }

  // 实际占用长度线
  if (state.job.usedLength > 0) {
    ctx.strokeStyle = '#2e7d32';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(mmX(0), mmY(state.job.usedLength));
    ctx.lineTo(mmX(W), mmY(state.job.usedLength));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#2e7d32';
    ctx.font = '11px sans-serif';
    ctx.fillText(`占用长度 ${state.job.usedLength}mm`, mmX(4), mmY(state.job.usedLength) - 4);
  }
}

/* ================= 画布交互 ================= */

function toMm(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left - PAD) / scale, (e.clientY - r.top - PAD) / scale];
}

function pointInPoly(px, py, vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const [xi, yi] = vs[i];
    const [xj, yj] = vs[j];
    if (yi > py !== yj > py && px < xi + ((py - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

cv.addEventListener('mousedown', (e) => {
  if (!state || e.button !== 0) return;
  const [mx, my] = toMm(e);
  // 从最上层开始命中检测
  const placed = state.placements.filter((p) => p.placed);
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    const t = state.pieceTypes.find((t) => t.id === p.pieceTypeId);
    if (mx < p.x || mx > p.x + t.bw || my < p.y || my > p.y + t.bh) continue;
    if (!pointInPoly(mx, my, absVertsOf(p))) continue;
    selectedId = p.id;
    drag = {
      pid: p.id,
      locked: p.locked,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: mx - p.x,
      grabDY: my - p.y,
      curX: p.x,
      curY: p.y,
      moved: false,
    };
    renderSelPanel();
    draw();
    return;
  }
  selectedId = null;
  renderSelPanel();
  draw();
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return;
  if (drag.locked) return; // 锁定件不可拖动
  drag.moved = true;
  const [mx, my] = toMm(e);
  drag.curX = Math.round(mx - drag.grabDX);
  drag.curY = Math.round(my - drag.grabDY);
  draw();
});

window.addEventListener('mouseup', async () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) { draw(); return; } // 视为点击选择
  if (d.locked) {
    showMsg('该裁片已锁定，请先在左侧面板解锁再移动。', true);
    draw();
    return;
  }
  const p = findPlacement(d.pid);
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${d.pid}/move`, {
      x: d.curX, y: d.curY, rotation: p.rotation,
    });
    showMsg('移动成功。', false);
    renderAll();
  } catch (err) {
    showApiError(err, '移动被拒绝，已保留原方案');
    renderAll(); // 服务端未改动，重绘回原位置
  }
});

/* ================= 工具栏与面板事件 ================= */

$('btnOptimize').onclick = async () => {
  if (!state) return;
  showMsg('正在优化排样……', false);
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/optimize`);
    const n = state.unplaced.length;
    showMsg(
      n === 0
        ? `优化完成：全部裁片已排入，实际占用长度 ${state.job.usedLength}mm。`
        : `优化结束：${n} 件无法排入（见下方列表），当前为部分方案，占用长度 ${state.job.usedLength}mm。`,
      n !== 0
    );
    renderAll();
  } catch (err) {
    showApiError(err, '优化失败');
    renderAll();
  }
};

$('btnZoomIn').onclick = () => { scale = Math.min(scale * 1.25, 4, 30000 / (state ? state.job.fabricLength : 1)); setupCanvas(); draw(); };
$('btnZoomOut').onclick = () => { scale = Math.max(scale / 1.25, 0.005); setupCanvas(); draw(); };

$('btnApplyMove').onclick = async () => {
  const p = findPlacement(selectedId);
  if (!p) return;
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${p.id}/move`, {
      x: Number($('selX').value),
      y: Number($('selY').value),
      rotation: Number($('selRot').value),
    });
    showMsg('位置已应用。', false);
    renderAll();
  } catch (err) {
    showApiError(err, '操作被拒绝，已保留原方案');
    renderAll();
  }
};

$('selLocked').onchange = async () => {
  const p = findPlacement(selectedId);
  if (!p) return;
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${p.id}/lock`, {
      locked: $('selLocked').checked,
    });
    showMsg($('selLocked').checked ? '已锁定（优化时保持固定）。' : '已解锁。', false);
    renderAll();
  } catch (err) {
    showApiError(err, '锁定操作失败');
    renderAll();
  }
};

$('btnUnplace').onclick = async () => {
  const p = findPlacement(selectedId);
  if (!p || !p.placed) return;
  try {
    state = await api('POST', `/api/jobs/${state.job.id}/placements/${p.id}/unplace`);
    showMsg(`裁片「${p.name}#${p.seq}」已移回未排区。`, false);
    renderAll();
  } catch (err) {
    showApiError(err, '操作失败');
    renderAll();
  }
};

$('jobSelect').onchange = () => {
  const id = $('jobSelect').value;
  if (id) openJob(id).catch((err) => showApiError(err, '打开方案失败'));
};

$('btnDeleteJob').onclick = async () => {
  const id = $('jobSelect').value;
  if (!id) return;
  if (!window.confirm('确定删除该方案？此操作不可恢复。')) return;
  await api('DELETE', `/api/jobs/${id}`);
  state = null;
  selectedId = null;
  await refreshJobList();
  renderAll();
  setupCanvas();
  showMsg('方案已删除。', false);
};

/* ================= 新建方案表单 ================= */

function addDefectRow(d) {
  const row = document.createElement('div');
  row.className = 'defect-row';
  row.innerHTML =
    '<span class="lbl">x</span><input type="number" step="1">' +
    '<span class="lbl">y</span><input type="number" step="1">' +
    '<span class="lbl">宽</span><input type="number" step="1">' +
    '<span class="lbl">高</span><input type="number" step="1">' +
    '<button class="mini">删</button>';
  const inputs = row.querySelectorAll('input');
  const data = d || { x: 0, y: 0, w: 100, h: 100 };
  inputs[0].value = data.x; inputs[1].value = data.y;
  inputs[2].value = data.w; inputs[3].value = data.h;
  row.querySelector('button').onclick = () => {
    defectRows = defectRows.filter((r) => r.el !== row);
    row.remove();
  };
  $('defectList').appendChild(row);
  defectRows.push({ el: row, inputs });
}

function addPieceCard(p) {
  const card = document.createElement('div');
  card.className = 'piece-card';
  card.innerHTML =
    '<input type="text" placeholder="裁片名称，如：前片">' +
    '<textarea placeholder="顶点坐标，每行一个：x,y（整数mm）&#10;0,0&#10;600,0&#10;600,900&#10;0,900"></textarea>' +
    '<div class="sub">' +
    '<label>件数 <input type="number" min="1" step="1" value="1"></label>' +
    '<label><input type="checkbox"> 允许旋转180°</label>' +
    '<button class="mini">删</button>' +
    '</div>';
  const [nameInput] = [card.querySelector('input[type=text]')];
  const ta = card.querySelector('textarea');
  const qty = card.querySelector('input[type=number]');
  const rot = card.querySelector('input[type=checkbox]');
  if (p) {
    nameInput.value = p.name;
    ta.value = p.verts;
    qty.value = p.qty;
    rot.checked = p.rot;
  }
  card.querySelector('button').onclick = () => {
    pieceRows = pieceRows.filter((r) => r.el !== card);
    card.remove();
  };
  $('pieceList').appendChild(card);
  pieceRows.push({ el: card, nameInput, ta, qty, rot });
}

function parseVertices(text) {
  const pts = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    const parts = s.split(/[,\s，、]+/).filter(Boolean);
    if (parts.length !== 2) throw new Error(`顶点第 ${i + 1} 行格式错误：${s}`);
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`顶点第 ${i + 1} 行坐标必须为整数：${s}`);
    }
    pts.push([x, y]);
  }
  return pts;
}

$('btnAddDefect').onclick = () => addDefectRow();
$('btnAddPiece').onclick = () => addPieceCard();

$('btnSample').onclick = () => {
  $('fName').value = '示例方案';
  $('fWidth').value = 1600;
  $('fLength').value = 5000;
  defectRows.forEach((r) => r.el.remove()); defectRows = [];
  pieceRows.forEach((r) => r.el.remove()); pieceRows = [];
  addDefectRow({ x: 1150, y: 300, w: 200, h: 250 });
  addPieceCard({ name: '前片', verts: '0,0\n620,0\n620,950\n0,950', qty: 2, rot: true });
  addPieceCard({ name: '袖片', verts: '0,0\n360,0\n360,560\n180,460\n0,560', qty: 2, rot: true });
  addPieceCard({ name: '领片', verts: '0,0\n320,0\n160,130', qty: 3, rot: false });
};

$('btnCreate').onclick = async () => {
  let pieces;
  try {
    pieces = pieceRows.map((r, i) => ({
      name: r.nameInput.value.trim() || `裁片${i + 1}`,
      vertices: parseVertices(r.ta.value),
      quantity: Number(r.qty.value),
      allowRotate: r.rot.checked,
    }));
  } catch (err) {
    showMsg('裁片顶点解析失败：' + err.message, true);
    return;
  }
  const body = {
    name: $('fName').value.trim(),
    fabricWidth: Number($('fWidth').value),
    fabricLength: Number($('fLength').value),
    defects: defectRows.map((r) => ({
      x: Number(r.inputs[0].value), y: Number(r.inputs[1].value),
      w: Number(r.inputs[2].value), h: Number(r.inputs[3].value),
    })),
    pieces,
  };
  try {
    state = await api('POST', '/api/jobs', body);
    selectedId = null;
    await refreshJobList(state.job.id);
    fitScale();
    renderAll();
    showMsg(`方案 #${state.job.id} 创建成功，请点击「优化排样」。`, false);
  } catch (err) {
    showApiError(err, '创建失败');
  }
};

/* ================= 启动 ================= */

(async function init() {
  addDefectRow();
  addPieceCard();
  await refreshJobList();
})();
