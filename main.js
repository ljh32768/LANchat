// Electron 主进程入口
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { init, registerIpcHandlers, net, addAuthorizedFilePath } = require('./pages/src/main/ipc');
const db = require('./pages/src/main/db/database');
const notificationService = require('./pages/src/main/notificationService');

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

// ---- Windows：必须在 app ready 之前设置 AppUserModelId ----
// 否则通知中心/Toast 会显示为 "Electron" 或缺少应用图标与名称。
// 值应与 package.json 中 build.appId 保持一致。
if (process.platform === 'win32') {
  app.setAppUserModelId('com.lanchatroom.app');
}

// userData 目录：开发环境用项目内 data/，打包后用系统标准目录
if (isDev) {
  const userDataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
}

// 日志重定向：console.log/error 同时写入 userData/net.log（打包后无控制台，靠这个看日志）
{
  const logPath = path.join(app.getPath('userData'), 'net.log');
  try { fs.writeFileSync(logPath, ''); } catch {} // 每次启动清空
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const writeLine = (prefix, args) => {
    const line = `[${new Date().toISOString()}] ${prefix} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
    try { fs.appendFileSync(logPath, line); } catch {}
  };
  console.log = (...args) => { origLog(...args); writeLine('LOG ', args); };
  console.error = (...args) => { origErr(...args); writeLine('ERR ', args); };
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    frame: false,          // 无边框，自绘标准矩形标题栏
    transparent: false,     // 不透明背景，标准矩形窗口
    thickFrame: false,      // 移除 Windows WS_THICKFRAME resize 边框，内容区填满物理窗口
    hasShadow: false,       // 禁用 DWM 系统窗口阴影，消除隐形边界
    resizable: true,
    show: false,
    backgroundColor: '#FFFFFF',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
      },
    icon: path.join(__dirname, 'icon.ico')
  });

  // 开发环境加载 Vite dev server，生产环境加载打包后的 index.html
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // DevTools 改为手动按 F12 / Ctrl+Shift+I 打开，避免开发时干扰界面
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 捕获渲染进程控制台日志，输出到主进程终端（便于调试）
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    console.log(`[renderer:${tag}] ${message} (${source}:${line})`);
  });
  // 捕获渲染进程崩溃
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer:gone]', JSON.stringify(details));
  });

  // 外部链接用系统浏览器打开（仅允许 http/https 协议，阻断 file:///javascript: 等）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // V26：生产环境拦截 DevTools 快捷键（F12 / Ctrl+Shift+I / Ctrl+J）
  // 保留 Ctrl+R 供崩溃后恢复使用
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (
        input.key === 'F12' ||
        (input.control && input.shift && (input.key === 'I' || input.key === 'i')) ||
        (input.control && (input.key === 'J' || input.key === 'j'))
      ) {
        event.preventDefault();
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 窗口创建后同步给通知服务（ipc.init 会再次 init；此处覆盖重建窗口场景）
  notificationService.setMainWindow(mainWindow);
}

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 与点击通知一致：恢复最小化并强制聚焦
    notificationService.focusMainWindow();
  });

  app.whenReady().then(async () => {
    registerIpcHandlers();
    createWindow();
    // 窗口控制 + 文件选择对话框
    ipcMain.handle('window:close', () => mainWindow && mainWindow.close());
    ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
    ipcMain.handle('window:maximize', () => {
      if (!mainWindow) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    });
    ipcMain.handle('window:flash', () => {
      if (mainWindow && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
        setTimeout(() => mainWindow && mainWindow.flashFrame(false), 3000);
      }
    });
    ipcMain.handle('dialog:open-file', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择要发送的文件',
        properties: ['openFile'],
        filters: [{ name: '所有文件', extensions: ['*'] }]
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      // 授权路径：file:upload 只接受通过对话框选择的路径
      addAuthorizedFilePath(result.filePaths[0]);
      return result.filePaths[0];
    });
    // 初始化数据库与网络（mainWindow 就绪后）
    // 桌面通知服务在 ipc.init 内绑定窗口 + macOS 快捷回复回调
    if (mainWindow) {
      await init(mainWindow);
    }

    app.on('activate', async () => {
      // macOS：点击 Dock 图标时若无窗口则重建，并重新绑定通知服务
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        if (mainWindow) await init(mainWindow);
      } else {
        notificationService.focusMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前强制落盘 + 清理网络资源（防抖 500ms 内的写入不会丢失）
app.on('before-quit', () => {
  try { db.persistNow(); } catch {}
  try { net.stop(); } catch {}
  try { notificationService.dispose(); } catch {}
});
