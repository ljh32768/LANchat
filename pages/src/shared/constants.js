// Shared constants for main + renderer. CommonJS so both can require it.

// ---- Network ----
const UDP_BROADCAST_PORT = 47831;      // 固定广播端口
const UDP_BROADCAST_INTERVAL_MS = 3000; // 广播自身状态间隔
const UDP_PEER_TIMEOUT_MS = 9000;      // 超过该时间未收到广播视为离线
const TCP_MESSAGE_PORT_BASE = 47840;   // 会话消息 TCP 端口起始（主机监听）
const TCP_FILE_PORT_BASE = 47890;      // 文件传输 TCP 端口起始（主机监听）

// ---- Broadcast packet types ----
const PACKET = {
  PRESENCE: 'presence',       // 在线状态 + 会话列表
  SESSION_END: 'session_end', // 会话结束通知
  PRIVATE_INVITE: 'private_invite', // 私聊邀请（单播）：主机 → 成员
  PRIVATE_REQUEST: 'private_request' // 私聊请求（单播）：非主机方点击时请求对方建主机
};

// ---- Message types ----
const MSG_TYPE = {
  TEXT: 'text',
  FILE: 'file'
};

// ---- Session types / status ----
const SESSION_TYPE = {
  GROUP: 'group',
  PRIVATE: 'private'
};
const SESSION_STATUS = {
  ACTIVE: 'active',
  ENDED: 'ended'
};

// ---- File download status ----
const FILE_STATUS = {
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// ---- IPC channels: renderer -> main (invoke) ----
const IPC = {
  // 客户端
  CLIENT_INIT: 'client:init',
  CLIENT_SET_NICKNAME: 'client:set-nickname',
  // 联系人
  CONTACTS_LIST: 'contacts:list',
  CONTACTS_SET_ALIAS: 'contacts:set-alias',
  CONTACTS_DELETE: 'contacts:delete',
  // 会话
  SESSION_CREATE: 'session:create',
  SESSION_OPEN_PRIVATE: 'session:open-private', // 打开/创建与某联系人的私聊（确定性 id）
  SESSION_CLOSE: 'session:close', // 主机关闭会话（会话结束，通知所有成员）
  SESSION_LEAVE: 'session:leave', // 成员退出会话（仅自己离开，会话继续）
  SESSION_DELETE: 'session:delete', // 删除已结束会话（级联清理消息+文件记录）
  SESSION_LIST: 'session:list',
  SESSION_JOIN: 'session:join', // 加入已发现会话
  // 消息
  MESSAGE_SEND: 'message:send',
  MESSAGE_LIST: 'message:list',
  // 文件
  FILE_UPLOAD: 'file:upload',
  FILE_DOWNLOAD: 'file:download',
  FILE_RESUME: 'file:resume',
  FILE_LIST: 'file:list',
  FILE_LIST_SESSION: 'file:list-session',
  // 网络 / 发现
  NETWORK_GET_DISCOVERED: 'network:get-discovered',
  // 设置
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // 数据库维护
  DB_CLEANUP: 'db:cleanup'
};

// ---- IPC channels: main -> renderer (send) ----
const IPC_EVENT = {
  SESSION_DISCOVERED: 'network:session-discovered',
  SESSION_REMOVED: 'network:session-removed',
  PRESENCE_UPDATE: 'network:presence-update', // 在线用户/会话成员变化
  MESSAGE_RECEIVED: 'message:received',
  FILE_DOWNLOAD_PROGRESS: 'file:download-progress',
  FILE_DOWNLOAD_COMPLETE: 'file:download-complete',
  SESSION_ENDED: 'session:ended',
  SESSION_CREATED: 'session:created' // 本地新建会话（如收到私聊邀请自动加入）
};

module.exports = {
  UDP_BROADCAST_PORT,
  UDP_BROADCAST_INTERVAL_MS,
  UDP_PEER_TIMEOUT_MS,
  TCP_MESSAGE_PORT_BASE,
  TCP_FILE_PORT_BASE,
  PACKET,
  MSG_TYPE,
  SESSION_TYPE,
  SESSION_STATUS,
  FILE_STATUS,
  IPC,
  IPC_EVENT
};
