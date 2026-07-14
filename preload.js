// preload: 通过 contextBridge 安全暴露 IPC 能力给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

const invokeChannels = new Set([
  'client:init', 'client:set-nickname',
  'contacts:list', 'contacts:set-alias', 'contacts:delete',
  'session:create', 'session:close', 'session:leave', 'session:delete', 'session:list', 'session:join',
  'message:send', 'message:list',
  'file:upload', 'file:download', 'file:resume', 'file:list', 'file:list-session',
  'network:get-discovered',
  'settings:get', 'settings:set',
  'window:close', 'window:minimize', 'window:maximize', 'window:flash',
  'dialog:open-file',
  'db:cleanup',
  // 桌面通知开关（主进程 Notification 服务）
  'notification:set-enabled'
]);

const eventChannels = new Set([
  'network:session-discovered',
  'network:session-removed',
  'network:presence-update',
  'message:received',
  'file:download-progress',
  'file:download-complete',
  'session:ended',
  'session:created',
  // 桌面通知交互（主进程 → 渲染）
  'notification:clicked',
  'notification:reply'
]);

contextBridge.exposeInMainWorld('api', {
  // 渲染 → 主
  invoke: (channel, ...args) => {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error('Disallowed invoke channel: ' + channel));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  // 主 → 渲染
  on: (channel, callback) => {
    if (!eventChannels.has(channel)) return;
    const wrapped = (_e, ...args) => callback(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  // 窗口控制快捷方法
  window: {
    close: () => ipcRenderer.invoke('window:close'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize')
  },
  // 文件选择对话框
  selectFile: () => ipcRenderer.invoke('dialog:open-file')
});
