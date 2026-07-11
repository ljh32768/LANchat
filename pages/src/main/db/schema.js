// 数据库 schema（范式化设计）。单文件 chat.db。
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS client_info (
  client_id  TEXT PRIMARY KEY,
  nickname   TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS contacts (
  contact_id    TEXT PRIMARY KEY,
  nickname      TEXT,
  alias         TEXT,
  last_seen_ip  TEXT,
  last_seen_at  INTEGER,
  is_favorite   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  host_contact_id   TEXT,
  name              TEXT,
  type              TEXT,
  status            TEXT,
  created_at        INTEGER,
  ended_at          INTEGER,
  last_activity_at  INTEGER,
  FOREIGN KEY (host_contact_id) REFERENCES contacts(contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id        TEXT PRIMARY KEY,
  session_id        TEXT,
  sender_contact_id TEXT,
  content           TEXT,
  type              TEXT,
  timestamp         INTEGER,
  local_id          TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  FOREIGN KEY (sender_contact_id) REFERENCES contacts(contact_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

CREATE TABLE IF NOT EXISTS files (
  file_id         TEXT PRIMARY KEY,
  message_id      TEXT,
  file_name       TEXT,
  file_size       INTEGER,
  storage_path    TEXT,
  download_status TEXT,
  received_bytes  INTEGER DEFAULT 0,
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
);

CREATE TABLE IF NOT EXISTS file_parts (
  file_id        TEXT,
  part_id        INTEGER,
  offset         INTEGER,
  length         INTEGER,
  received_bytes INTEGER DEFAULT 0,
  status         TEXT,
  PRIMARY KEY (file_id, part_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

module.exports = { SCHEMA_SQL };
