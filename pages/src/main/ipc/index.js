// IPC 处理器：将数据库与网络层的能力暴露给渲染进程。
const { ipcMain, app, dialog } = require('electron');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { NetworkManager } = require('../network/network');
const {
  IPC,
  IPC_EVENT,
  SESSION_TYPE,
  SESSION_STATUS,
  MSG_TYPE,
  FILE_STATUS
} = require('../../shared/constants');

const net = new NetworkManager();
let mainWindow = null;
let initialized = false;

// 文件路径授权白名单：dialog:open-file 选择后授权，file:upload 消费后移除（一次性）
const authorizedFilePaths = new Set();
function addAuthorizedFilePath(p) { if (p) authorizedFilePaths.add(p); }

// V14：消息速率限制（10 msg/sec）与消息队列
// 滑动窗口限速：1000ms 窗口内最多 MAX_MSG_PER_SEC 条
const MAX_MSG_PER_SEC = 10;
const MSG_QUEUE_SIZE = 100;
const MSG_RATE_WINDOW_MS = 1000;
const MSG_RATE_INTERVAL_MS = Math.ceil(MSG_RATE_WINDOW_MS / MAX_MSG_PER_SEC); // 100ms 间隔
const MAX_MSG_CONTENT_LEN = 16 * 1024; // 16KB
const messageQueue = new Map(); // queueKey -> { queue: [], recentTs: [], currentMsg: null }

function enqueueMessage(session_id, content, type) {
  // 内容长度校验
  if (typeof content === 'string' && content.length > MAX_MSG_CONTENT_LEN) {
    return { error: '消息内容过长（上限 16KB）' };
  }

  const client = db.getClientInfo();
  const message_id = uuidv4();
  const local_id = uuidv4();
  const timestamp = Date.now();
  const msg = {
    kind: 'msg',
    message_id,
    session_id,
    sender_contact_id: client.client_id,
    sender_nickname: client.nickname,
    sender_ip: net.localIp,
    content,
    type,
    timestamp,
    local_id
  };

  const queueKey = `${session_id}:${client.client_id}`;
  let q = messageQueue.get(queueKey);

  if (!q) {
    q = { queue: [], recentTs: [], currentMsg: null };
    messageQueue.set(queueKey, q);
  }

  // 如果有消息正在发送，直接排队等待
  if (q.currentMsg) {
    if (q.queue.length >= MSG_QUEUE_SIZE) {
      q.queue.shift(); // 队列已满，丢弃最早的
    }
    q.queue.push(msg);
    return { message_id, timestamp, local_id };
  }

  // 滑动窗口限速：清理窗口外的旧时间戳，检查窗口内数量
  const now = timestamp;
  q.recentTs = q.recentTs.filter((t) => now - t < MSG_RATE_WINDOW_MS);
  if (q.recentTs.length >= MAX_MSG_PER_SEC) {
    // 窗口已满，排队
    if (q.queue.length >= MSG_QUEUE_SIZE) {
      q.queue.shift();
    }
    q.queue.push(msg);
    return { message_id, timestamp, local_id };
  }

  // 速率限制通过，立即发送
  q.recentTs.push(now);
  q.currentMsg = msg;

  // 发送方本地存库
  db.addMessage({
    message_id,
    session_id,
    sender_contact_id: client.client_id,
    content,
    type,
    timestamp,
    local_id
  });

  // 网络发送
  const sendMsg = () => {
    if (net.isHosting(session_id)) {
      net.relayToMembers(session_id, msg);
    } else if (net.isJoined(session_id)) {
      net.memberSend(session_id, msg);
    }
    q.currentMsg = null;

    // 处理队列中的下一条消息（按限速间隔发送，保持原始 message_id）
    if (q.queue.length > 0) {
      const nextMsg = q.queue.shift();
      setTimeout(() => flushQueuedMessage(nextMsg, q), MSG_RATE_INTERVAL_MS);
    }
  };

  sendMsg();
  return { message_id, timestamp, local_id };
}

// 发送队列中的消息（保持原始 message_id，按限速间隔泄洪）
function flushQueuedMessage(msg, q) {
  // 写入 DB
  db.addMessage({
    message_id: msg.message_id,
    session_id: msg.session_id,
    sender_contact_id: msg.sender_contact_id,
    content: msg.content,
    type: msg.type,
    timestamp: msg.timestamp,
    local_id: msg.local_id
  });

  // 网络发送
  if (net.isHosting(msg.session_id)) {
    net.relayToMembers(msg.session_id, msg);
  } else if (net.isJoined(msg.session_id)) {
    net.memberSend(msg.session_id, msg);
  }

  // 继续处理队列中的下一条，按限速间隔发送
  if (q && q.queue.length > 0) {
    const nextMsg = q.queue.shift();
    setTimeout(() => flushQueuedMessage(nextMsg, q), MSG_RATE_INTERVAL_MS);
  }
}

// V13：昵称/名称后端校验（长度上限 + 去除换行/尖括号）
function sanitizeName(s) {
  return String(s || '').trim().slice(0, 24).replace(/[\r\n<>]/g, '');
}

// 会话名称校验：放宽到 32 字符，同样去换行/尖括号
function sanitizeSessionName(s) {
  return String(s || '').trim().slice(0, 32).replace(/[\r\n<>]/g, '');
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// 接收到远端消息（主机收到成员 / 成员收到主机转发）→ 存库 + 推送渲染
// options.source === 'history'：历史同步，仍推渲染入库 UI，但不计未读/不响提示
function handleReceivedMessage(msg, options = {}) {
  try {
    const source = options.source || msg.source || 'live';
    // 幂等：若已存在则跳过入库，但仍可能需要补 UI（极少见）；历史路径跳过重复推送
    const existing = db.queryOne('SELECT message_id FROM messages WHERE message_id = ?', [msg.message_id]);
    if (!existing) {
      // upsert 发送者联系人
      if (msg.sender_contact_id && msg.sender_nickname) {
        db.upsertContact({
          contact_id: msg.sender_contact_id,
          nickname: sanitizeName(msg.sender_nickname),
          last_seen_ip: msg.sender_ip || null,
          last_seen_at: Date.now()
        });
      }
      db.addMessage({
        message_id: msg.message_id,
        session_id: msg.session_id,
        sender_contact_id: msg.sender_contact_id,
        content: msg.content,
        type: msg.type,
        timestamp: msg.timestamp,
        local_id: msg.local_id || uuidv4()
      });
      // 文件消息：写入 files 表（pending，等待下载）
      if (msg.type === MSG_TYPE.FILE && msg.file_id) {
        let meta = { file_id: msg.file_id, file_name: msg.file_name, file_size: msg.file_size };
        if (!meta.file_name) {
          try { meta = JSON.parse(msg.content); } catch {}
        }
        const already = db.queryOne('SELECT file_id FROM files WHERE file_id = ?', [meta.file_id]);
        if (!already) {
          // 成员上传的文件已存储在主机本地（fileStoreDir/file_id），
          // 主机直接标记 COMPLETED，渲染层显示"已暂存"
          const isHost = net.isHosting(msg.session_id);
          db.addFile({
            file_id: meta.file_id,
            message_id: msg.message_id,
            file_name: meta.file_name,
            file_size: meta.file_size,
            storage_path: isHost ? net.getFileStorePath(meta.file_id) : null,
            download_status: isHost ? FILE_STATUS.COMPLETED : FILE_STATUS.PENDING
          });
        }
      }
    } else if (source === 'history') {
      // 历史中已有记录：无需再推 UI
      return;
    }
    send(IPC_EVENT.MESSAGE_RECEIVED, {
      message_id: msg.message_id,
      session_id: msg.session_id,
      sender_contact_id: msg.sender_contact_id,
      content: msg.content,
      type: msg.type,
      timestamp: msg.timestamp,
      source
    });
  } catch (e) {
    console.error('[ipc] handleReceivedMessage error:', e);
  }
}

function registerNetworkEvents() {
  net.on('session-discovered', (info) => send(IPC_EVENT.SESSION_DISCOVERED, info));
  net.on('session-removed', (info) => send(IPC_EVENT.SESSION_REMOVED, info));
  net.on('session-ended', ({ session_id }) => {
    // 主机明确解散（TCP session-end）：标记本地会话结束并通知渲染层
    try { db.closeSession(session_id, Date.now()); } catch {}
    send(IPC_EVENT.SESSION_ENDED, { session_id, ended_at: Date.now() });
  });
  net.on('presence-update', (info) => send(IPC_EVENT.PRESENCE_UPDATE, info));
  net.on('message', (msg) => handleReceivedMessage(msg));
  net.on('peer-online', (peer) => {
    db.upsertContact({
      contact_id: peer.client_id,
      nickname: peer.nickname,
      last_seen_ip: peer.ip,
      last_seen_at: Date.now()
    });
    send(IPC_EVENT.PRESENCE_UPDATE, {
      client_id: peer.client_id,
      nickname: peer.nickname,
      ip: peer.ip,
      online: true
    });
  });
  net.on('peer-offline', ({ client_id }) => send(IPC_EVENT.PRESENCE_UPDATE, { client_id, online: false }));
  net.on('joined', ({ session_id, members }) => send(IPC_EVENT.PRESENCE_UPDATE, { session_id, members }));
  // 成员加入主机托管会话：主机把历史消息推送给新成员，解决"加入前消息看不到"
  net.on('member-joined', ({ session_id, client_id }) => {
    try {
      const rows = db.listMessages(session_id);
      if (rows.length === 0) return;
      // 组装成与实时 msg 一致的结构，接收方 handleReceivedMessage 幂等入库
      const messages = rows.map((r) => {
        const m = {
          kind: 'msg',
          message_id: r.message_id,
          session_id: r.session_id,
          sender_contact_id: r.sender_contact_id,
          sender_nickname: r.sender_nickname,
          sender_ip: r.sender_ip,
          content: r.content,
          type: r.type,
          timestamp: r.timestamp,
          local_id: r.local_id
        };
        // 文件消息：从 content JSON 中提取 file_id / file_name / file_size，
        // 否则接收方 handleReceivedMessage 因缺少 file_id 无法创建文件记录
        if (r.type === MSG_TYPE.FILE && r.content) {
          try {
            const meta = JSON.parse(r.content);
            if (meta.file_id) {
              m.file_id = meta.file_id;
              m.file_name = meta.file_name;
              m.file_size = meta.file_size;
            }
          } catch {}
        }
        return m;
      });
      net.sendHistoryToMember(session_id, client_id, messages);
    } catch (e) {
      console.error('[ipc] member-joined history push error:', e);
    }
  });
  // 私聊会话：任一方离线时主机自动解散 → 结束本地会话 + 通知渲染
  net.on('session-auto-end', ({ session_id }) => {
    try {
      db.closeSession(session_id, Date.now());
    } catch {}
    send(IPC_EVENT.SESSION_ENDED, { session_id, ended_at: Date.now() });
  });
  // 收到私聊邀请：自动加入 + 本地记录会话 + 通知渲染层
  net.on('private-invite', (invite) => {
    try {
      // 建立 TCP 连接到主机
      net.joinSession(invite.session_id, invite.host_ip, invite.message_port, (msg) => handleReceivedMessage(msg), {
        file_port: invite.file_port
      });
      // 本地记录会话
      const existing = db.getSession(invite.session_id);
      if (!existing) {
        db.createSession({
          session_id: invite.session_id,
          host_contact_id: invite.from.client_id,
          name: invite.session_name,
          type: SESSION_TYPE.PRIVATE,
          status: SESSION_STATUS.ACTIVE,
          created_at: Date.now()
        });
        // upsert 邀请人为联系人
        db.upsertContact({
          contact_id: invite.from.client_id,
          nickname: invite.from.nickname,
          last_seen_ip: invite.from.ip,
          last_seen_at: Date.now()
        });
      }
      // 通知渲染层：本地已新建会话（私聊已自动加入），刷新"我的会话"列表
      send(IPC_EVENT.SESSION_CREATED, {
        session_id: invite.session_id,
        name: invite.session_name,
        type: SESSION_TYPE.PRIVATE
      });
    } catch (e) {
      console.error('[ipc] private-invite handle error:', e);
    }
  });
  net.on('file-uploaded', (info) => {
    // 主机收到成员上传完成：广播文件通知给所有成员
    const { file_id, file_name } = info;
    // 上传完成后由 IPC 层补发 file 通知（见 file:upload 处理）
  });
}

async function init(window) {
  mainWindow = window;
  await db.initDatabase();

  const clientInfo = db.getClientInfo();
  if (!initialized) {
    registerNetworkEvents();
    net.start(clientInfo);
    initialized = true;
  }
  return clientInfo;
}

function registerIpcHandlers() {
  // ---- 客户端 ----
  ipcMain.handle(IPC.CLIENT_INIT, async () => {
    const info = await init(mainWindow);
    return { ...info, ip: net.localIp };
  });

  ipcMain.handle(IPC.CLIENT_SET_NICKNAME, (_e, nickname) => {
    const info = db.setNickname(sanitizeName(nickname));
    net.setClientInfo(info);
    return { ...info, ip: net.localIp };
  });

  // ---- 联系人 ----
  ipcMain.handle(IPC.CONTACTS_LIST, () => db.listContacts());
  ipcMain.handle(IPC.CONTACTS_SET_ALIAS, (_e, { contact_id, alias }) => {
    db.setAlias(contact_id, alias);
    return db.listContacts();
  });
  ipcMain.handle(IPC.CONTACTS_DELETE, (_e, { contact_id }) => {
    db.deleteContact(contact_id);
    return db.listContacts();
  });
  // ---- 会话 ----
  ipcMain.handle(IPC.SESSION_CREATE, (_e, { name, type, invitee_ip, invitee_client_id }) => {
    const client = db.getClientInfo();
    const session_id = uuidv4();
    const now = Date.now();
    const cleanName = sanitizeSessionName(name) || '未命名会话';
    const session = db.createSession({
      session_id,
      host_contact_id: client.client_id,
      name: cleanName,
      type,
      status: SESSION_STATUS.ACTIVE,
      created_at: now
    });
    // 作为主机托管：监听 TCP 端口
    // 私聊邀请必须在 listen 成功后发送（否则被邀请方 TCP 连接会被拒绝）
    const isPrivateInvite = type === SESSION_TYPE.PRIVATE && invitee_ip && invitee_client_id;
    net.hostSession(session, 0, (finalPort) => {
      if (isPrivateInvite && finalPort) {
        net.sendPrivateInvite(invitee_ip, {
          to: invitee_client_id,
          session_id,
          session_name: name,
          message_port: finalPort
        });
      }
    });
    return session;
  });

  ipcMain.handle(IPC.SESSION_CLOSE, (_e, session_id) => {
    const now = Date.now();
    db.closeSession(session_id, now);
    if (net.isHosting(session_id)) net.closeHostedSession(session_id);
    if (net.isJoined(session_id)) net.leaveSession(session_id);
    send(IPC_EVENT.SESSION_ENDED, { session_id, ended_at: now });
    return { ok: true };
  });

  // 成员退出会话：仅断开自己的 TCP 连接 + 删除本地 session 记录（保留消息历史）
  // 会话本身仍由主机维持，会重新出现在"局域网发现"分区供再次加入
  ipcMain.handle(IPC.SESSION_LEAVE, (_e, session_id) => {
    if (net.isJoined(session_id)) net.leaveSession(session_id);
    db.leaveSession(session_id);
    return { ok: true };
  });

  ipcMain.handle(IPC.SESSION_LIST, () => db.listSessions());

  ipcMain.handle(IPC.SESSION_DELETE, (_e, session_id) => {
    db.deleteSession(session_id);
    return { ok: true };
  });

  ipcMain.handle(IPC.SESSION_JOIN, (_e, { session_id, host_ip, host_port }) => {
    // 加入已发现会话：建立 TCP 连接到主机
    const discovered = net.discoveredSessions.get(session_id);
    net.joinSession(session_id, host_ip, host_port, (msg) => handleReceivedMessage(msg), {
      file_port: discovered?.file_port
    });
    // 本地记录会话：不存在则新建，已存在（如 ended 状态）则重置为 active 保留消息历史
    const existing = db.getSession(session_id);
    if (!existing) {
      db.createSession({
        session_id,
        host_contact_id: discovered?.host_contact_id || 'unknown',
        name: discovered?.name || '未知会话',
        type: discovered?.type || SESSION_TYPE.GROUP,
        status: SESSION_STATUS.ACTIVE,
        created_at: Date.now()
      });
    } else if (existing.status !== SESSION_STATUS.ACTIVE) {
      db.createSession({
        session_id,
        host_contact_id: existing.host_contact_id,
        name: existing.name,
        type: existing.type,
        status: SESSION_STATUS.ACTIVE,
        created_at: existing.created_at
      });
    }
    return { ok: true };
  });

  // ---- 消息 ----
  ipcMain.handle(IPC.MESSAGE_SEND, async (_e, { session_id, content, type }) => {
    // 校验会话状态：ended 或未 host/join 则拒绝发送
    const session = db.getSession(session_id);
    if (session && session.status === SESSION_STATUS.ENDED) {
      return { error: '会话已结束' };
    }
    if (!net.isHosting(session_id) && !net.isJoined(session_id)) {
      return { error: '未连接到会话' };
    }
    return enqueueMessage(session_id, content, type);
  });

  ipcMain.handle(IPC.MESSAGE_LIST, (_e, session_id) => db.listMessages(session_id));

  // ---- 文件 ----
  ipcMain.handle(IPC.FILE_UPLOAD, async (_e, { session_id, file_path }) => {
    const client = db.getClientInfo();
    // 校验会话状态
    const session = db.getSession(session_id);
    if (session && session.status === SESSION_STATUS.ENDED) {
      return { ok: false, error: '会话已结束' };
    }
    if (!net.isHosting(session_id) && !net.isJoined(session_id)) {
      return { ok: false, error: '未连接到会话' };
    }
    // 校验文件路径授权：仅接受通过 dialog:open-file 选择的路径
    if (!authorizedFilePaths.has(file_path)) {
      return { ok: false, error: '文件路径未授权' };
    }
    authorizedFilePaths.delete(file_path); // 一次性消费
    // 阶段4：IPC 层错误处理——文件读取失败时直接返回，不创建消息记录
    let stat;
    try {
      stat = fs.statSync(file_path);
    } catch (e) {
      return { ok: false, error: '无法读取文件: ' + (e.message || e) };
    }
    const file_id = uuidv4();
    const message_id = uuidv4();
    const local_id = uuidv4();
    const timestamp = Date.now();
    const file_name = path.basename(file_path);
    const file_size = stat.size;

    try {
      if (net.isHosting(session_id)) {
        // 本机即主机：本地暂存
        await new Promise((res, rej) => {
          net.storeLocalFile(file_id, file_path, (e) => (e ? rej(e) : res()));
        });
      } else if (net.isJoined(session_id)) {
        // 成员：上传到主机暂存（network 层已含自动重试，最多 2 次）
        await new Promise((res, rej) => {
          net.uploadFileToHost(session_id, { file_id, file_name, file_size, file_path }, (e) =>
            e ? rej(e) : res()
          );
        });
      }
    } catch (e) {
      // 阶段4：上传失败时返回错误，不创建消息记录（避免渲染层显示无法下载的文件消息）
      console.error('[ipc] file upload failed:', e.message);
      return { ok: false, error: String(e.message || e) };
    }

    // 创建文件消息记录
    db.addMessage({
      message_id,
      session_id,
      sender_contact_id: client.client_id,
      content: JSON.stringify({ file_id, file_name, file_size }),
      type: MSG_TYPE.FILE,
      timestamp,
      local_id
    });
    db.addFile({
      file_id,
      message_id,
      file_name,
      file_size,
      storage_path: net.isHosting(session_id) ? net.getFileStorePath(file_id) : null,
      download_status: net.isHosting(session_id) ? FILE_STATUS.COMPLETED : FILE_STATUS.PENDING
    });

    // 广播文件通知给会话成员
    const fileMsg = {
      kind: 'file',
      message_id,
      session_id,
      sender_contact_id: client.client_id,
      sender_nickname: client.nickname,
      sender_ip: net.localIp,
      content: JSON.stringify({ file_id, file_name, file_size }),
      type: MSG_TYPE.FILE,
      timestamp,
      local_id,
      file_id,
      file_name,
      file_size
    };
    if (net.isHosting(session_id)) net.relayToMembers(session_id, fileMsg);
    else if (net.isJoined(session_id)) net.memberSend(session_id, fileMsg);

    return { ok: true, file_id, message_id, timestamp, file_name, file_size, local_id };
  });

  // 断点续传：节流写库的已接收字节，最多每 1s 持久化一次（失败后据此续传）
  const _progressThrottle = new Map(); // file_id -> { lastTs }
  // V18：并行下载参数（提升并发数和降低阈值以获得更好性能）
  // < 1.5MB 走单连接（握手开销 > 并行收益），≥ 1.5MB 走 8 路并行
  const PARALLEL_THRESHOLD = 1.5 * 1024 * 1024;
  const PARALLEL_PARTS = 8;

  // 大文件 4 路并行下载（或续传）。ranges 为本次要传的 part 列表
  function runDownloadParallel(file_id, host_ip, host_port, dest, fileSize, ranges, isResume) {
    if (!isResume) {
      db.setFileParts(file_id, ranges.map((r) => ({ ...r, status: 'downloading' })));
    }
    const partReceived = new Map(); // part_id -> received
    let lastFlush = 0;
    let lastTotal = 0;
    const flushProgress = () => {
      let total = 0;
      for (const r of ranges) total += partReceived.get(r.part_id) || 0;
      lastTotal = total;
      const progress = total / fileSize;
      send(IPC_EVENT.FILE_DOWNLOAD_PROGRESS, { file_id, progress });
      const now = Date.now();
      if (now - lastFlush > 1000) {
        db.updateFileProgress(file_id, total);
        for (const [pid, recv] of partReceived) db.updateFilePartProgress(file_id, pid, recv);
        lastFlush = now;
      }
    };

    net.downloadFileParallel(
      host_ip, host_port, file_id, fileSize, dest, ranges,
      (part_id, received) => {
        partReceived.set(part_id, received);
        flushProgress();
      },
      (err, finalPath, partState) => {
        _progressThrottle.delete(file_id);
        if (err) {
          // 持久化各 part 进度供续传
          for (const p of partState) db.updateFilePartProgress(file_id, p.part_id, p.received || 0);
          db.updateFileProgress(file_id, lastTotal, dest);
          db.updateFileStatus(file_id, FILE_STATUS.FAILED);
          send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, error: String(err) });
        } else {
          db.updateFileStatus(file_id, FILE_STATUS.COMPLETED, finalPath);
          db.updateFileProgress(file_id, 0);
          db.clearFileParts(file_id);
          send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, storage_path: finalPath });
        }
      }
    );
  }

  function runDownload(file_id, host_ip, host_port, dest, offset) {
    db.updateFileStatus(file_id, FILE_STATUS.DOWNLOADING);
    if (offset === 0) db.updateFileProgress(file_id, 0, dest); // 新下载：记录路径 + 重置已接收

    const file = db.getFile(file_id);
    const fileSize = file ? file.file_size : 0;

    // 大文件：4 路并行
    if (fileSize >= PARALLEL_THRESHOLD && offset === 0) {
      const partSize = Math.ceil(fileSize / PARALLEL_PARTS);
      const ranges = [];
      for (let i = 0; i < PARALLEL_PARTS; i++) {
        const start = i * partSize;
        const length = Math.min(partSize, fileSize - start);
        if (length <= 0) break;
        ranges.push({ part_id: i, offset: start, length, received: 0 });
      }
      runDownloadParallel(file_id, host_ip, host_port, dest, fileSize, ranges, false);
      return;
    }

    // 小文件或续传：单连接
    let lastReceived = offset;
    net.downloadFile(host_ip, host_port, file_id, dest, offset,
      (progress, receivedBytes) => {
        lastReceived = receivedBytes;
        send(IPC_EVENT.FILE_DOWNLOAD_PROGRESS, { file_id, progress });
        const now = Date.now();
        const entry = _progressThrottle.get(file_id);
        if (!entry || now - entry.lastTs > 1000) {
          db.updateFileProgress(file_id, receivedBytes);
          _progressThrottle.set(file_id, { lastTs: now });
        }
      },
      (err, finalPath) => {
        _progressThrottle.delete(file_id);
        if (err) {
          // 失败：持久化最终已接收字节 + 保留 storage_path，供续传
          db.updateFileProgress(file_id, lastReceived, dest);
          db.updateFileStatus(file_id, FILE_STATUS.FAILED);
          send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, error: String(err) });
        } else {
          db.updateFileStatus(file_id, FILE_STATUS.COMPLETED, finalPath);
          db.updateFileProgress(file_id, 0); // 完成：重置已接收字节
          send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, storage_path: finalPath });
        }
      }
    );
  }

  // 主机本机下载：文件已在 fileStoreDir 中（成员上传后暂存），直接本地拷贝，无需 TCP 回环
  function runLocalCopy(file_id, dest) {
    db.updateFileStatus(file_id, FILE_STATUS.DOWNLOADING);
    const src = net.getFileStorePath(file_id);
    const fileSize = db.getFile(file_id)?.file_size || 0;
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    let received = 0;
    let lastFlush = 0;
    rs.on('data', (chunk) => {
      received += chunk.length;
      const progress = fileSize > 0 ? received / fileSize : 0;
      send(IPC_EVENT.FILE_DOWNLOAD_PROGRESS, { file_id, progress });
      const now = Date.now();
      if (now - lastFlush > 1000) {
        db.updateFileProgress(file_id, received);
        lastFlush = now;
      }
    });
    rs.on('error', (err) => {
      ws.destroy();
      db.updateFileProgress(file_id, received, dest);
      db.updateFileStatus(file_id, FILE_STATUS.FAILED);
      send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, error: String(err) });
    });
    ws.on('error', (err) => {
      rs.destroy();
      db.updateFileProgress(file_id, received, dest);
      db.updateFileStatus(file_id, FILE_STATUS.FAILED);
      send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, error: String(err) });
    });
    rs.pipe(ws).on('finish', () => {
      db.updateFileStatus(file_id, FILE_STATUS.COMPLETED, dest);
      db.updateFileProgress(file_id, 0);
      db.clearFileParts(file_id);
      send(IPC_EVENT.FILE_DOWNLOAD_PROGRESS, { file_id, progress: 1 });
      send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, storage_path: dest });
    });
  }

  ipcMain.handle(IPC.FILE_DOWNLOAD, async (_e, { file_id, host_ip, host_port }) => {
    // 查找原始文件名
    const fileRow = db.queryOne('SELECT file_name FROM files WHERE file_id = ?', [file_id]);
    const fileName = fileRow?.file_name || file_id;

    // 弹窗让用户选择保存位置
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存文件',
      defaultPath: fileName,
      filters: [{ name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    // 主机本机已有暂存文件：直接本地拷贝
    if (net.fileExistsOnHost(file_id)) {
      runLocalCopy(file_id, result.filePath);
      return { ok: true };
    }
    runDownload(file_id, host_ip, host_port, result.filePath, 0);
    return { ok: true };
  });

  // 断点续传：有 file_parts 记录走多 part 并行续传，否则单连接续传。无有效分片时返回 ok:false 供渲染层回退
  ipcMain.handle(IPC.FILE_RESUME, async (_e, { file_id, host_ip, host_port }) => {
    const file = db.getFile(file_id);
    if (!file) return { ok: false, error: 'file record not found' };
    const dest = file.storage_path;
    if (!dest) return { ok: false, error: 'no storage path' };

    // 主机本机已有暂存文件：直接本地拷贝（源文件完整，无需续传分片）
    if (net.fileExistsOnHost(file_id)) {
      runLocalCopy(file_id, dest);
      return { ok: true };
    }

    // 有 file_parts 记录 → 多 part 并行续传
    const parts = db.listFileParts(file_id);
    if (parts.length > 0) {
      const incomplete = parts.filter((p) => p.received_bytes < p.length);
      if (incomplete.length === 0) return { ok: false, error: 'already complete' };
      // 校验分片文件存在且预分配到全尺寸
      try {
        const stat = fs.statSync(dest);
        if (stat.size < file.file_size) fs.truncateSync(dest, file.file_size);
      } catch {
        return { ok: false, error: 'partial file missing' };
      }
      const ranges = incomplete.map((p) => ({
        part_id: p.part_id, offset: p.offset, length: p.length, received: p.received_bytes
      }));
      db.updateFileStatus(file_id, FILE_STATUS.DOWNLOADING);
      runDownloadParallel(file_id, host_ip, host_port, dest, file.file_size, ranges, true);
      return { ok: true };
    }

    // 无 file_parts → 单连接续传（小文件或旧记录）
    const offset = file.received_bytes || 0;
    if (offset <= 0 || offset >= file.file_size) {
      return { ok: false, error: 'no resumable partial' };
    }
    try {
      const stat = fs.statSync(dest);
      if (stat.size !== offset) {
        return { ok: false, error: 'partial size mismatch' };
      }
    } catch (e) {
      return { ok: false, error: 'partial file missing' };
    }
    runDownload(file_id, host_ip, host_port, dest, offset);
    return { ok: true };
  });

  ipcMain.handle(IPC.FILE_LIST, (_e, message_id) => db.listFiles(message_id));
  ipcMain.handle(IPC.FILE_LIST_SESSION, (_e, session_id) => db.listFilesBySession(session_id));

  // ---- 网络 / 发现 ----
  ipcMain.handle(IPC.NETWORK_GET_DISCOVERED, () => ({
    sessions: net.getDiscoveredSessions(),
    peers: net.getPeers()
  }));

  // ---- 设置 ----
  ipcMain.handle(IPC.SETTINGS_GET, (_e, { key, defaultValue }) => db.getSetting(key, defaultValue ?? null));
  ipcMain.handle(IPC.SETTINGS_SET, (_e, { key, value }) => db.setSetting(key, value));

  // V18：数据库清理（清理 N 天前消息 + VACUUM）
  ipcMain.handle(IPC.DB_CLEANUP, (_e, { days } = {}) => db.cleanupOldMessages(days || 30));
}

module.exports = { init, registerIpcHandlers, net, addAuthorizedFilePath };
