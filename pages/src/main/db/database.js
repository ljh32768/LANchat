// sql.js 数据库封装：在主进程内运行，通过 IPC 暴露给渲染进程。
// sql.js 为内存数据库，每次写入后持久化到 chat.db 文件。
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { app } = require('electron');
const initSqlJs = require('sql.js');
const { SCHEMA_SQL } = require('./schema');
const { v4: uuidv4 } = require('uuid');

let SQL = null;
let db = null;
let dbPath = null;
let persistTimer = null;
let pendingPersist = false;
let persistWorker = null;

// 初始化持久化 worker：承接同步写盘，避免阻塞主线程事件循环
// worker 不可用时（打包路径问题等）自动 fallback 到同步写
function initPersistWorker() {
  if (persistWorker) return;
  try {
    const workerPath = path.join(__dirname, 'persist-worker.js');
    persistWorker = new Worker(workerPath);
    persistWorker.on('error', (e) => {
      console.error('[db] persist worker error:', e);
      persistWorker = null;
    });
    persistWorker.on('exit', (code) => {
      if (code !== 0) { console.warn('[db] persist worker exit code', code); persistWorker = null; }
    });
    console.log('[db] persist worker initialized');
  } catch (e) {
    console.warn('[db] persist worker init failed, fallback to sync:', e.message);
    persistWorker = null;
  }
}

// 把当前内存数据库写入磁盘（防抖 500ms + 原子写入 write-to-temp-then-rename）
// 写盘移到 worker_threads，主线程只做 db.export()（WASM 同步，通常 <50ms）
function persist() {
  if (!db) return;
  // V6：防抖 —— 500ms 内多次写入只持久化一次，避免每条消息都全量 export
  pendingPersist = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!pendingPersist || !db) return;
    pendingPersist = false;
    try {
      const data = db.export();
      // V12：原子写入 —— 先写临时文件再 rename，防崩溃损坏 DB
      const tmp = dbPath + '.tmp';
      if (persistWorker) {
        // transfer buffer 零拷贝给 worker，写盘不阻塞主线程
        persistWorker.postMessage({ buffer: data.buffer, tmpPath: tmp, dbPath }, [data.buffer]);
      } else {
        // fallback：同步写（worker 不可用时）
        fs.writeFileSync(tmp, Buffer.from(data));
        fs.renameSync(tmp, dbPath);
      }
    } catch (e) {
      console.error('[db] persist failed:', e);
    }
  }, 500);
}

// 强制立即持久化（用于关闭前/重要操作后）
function persistNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  pendingPersist = false;
  if (!db) return;
  try {
    const data = db.export();
    const tmp = dbPath + '.tmp';
    if (persistWorker) {
      persistWorker.postMessage({ buffer: data.buffer, tmpPath: tmp, dbPath }, [data.buffer]);
    } else {
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, dbPath);
    }
  } catch (e) {
    console.error('[db] persistNow failed:', e);
  }
}

// V28：版本化数据库迁移（PRAGMA user_version）
// 每次升级在对应 if (version < N) 块中追加迁移逻辑，并更新 version = N
function runMigrations() {
  const versionRow = queryOne('PRAGMA user_version');
  let version = versionRow?.user_version || 0;

  // v1: 添加 sessions.last_activity_at 列
  if (version < 1) {
    try {
      const cols = query('PRAGMA table_info(sessions)');
      if (cols.length > 0 && !cols.some((c) => c.name === 'last_activity_at')) {
        execute('ALTER TABLE sessions ADD COLUMN last_activity_at INTEGER');
      }
    } catch (e) {
      console.error('[db] migration v1 failed:', e);
    }
    version = 1;
  }

  // v2: 添加 files.received_bytes 列（断点续传：记录已接收字节数）
  if (version < 2) {
    try {
      const cols = query('PRAGMA table_info(files)');
      if (cols.length > 0 && !cols.some((c) => c.name === 'received_bytes')) {
        execute('ALTER TABLE files ADD COLUMN received_bytes INTEGER DEFAULT 0');
      }
    } catch (e) {
      console.error('[db] migration v2 failed:', e);
    }
    version = 2;
  }

  // v3: 建 file_parts 表（多连接并行下载：每 part 独立追踪 received_bytes 支持续传）
  if (version < 3) {
    try {
      execute(`CREATE TABLE IF NOT EXISTS file_parts (
        file_id        TEXT,
        part_id        INTEGER,
        offset         INTEGER,
        length         INTEGER,
        received_bytes INTEGER DEFAULT 0,
        status         TEXT,
        PRIMARY KEY (file_id, part_id)
      )`);
    } catch (e) {
      console.error('[db] migration v3 failed:', e);
    }
    version = 3;
  }

  // v4: sessions.peer_contact_id —— 私聊绑定对方联系人，支持按联系人反查
  if (version < 4) {
    try {
      const cols = query('PRAGMA table_info(sessions)');
      if (cols.length > 0 && !cols.some((c) => c.name === 'peer_contact_id')) {
        execute('ALTER TABLE sessions ADD COLUMN peer_contact_id TEXT');
      }
      execute('CREATE INDEX IF NOT EXISTS idx_sessions_peer ON sessions(peer_contact_id, type, status)');
    } catch (e) {
      console.error('[db] migration v4 failed:', e);
    }
    version = 4;
  }

  // 未来迁移在此追加：if (version < 5) { ... version = 5; }

  if (db) db.run(`PRAGMA user_version = ${version};`);
  console.log('[db] migrations done, user_version =', version);
}

async function initDatabase() {
  if (db) return db;

  // 加载 sql.js wasm（打包后 asarUnpack 会释放到 app.asar.unpacked）
  let wasmPath = path.join(
    process.cwd(),
    'node_modules',
    'sql.js',
    'dist',
    'sql-wasm.wasm'
  );
  // 打包环境：从 __dirname 推算 asar.unpacked 路径
  if (app.isPackaged) {
    wasmPath = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'sql.js',
      'dist',
      'sql-wasm.wasm'
    );
  }
  SQL = await initSqlJs({ locateFile: () => wasmPath });

  // 数据库文件存放于 userData 目录
  const dataDir = app.getPath('userData');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, 'chat.db');

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(SCHEMA_SQL);

  // V17：启用 SQLite 外键约束（默认关闭）
  db.run('PRAGMA foreign_keys = ON;');

  // V28：版本化数据库迁移（PRAGMA user_version）
  runMigrations();

  // 初始化持久化 worker（承接写盘，不阻塞主线程）
  initPersistWorker();

  persist();

  // 首次启动初始化 client_info
  const row = queryOne('SELECT client_id, nickname, created_at FROM client_info LIMIT 1');
  if (!row) {
    const clientId = uuidv4();
    const now = Date.now();
    execute(
      'INSERT INTO client_info (client_id, nickname, created_at) VALUES (?, ?, ?)',
      [clientId, '指挥官', now]
    );
  }

  // 确保 self 在 contacts 表中（sessions.host_contact_id FK → contacts）
  const self = getClientInfo();
  if (self) {
    const existing = queryOne('SELECT contact_id FROM contacts WHERE contact_id = ?', [self.client_id]);
    if (!existing) {
      execute(
        'INSERT INTO contacts (contact_id, nickname, last_seen_ip, last_seen_at, is_favorite) VALUES (?, ?, ?, ?, 0)',
        [self.client_id, self.nickname, null, Date.now()]
      );
    }
  }

  return db;
}

// 参数绑定：sql.js 接收数组
function query(sql, params = []) {
  if (!db) throw new Error('db not initialized');
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

function execute(sql, params = []) {
  if (!db) throw new Error('db not initialized');
  db.run(sql, params);
  persist();
  return { changes: db.getRowsModified() };
}

// ---- 高层业务方法 ----

function getClientInfo() {
  return queryOne('SELECT client_id, nickname, created_at FROM client_info LIMIT 1');
}

function setNickname(nickname) {
  execute('UPDATE client_info SET nickname = ?', [nickname]);
  return getClientInfo();
}

function upsertContact({ contact_id, nickname, last_seen_ip, last_seen_at }) {
  const existing = queryOne('SELECT contact_id FROM contacts WHERE contact_id = ?', [contact_id]);
  if (existing) {
    execute(
      `UPDATE contacts SET nickname = ?, last_seen_ip = ?, last_seen_at = ? WHERE contact_id = ?`,
      [nickname, last_seen_ip, last_seen_at, contact_id]
    );
  } else {
    execute(
      `INSERT INTO contacts (contact_id, nickname, last_seen_ip, last_seen_at, is_favorite)
       VALUES (?, ?, ?, ?, 0)`,
      [contact_id, nickname, last_seen_ip, last_seen_at]
    );
  }
  return queryOne('SELECT * FROM contacts WHERE contact_id = ?', [contact_id]);
}

function listContacts() {
  // 收藏优先 + 按昵称/别名稳定排序 + contact_id 兜底（避免重名时位置互换）
  return query('SELECT * FROM contacts ORDER BY COALESCE(NULLIF(alias, \'\'), nickname) ASC, contact_id ASC');
}

function setAlias(contact_id, alias) {
  execute('UPDATE contacts SET alias = ? WHERE contact_id = ?', [alias, contact_id]);
}

function deleteContact(contact_id) {
  execute('DELETE FROM contacts WHERE contact_id = ?', [contact_id]);
}

function toggleFavorite(contact_id) {
  execute(
    'UPDATE contacts SET is_favorite = CASE is_favorite WHEN 1 THEN 0 ELSE 1 END WHERE contact_id = ?',
    [contact_id]
  );
}

function listSessions() {
  return query('SELECT * FROM sessions ORDER BY COALESCE(last_activity_at, created_at) DESC');
}

function touchSession(session_id) {
  execute('UPDATE sessions SET last_activity_at = ? WHERE session_id = ?', [Date.now(), session_id]);
}

function getSession(session_id) {
  return queryOne('SELECT * FROM sessions WHERE session_id = ?', [session_id]);
}

function createSession({ session_id, host_contact_id, name, type, status, created_at, peer_contact_id = null }) {
  // 用 INSERT OR REPLACE：重新加入已退出过的会话时覆盖旧记录，保留关联的消息历史
  // peer_contact_id：私聊绑定对方；若 REPLACE 时未传则尽量保留旧值
  const existing = getSession(session_id);
  const peer = peer_contact_id != null
    ? peer_contact_id
    : (existing?.peer_contact_id || null);
  const created = created_at || existing?.created_at || Date.now();
  execute(
    `INSERT OR REPLACE INTO sessions (session_id, host_contact_id, peer_contact_id, name, type, status, created_at, ended_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [session_id, host_contact_id, peer, name, type, status, created, Date.now()]
  );
  return getSession(session_id);
}

// 按对方联系人查找私聊：优先 active，其次最近一条（含 ended，用于历史/重建）
function findPrivateSession(peer_contact_id) {
  if (!peer_contact_id) return null;
  const active = queryOne(
    `SELECT * FROM sessions
     WHERE type = 'private' AND peer_contact_id = ? AND status = 'active'
     ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT 1`,
    [peer_contact_id]
  );
  if (active) return active;
  return queryOne(
    `SELECT * FROM sessions
     WHERE type = 'private' AND peer_contact_id = ?
     ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT 1`,
    [peer_contact_id]
  );
}

// 是否曾与该联系人建立过私聊（有会话记录即视为有历史，触发上线自动重建）
function hasPrivateHistory(peer_contact_id) {
  if (!peer_contact_id) return false;
  const row = queryOne(
    `SELECT session_id FROM sessions WHERE type = 'private' AND peer_contact_id = ? LIMIT 1`,
    [peer_contact_id]
  );
  return !!row;
}

// 将会话重新标为 active（断线后重建用，保留 created_at / peer / name）
function activateSession(session_id, { host_contact_id, name } = {}) {
  const s = getSession(session_id);
  if (!s) return null;
  execute(
    `UPDATE sessions SET status = 'active', ended_at = NULL,
       host_contact_id = COALESCE(?, host_contact_id),
       name = COALESCE(?, name),
       last_activity_at = ?
     WHERE session_id = ?`,
    [host_contact_id || null, name || null, Date.now(), session_id]
  );
  return getSession(session_id);
}

// 成员退出会话：仅删除 sessions 表记录（保留 messages，便于重新加入后查看历史）
function leaveSession(session_id) {
  execute('DELETE FROM sessions WHERE session_id = ?', [session_id]);
}

function closeSession(session_id, ended_at) {
  execute('UPDATE sessions SET status = ?, ended_at = ? WHERE session_id = ?', [
    'ended',
    ended_at,
    session_id
  ]);
}

// 删除已结束会话：级联清理 file_parts → files → messages → sessions
function deleteSession(session_id) {
  // 先查出该会话所有 message_id，用于删 files 和 file_parts
  const msgs = query('SELECT message_id FROM messages WHERE session_id = ?', [session_id]);
  if (msgs.length > 0) {
    const ids = msgs.map((m) => m.message_id);
    const placeholders = ids.map(() => '?').join(',');
    // 查出所有 file_id，用于删 file_parts
    const fileRows = query(`SELECT file_id FROM files WHERE message_id IN (${placeholders})`, ids);
    if (fileRows.length > 0) {
      const fileIds = fileRows.map((f) => f.file_id);
      const fpPlaceholders = fileIds.map(() => '?').join(',');
      execute(`DELETE FROM file_parts WHERE file_id IN (${fpPlaceholders})`, fileIds);
    }
    execute(`DELETE FROM files WHERE message_id IN (${placeholders})`, ids);
  }
  execute('DELETE FROM messages WHERE session_id = ?', [session_id]);
  execute('DELETE FROM sessions WHERE session_id = ?', [session_id]);
}

function listMessages(session_id) {
  // LEFT JOIN contacts 拿 sender_nickname（别名优先），历史消息也能显示发送者名
  return query(
    `SELECT m.*, COALESCE(c.alias, c.nickname) AS sender_nickname, c.last_seen_ip AS sender_ip
     FROM messages m
     LEFT JOIN contacts c ON m.sender_contact_id = c.contact_id
     WHERE m.session_id = ? ORDER BY m.timestamp ASC`,
    [session_id]
  );
}

function addMessage({ message_id, session_id, sender_contact_id, content, type, timestamp, local_id }) {
  // V24：INSERT OR IGNORE 避免 TOCTOU 竞态下 PRIMARY KEY 冲突
  execute(
    `INSERT OR IGNORE INTO messages (message_id, session_id, sender_contact_id, content, type, timestamp, local_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [message_id, session_id, sender_contact_id, content, type, timestamp, local_id]
  );
  // 更新会话活动时间（用于列表按活动排序）
  try { touchSession(session_id); } catch {}
  return queryOne('SELECT * FROM messages WHERE message_id = ?', [message_id]);
}

function addFile({ file_id, message_id, file_name, file_size, storage_path, download_status }) {
  execute(
    `INSERT INTO files (file_id, message_id, file_name, file_size, storage_path, download_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [file_id, message_id, file_name, file_size, storage_path, download_status]
  );
  return queryOne('SELECT * FROM files WHERE file_id = ?', [file_id]);
}

function updateFileStatus(file_id, status, storage_path = null) {
  if (storage_path !== null) {
    execute('UPDATE files SET download_status = ?, storage_path = ? WHERE file_id = ?', [
      status,
      storage_path,
      file_id
    ]);
  } else {
    execute('UPDATE files SET download_status = ? WHERE file_id = ?', [status, file_id]);
  }
}

// 断点续传：记录已接收字节数（可选附带 storage_path，用于失败后保留分片路径）
function updateFileProgress(file_id, received_bytes, storage_path = null) {
  if (storage_path !== null) {
    execute('UPDATE files SET received_bytes = ?, storage_path = ? WHERE file_id = ?', [
      received_bytes,
      storage_path,
      file_id
    ]);
  } else {
    execute('UPDATE files SET received_bytes = ? WHERE file_id = ?', [received_bytes, file_id]);
  }
}

function getFile(file_id) {
  return queryOne('SELECT * FROM files WHERE file_id = ?', [file_id]);
}

function listFiles(message_id) {
  return query('SELECT * FROM files WHERE message_id = ?', [message_id]);
}

// 按会话查询所有文件记录（用于渲染层恢复文件下载状态）
function listFilesBySession(session_id) {
  return query(
    `SELECT f.* FROM files f
     JOIN messages m ON f.message_id = m.message_id
     WHERE m.session_id = ?`,
    [session_id]
  );
}

// 多连接并行下载：file_parts 表操作
function setFileParts(file_id, parts) {
  execute('DELETE FROM file_parts WHERE file_id = ?', [file_id]);
  for (const p of parts) {
    execute('INSERT INTO file_parts (file_id, part_id, offset, length, received_bytes, status) VALUES (?,?,?,?,?,?)',
      [file_id, p.part_id, p.offset, p.length, p.received_bytes || 0, p.status || 'pending']);
  }
}

function updateFilePartProgress(file_id, part_id, received_bytes) {
  execute('UPDATE file_parts SET received_bytes = ? WHERE file_id = ? AND part_id = ?', [received_bytes, file_id, part_id]);
}

function listFileParts(file_id) {
  return query('SELECT * FROM file_parts WHERE file_id = ? ORDER BY part_id', [file_id]);
}

function clearFileParts(file_id) {
  execute('DELETE FROM file_parts WHERE file_id = ?', [file_id]);
}

function getSetting(key, defaultValue = null) {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  execute(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
  return value;
}

// V18：清理旧消息 + VACUUM 回收空间
function cleanupOldMessages(daysThreshold = 30) {
  const cutoff = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;
  // 级联清理 file_parts：先找出过期消息关联的 file_id
  const oldFileIds = query('SELECT file_id FROM files WHERE message_id IN (SELECT message_id FROM messages WHERE timestamp < ?)', [cutoff]);
  if (oldFileIds.length > 0) {
    const ids = oldFileIds.map((f) => f.file_id);
    const placeholders = ids.map(() => '?').join(',');
    execute(`DELETE FROM file_parts WHERE file_id IN (${placeholders})`, ids);
  }
  execute('DELETE FROM files WHERE message_id IN (SELECT message_id FROM messages WHERE timestamp < ?)', [cutoff]);
  execute('DELETE FROM messages WHERE timestamp < ?', [cutoff]);
  execute("DELETE FROM sessions WHERE status = 'ended' AND session_id NOT IN (SELECT DISTINCT session_id FROM messages)");
  if (db) db.run('VACUUM;');
  persist();
  return { deleted: true, cutoff };
}

module.exports = {
  initDatabase,
  query,
  queryOne,
  execute,
  getClientInfo,
  setNickname,
  upsertContact,
  listContacts,
  setAlias,
  deleteContact,
  listSessions,
  touchSession,
  getSession,
  createSession,
  findPrivateSession,
  hasPrivateHistory,
  activateSession,
  closeSession,
  leaveSession,
  deleteSession,
  listMessages,
  addMessage,
  addFile,
  updateFileStatus,
  updateFileProgress,
  getFile,
  listFiles,
  listFilesBySession,
  setFileParts,
  updateFilePartProgress,
  listFileParts,
  clearFileParts,
  getSetting,
  setSetting,
  persistNow,
  cleanupOldMessages
};
