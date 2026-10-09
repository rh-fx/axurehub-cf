-- AxureHub / D1 (SQLite) 表结构
-- 说明：绑定 D1 后程序会自动执行本文件中的语句（CREATE TABLE IF NOT EXISTS），
--      手动执行仅在你想预建表时需要：npm run d1:schema

CREATE TABLE IF NOT EXISTS prototypes (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'folder',   -- folder | single
  emoji          TEXT NOT NULL DEFAULT '🧩',
  description    TEXT NOT NULL DEFAULT '',
  tags           TEXT NOT NULL DEFAULT '',
  entry          TEXT NOT NULL DEFAULT 'index.html',
  active_version INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  proto_id   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  entry      TEXT NOT NULL DEFAULT 'index.html',
  pages_json TEXT NOT NULL DEFAULT '[]',
  files_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proto_id, version)
);

CREATE TABLE IF NOT EXISTS links (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '🔗',
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_versions_proto ON versions (proto_id, version);
CREATE INDEX IF NOT EXISTS idx_links_order ON links (sort_order, created_at);
