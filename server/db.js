'use strict';
// ============================================================================
// SQLite 数据访问层。首次启动自动建表并写入一份示例数据。
// ============================================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'marker.db');

let db;

// 预编译语句（在 open() 后初始化）
let stmts = {};

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema();
  seedIfEmpty();
  prepareStatements();
  return db;
}

function prepareStatements() {
  stmts = {
    setConfig: db.prepare(
      `INSERT INTO config (id, width, length) VALUES (1, @width, @length)
       ON CONFLICT(id) DO UPDATE SET width=@width, length=@length, updated_at=datetime('now')`),
    insDefect: db.prepare('INSERT INTO defects (x, y, w, h) VALUES (?, ?, ?, ?)'),
    delDefect: db.prepare('DELETE FROM defects WHERE id = ?'),
    insPiece: db.prepare(
      'INSERT INTO pieces (name, polygon, quantity, rotatable) VALUES (?, ?, ?, ?)'),
    updPiece: db.prepare(
      'UPDATE pieces SET name=@name, polygon=@polygon, quantity=@quantity, rotatable=@rotatable WHERE id=@id'),
    delPiece: db.prepare('DELETE FROM pieces WHERE id = ?'),
    delUnlockedPlacements: db.prepare('DELETE FROM placements WHERE locked = 0'),
    insPlacement: db.prepare(
      `INSERT INTO placements (piece_id, idx, x, y, orientation, locked)
       VALUES (@pieceId, @index, @x, @y, @orientation, @locked)
       ON CONFLICT(piece_id, idx) DO UPDATE SET x=@x, y=@y, orientation=@orientation, locked=@locked`),
    getPlacement: db.prepare('SELECT id FROM placements WHERE piece_id=? AND idx=?'),
    updPlacement: db.prepare(
      'UPDATE placements SET x=?, y=?, orientation=?, locked=? WHERE piece_id=? AND idx=?'),
    insPlacementRow: db.prepare(
      'INSERT INTO placements (piece_id, idx, x, y, orientation, locked) VALUES (?, ?, ?, ?, ?, ?)'),
    delPlacement: db.prepare('DELETE FROM placements WHERE piece_id=? AND idx=?'),
    insRun: db.prepare('INSERT INTO runs (used_length, complete, unplaced) VALUES (?, ?, ?)'),
  };
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      width INTEGER NOT NULL,
      length INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS defects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      w INTEGER NOT NULL,
      h INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pieces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      polygon TEXT NOT NULL,        -- JSON: [[x,y],...]
      quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 999),
      rotatable INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS placements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,         -- 同款式的第几件（从 1 开始）
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      orientation INTEGER NOT NULL CHECK (orientation IN (0,180)),
      locked INTEGER NOT NULL DEFAULT 0,
      UNIQUE (piece_id, idx)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_length INTEGER,
      complete INTEGER NOT NULL,
      unplaced TEXT NOT NULL        -- JSON: [{pieceId,index,name,reason}]
    );
  `);
}

function seedIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM config').get();
  if (row.c > 0) return;

  const insCfg = db.prepare('INSERT INTO config (id, width, length) VALUES (1, ?, ?)');
  insCfg.run(1500, 8000);

  const insDef = db.prepare('INSERT INTO defects (x, y, w, h) VALUES (?, ?, ?, ?)');
  insDef.run(300, 1200, 250, 180);

  const insPiece = db.prepare(
    'INSERT INTO pieces (name, polygon, quantity, rotatable) VALUES (?, ?, ?, ?)');
  // 前片（矩形，可旋转 180°）
  insPiece.run('前片', JSON.stringify([[0, 0], [600, 0], [600, 800], [0, 800]]), 4, 1);
  // 口袋（小矩形，可旋转 180°）
  insPiece.run('口袋', JSON.stringify([[0, 0], [180, 0], [180, 150], [0, 150]]), 6, 1);
  // 袖片（L 形凹多边形，禁止旋转）
  insPiece.run('袖片', JSON.stringify([[0, 0], [450, 0], [450, 220], [180, 220], [180, 700], [0, 700]]), 3, 0);
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

function getState() {
  const config = db.prepare('SELECT width, length FROM config WHERE id = 1').get();
  const defects = db.prepare('SELECT id, x, y, w, h FROM defects ORDER BY id').all();
  const pieces = db.prepare('SELECT id, name, polygon, quantity, rotatable FROM pieces ORDER BY id').all()
    .map(p => ({
      id: p.id, name: p.name, quantity: p.quantity, rotatable: !!p.rotatable,
      polygon: JSON.parse(p.polygon),
    }));
  const placements = db.prepare(
    'SELECT piece_id, idx, x, y, orientation, locked FROM placements ORDER BY piece_id, idx'
  ).all().map(r => ({
    pieceId: r.piece_id, index: r.idx, x: r.x, y: r.y,
    orientation: r.orientation, locked: !!r.locked,
  }));
  const lastRun = db.prepare('SELECT used_length, complete, unplaced FROM runs ORDER BY id DESC LIMIT 1').get();
  return {
    config: config ? { width: config.width, length: config.length } : null,
    defects,
    pieces,
    placements,
    lastRun: lastRun ? {
      usedLength: lastRun.used_length,
      complete: !!lastRun.complete,
      unplaced: JSON.parse(lastRun.unplaced),
    } : null,
  };
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

function updateConfig(width, length) {
  stmts.setConfig.run({ width, length });
}

function addDefect(x, y, w, h) {
  return stmts.insDefect.run(x, y, w, h).lastInsertRowid;
}
function removeDefect(id) {
  return stmts.delDefect.run(id).changes > 0;
}

function addPiece({ name, polygon, quantity, rotatable }) {
  return stmts.insPiece.run(name, JSON.stringify(polygon), quantity, rotatable ? 1 : 0).lastInsertRowid;
}
function updatePiece(id, { name, polygon, quantity, rotatable }) {
  return stmts.updPiece.run({
    id, name, polygon: JSON.stringify(polygon), quantity, rotatable: rotatable ? 1 : 0,
  }).changes > 0;
}
function removePiece(id) {
  return stmts.delPiece.run(id).changes > 0;
}

/**
 * 用一次排样结果覆盖所有“未锁定”的放置；锁定放置原样保留。
 * unplaced 的实例删除其 placement 行。
 */
function replacePlacements(placed, unplaced) {
  const tx = db.transaction(() => {
    // 删除所有未锁定行
    stmts.delUnlockedPlacements.run();
    for (const p of placed) {
      stmts.insPlacement.run({ pieceId: p.pieceId, index: p.index, x: p.x, y: p.y,
        orientation: p.orientation, locked: p.locked ? 1 : 0 });
    }
  });
  tx();
}

function updatePlacement(pieceId, index, x, y, orientation, locked) {
  const cur = stmts.getPlacement.get(pieceId, index);
  if (cur) {
    stmts.updPlacement.run(x, y, orientation, locked ? 1 : 0, pieceId, index);
  } else {
    stmts.insPlacementRow.run(pieceId, index, x, y, orientation, locked ? 1 : 0);
  }
}

function deletePlacement(pieceId, index) {
  stmts.delPlacement.run(pieceId, index);
}

function recordRun(usedLength, complete, unplaced) {
  stmts.insRun.run(usedLength, complete ? 1 : 0, JSON.stringify(unplaced));
}

module.exports = {
  open, getState,
  updateConfig, addDefect, removeDefect,
  addPiece, updatePiece, removePiece,
  replacePlacements, updatePlacement, deletePlacement, recordRun,
};
