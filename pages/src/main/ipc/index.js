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

// V13：昵称/名称后端校验（长度上限 + 去除换行/尖括号）
function sanitizeName(s) {
  return String(s || '').trim().slice(0, 24).replace(/[\r\n<>]/g, '');
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// 接收到远端消息（主机收到成员 / 成员收到主机转发）→ 存库 + 推送渲染
function handleReceivedMessage(msg) {
  try {
    // 幂等：若已存在则跳过
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
          db.addFile({
            file_id: meta.file_id,
            message_id: msg.message_id,
            file_name: meta.file_name,
            file_size: meta.file_size,
            storage_path: null,
            download_status: FILE_STATUS.PENDING
          });
        }
      }
    }
    send(IPC_EVENT.MESSAGE_RECEIVED, {
      message_id: msg.message_id,
      session_id: msg.session_id,
      sender_contact_id: msg.sender_contact_id,
      content: msg.content,
      type: msg.type,
      timestamp: msg.timestamp
    });
  } catch (e) {
    console.error('[ipc] handleReceivedMessage error:', e);
  }
}

function registerNetworkEvents() {
  net.on('session-discovered', (info) => send(IPC_EVENT.SESSION_DISCOVERED, info));
  net.on('session-removed', (info) => send(IPC_EVENT.SESSION_REMOVED, info));
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
      const messages = rows.map((r) => ({
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
      }));
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
      net.joinSession(invite.session_id, invite.host_ip, invite.message_port, (msg) => handleReceivedMessage(msg));
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
  ipcMain.handle(IPC.CONTACTS_TOGGLE_FAVORITE, (_e, contact_id) => {
    db.toggleFavorite(contact_id);
    return db.listContacts();
  });

  // ---- 会话 ----
  ipcMain.handle(IPC.SESSION_CREATE, (_e, { name, type, invitee_ip, invitee_client_id }) => {
    const client = db.getClientInfo();
    const session_id = uuidv4();
    const now = Date.now();
    const session = db.createSession({
      session_id,
      host_contact_id: client.client_id,
      name,
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
    net.joinSession(session_id, host_ip, host_port, (msg) => handleReceivedMessage(msg));
    // 本地记录会话：不存在则新建，已存在（如 ended 状态）则重置为 active 保留消息历史
    const existing = db.getSession(session_id);
    if (!existing) {
      const discovered = net.discoveredSessions.get(session_id);
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
  ipcMain.handle(IPC.MESSAGE_SEND, (_e, { session_id, content, type }) => {
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
    if (net.isHosting(session_id)) {
      net.relayToMembers(session_id, msg);
    } else if (net.isJoined(session_id)) {
      net.memberSend(session_id, msg);
    }
    return { message_id, timestamp, local_id };
  });

  ipcMain.handle(IPC.MESSAGE_LIST, (_e, session_id) => db.listMessages(session_id));

  // ---- 文件 ----
  ipcMain.handle(IPC.FILE_UPLOAD, async (_e, { session_id, file_path }) => {
    const client = db.getClientInfo();
    const stat = fs.statSync(file_path);
    const file_id = uuidv4();
    const message_id = uuidv4();
    const local_id = uuidv4();
    const timestamp = Date.now();
    const file_name = path.basename(file_path);
    const file_size = stat.size;

    if (net.isHosting(session_id)) {
      // 本机即主机：本地暂存
      await new Promise((res, rej) => {
        net.storeLocalFile(file_id, file_path, (e) => (e ? rej(e) : res()));
      });
    } else if (net.isJoined(session_id)) {
      // 成员：上传到主机暂存
      await new Promise((res, rej) => {
        net.uploadFileToHost(session_id, { file_id, file_name, file_size, file_path }, (e) =>
          e ? rej(e) : res()
        );
      });
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

    return { file_id, message_id, timestamp };
  });

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
    const dest = result.filePath;

    db.updateFileStatus(file_id, FILE_STATUS.DOWNLOADING);
    net.downloadFile(host_ip, host_port, file_id, dest,
      (progress) => send(IPC_EVENT.FILE_DOWNLOAD_PROGRESS, { file_id, progress }),
      (err, finalPath) => {
        if (err) {
          db.updateFileStatus(file_id, FILE_STATUS.FAILED);
          send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, error: String(err) });
        } else {
          db.updateFileStatus(file_id, FILE_STATUS.COMPLETED, finalPath);
          send(IPC_EVENT.FILE_DOWNLOAD_COMPLETE, { file_id, storage_path: finalPath });
        }
      }
    );
    return { ok: true };
  });

  ipcMain.handle(IPC.FILE_LIST, (_e, message_id) => db.listFiles(message_id));

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

module.exports = { init, registerIpcHandlers, net };
