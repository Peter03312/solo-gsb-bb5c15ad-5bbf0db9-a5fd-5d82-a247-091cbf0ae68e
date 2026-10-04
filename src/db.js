'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nesting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  fabric_width  INTEGER NOT NULL,
  fabric_length INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | partial | complete
  used_length   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS defects (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS piece_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  vertices     TEXT NOT NULL,              -- JSON，归一化后的顶点 [[x,y],...]
  quantity     INTEGER NOT NULL,
  allow_rotate INTEGER NOT NULL DEFAULT 0, -- 是否允许旋转 180°
  bw INTEGER NOT NULL, bh INTEGER NOT NULL -- 外接矩形尺寸（旋转 180° 不变）
);

CREATE TABLE IF NOT EXISTS placements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  piece_type_id INTEGER NOT NULL REFERENCES piece_types(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,          -- 该型号的第几件（1..quantity）
  x INTEGER, y INTEGER,                    -- 放置位置（未排入为 NULL）
  rotation INTEGER NOT NULL DEFAULT 0,     -- 0 | 180
  placed   INTEGER NOT NULL DEFAULT 0,
  locked   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_defects_job    ON defects(job_id);
CREATE INDEX IF NOT EXISTS idx_types_job      ON piece_types(job_id);
CREATE INDEX IF NOT EXISTS idx_placements_job ON placements(job_id);
`);

module.exports = db;
