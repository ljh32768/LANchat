/**
 * 跨平台桌面通知服务（主进程）
 *
 * 能力：
 * 1. 窗口聚焦时不打扰（不弹通知）
 * 2. 点击通知 → 恢复/聚焦主窗口
 * 3. 同一发送者短时间内多条消息聚合（防轰炸）
 * 4. Windows：依赖 main.js 中设置的 AppUserModelId 显示应用名/图标
 * 5. macOS：支持通知中心「快捷回复」(hasReply)
 * 6. Linux：使用 Electron 标准 Notification API
 *
 * 使用方式：
 *   const notif = require('./notificationService');
 *   notif.init(mainWindow, { onReply });
 *   notif.notifyNewMessage({ session_id, sender_contact_id, sender_nickname, content, type });
 */

const { Notification, app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// ---- 可调参数 ----
/** 同一发送者消息聚合窗口（毫秒）：窗口内只维护一条通知并更新计数 */
const AGGREGATE_WINDOW_MS = 5000;
/** 通知正文最大预览长度 */
const BODY_PREVIEW_LEN = 80;
/** 聚合状态过期后清理（防止 Map 泄漏） */
const AGGREGATE_TTL_MS = 60000;

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;

/**
 * 快捷回复回调（macOS）
 * @type {((payload: { session_id: string, content: string, reply_to?: string }) => void) | null}
 */
let onReplyHandler = null;

/** 是否启用桌面通知（可被设置覆盖） */
let enabled = true;

/**
 * 聚合状态：key = `${session_id}::${sender_contact_id}`
 * value = {
 *   count: number,
 *   lastContent: string,
 *   senderName: string,
 *   sessionId: string,
 *   senderId: string,
 *   notification: Electron.Notification | null,
 *   timer: NodeJS.Timeout | null,
 *   lastAt: number
 * }
 */
const aggregates = new Map();

// ---- 工具 ----

function isWindowFocused() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // 可见且未最小化且拥有焦点 → 用户正在看，不弹通知
  try {
    return mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
  } catch {
    return false;
  }
}

/**
 * 将主窗口从最小化/隐藏恢复并聚焦
 * 用于：点击通知、second-instance、快捷回复后可选聚焦
 */
function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    // Windows 上偶发 focus 无效：先置顶再取消，强制抢焦点
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show();
    }
  } catch (e) {
    console.error('[notification] focusMainWindow error:', e);
  }
}

/**
 * 解析通知图标路径
 * Windows 可用 .ico；macOS/Linux 更推荐 PNG。
 * 项目根目录目前提供 icon.ico，若不存在 PNG 则回退 ico。
 */
function resolveIcon() {
  // 打包后 resources 路径：从 main 模块向上找项目根
  const candidates = [
    path.join(app.getAppPath(), 'icon.png'),
    path.join(app.getAppPath(), 'icon.ico'),
    path.join(__dirname, '..', '..', '..', 'icon.png'),
    path.join(__dirname, '..', '..', '..', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(process.resourcesPath || '', 'icon.ico')
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined;
}

function truncate(text, max = BODY_PREVIEW_LEN) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function previewContent(msg) {
  if (!msg) return '';
  if (msg.type === 'file') {
    let name = '';
    try {
      const meta = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      name = meta?.file_name || '';
    } catch {}
    return name ? `[文件] ${name}` : '[文件]';
  }
  return truncate(msg.content || '');
}

function aggregateKey(sessionId, senderId) {
  return `${sessionId || 'unknown'}::${senderId || 'unknown'}`;
}

function clearAggregate(key) {
  const entry = aggregates.get(key);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  // 不主动 close 系统通知中心条目（用户可能还在看），只清本地引用
  entry.notification = null;
  aggregates.delete(key);
}

function scheduleAggregateCleanup(key) {
  const entry = aggregates.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => clearAggregate(key), AGGREGATE_TTL_MS);
}

/**
 * 创建并展示一条系统通知
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} opts.sessionId
 * @param {string} opts.senderId
 * @param {string} [opts.senderName]
 */
function showNotification({ title, body, sessionId, senderId, senderName }) {
  // 运行时能力检测：Linux 上部分桌面环境可能不支持
  if (!Notification.isSupported()) {
    console.warn('[notification] Notification API not supported on this system');
    return null;
  }

  const iconPath = resolveIcon();
  /** @type {Electron.NotificationConstructorOptions} */
  const options = {
    title: title || 'LANChatroom',
    body: body || '',
    // silent: true → 系统不播默认提示音，由渲染进程 playMessageSound 统一控制声音
    silent: true,
    // Windows Toast 用 tag 有助于同 tag 替换；Electron 会尽量映射
    // 注意：部分平台忽略 timeoutType
    timeoutType: 'default'
  };

  if (iconPath) {
    try {
      // nativeImage 兼容性更好；失败则退回路径字符串
      const img = nativeImage.createFromPath(iconPath);
      options.icon = img.isEmpty() ? iconPath : img;
    } catch {
      options.icon = iconPath;
    }
  }

  // ---- macOS：通知中心快捷回复 ----
  // hasReply 仅在 darwin 生效；其他平台会被忽略
  if (process.platform === 'darwin') {
    options.hasReply = true;
    options.replyPlaceholder = '回复消息…';
    // 可选：额外操作按钮（macOS 10.14+）
    options.actions = [{ type: 'button', text: '打开会话' }];
  }

  // ---- Windows：urgency / toast 行为 ----
  // Electron 在 win 上会走 Action Center；AppUserModelId 必须在 app ready 前设置
  if (process.platform === 'win32') {
    options.urgency = 'normal';
  }

  // ---- Linux：保持最简选项，依赖 libnotify ----
  // 不设置 hasReply / actions，避免部分 DE 异常

  let notification;
  try {
    notification = new Notification(options);
  } catch (e) {
    console.error('[notification] create failed:', e);
    return null;
  }

  // 点击通知主体 → 恢复窗口
  notification.on('click', () => {
    focusMainWindow();
    // 通知渲染进程：可切换到对应会话
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notification:clicked', {
          session_id: sessionId,
          sender_contact_id: senderId
        });
      }
    } catch {}
  });

  // macOS 快捷回复
  notification.on('reply', (_event, reply) => {
    const text = String(reply || '').trim();
    if (!text) return;
    focusMainWindow();
    const payload = {
      session_id: sessionId,
      content: text,
      reply_to: senderId,
      sender_nickname: senderName
    };
    // 1) 业务回调（主进程可直接发消息）
    try {
      if (typeof onReplyHandler === 'function') onReplyHandler(payload);
    } catch (e) {
      console.error('[notification] onReply handler error:', e);
    }
    // 2) 同时推给渲染进程（便于 UI 同步）
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notification:reply', payload);
      }
    } catch {}
  });

  // macOS 操作按钮（「打开会话」）
  notification.on('action', () => {
    focusMainWindow();
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notification:clicked', {
          session_id: sessionId,
          sender_contact_id: senderId
        });
      }
    } catch {}
  });

  notification.on('failed', (_e, error) => {
    console.error('[notification] show failed:', error);
  });

  try {
    notification.show();
  } catch (e) {
    console.error('[notification] show() error:', e);
    return null;
  }

  return notification;
}

// ---- 公开 API ----

/**
 * 初始化通知服务
 * @param {import('electron').BrowserWindow} win 主窗口
 * @param {{ onReply?: Function, enabled?: boolean }} [options]
 */
function init(win, options = {}) {
  mainWindow = win;
  if (typeof options.onReply === 'function') {
    onReplyHandler = options.onReply;
  }
  if (typeof options.enabled === 'boolean') {
    enabled = options.enabled;
  }

  // 窗口销毁时清理引用，避免悬空
  if (win && !win.isDestroyed()) {
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
  }

  console.log(
    `[notification] init platform=${process.platform} supported=${Notification.isSupported()}`
  );
}

/**
 * 更新主窗口引用（热重载 / 重建窗口时调用）
 */
function setMainWindow(win) {
  mainWindow = win;
}

/**
 * 开关桌面通知
 */
function setEnabled(v) {
  enabled = !!v;
}

function isEnabled() {
  return enabled;
}

/**
 * 收到新聊天消息时调用（主进程消息入口）
 * @param {object} msg
 * @param {string} msg.session_id
 * @param {string} msg.sender_contact_id
 * @param {string} [msg.sender_nickname]
 * @param {string} [msg.content]
 * @param {string} [msg.type] text | file
 * @param {string} [msg.source] live | history — history 不通知
 */
function notifyNewMessage(msg) {
  if (!enabled) return;
  if (!msg || msg.source === 'history') return;
  // 自己发的消息不通知（若上游误传）
  // 聚焦时不打扰
  if (isWindowFocused()) return;
  if (!Notification.isSupported()) return;

  const sessionId = msg.session_id;
  const senderId = msg.sender_contact_id || 'unknown';
  const senderName = (msg.sender_nickname || '有人').trim() || '有人';
  const key = aggregateKey(sessionId, senderId);
  const now = Date.now();
  const bodyPreview = previewContent(msg);

  let entry = aggregates.get(key);
  const withinWindow = entry && now - entry.lastAt <= AGGREGATE_WINDOW_MS;

  if (withinWindow) {
    entry.count += 1;
    entry.lastContent = bodyPreview;
    entry.lastAt = now;
    entry.senderName = senderName;
    // 关闭旧 toast，用聚合文案重弹（各平台对“更新”支持不一，重弹最稳妥）
    try {
      if (entry.notification) entry.notification.close();
    } catch {}
  } else {
    entry = {
      count: 1,
      lastContent: bodyPreview,
      senderName,
      sessionId,
      senderId,
      notification: null,
      timer: null,
      lastAt: now
    };
    aggregates.set(key, entry);
  }

  const title = entry.senderName;
  const body =
    entry.count > 1
      ? `收到 ${entry.count} 条新消息：${entry.lastContent || ''}`.trim()
      : entry.lastContent || '发来一条新消息';

  entry.notification = showNotification({
    title,
    body,
    sessionId,
    senderId,
    senderName
  });
  scheduleAggregateCleanup(key);
}

/**
 * 手动展示一条通用通知（非聊天聚合场景）
 */
function notify({ title, body, sessionId, senderId }) {
  if (!enabled) return;
  if (isWindowFocused()) return;
  showNotification({
    title: title || 'LANChatroom',
    body: body || '',
    sessionId: sessionId || '',
    senderId: senderId || ''
  });
}

/**
 * 应用退出前清理
 */
function dispose() {
  for (const key of [...aggregates.keys()]) clearAggregate(key);
  mainWindow = null;
  onReplyHandler = null;
}

module.exports = {
  init,
  setMainWindow,
  setEnabled,
  isEnabled,
  notifyNewMessage,
  notify,
  focusMainWindow,
  isWindowFocused,
  dispose,
  // 导出常量便于测试/调优
  AGGREGATE_WINDOW_MS
};
