# LANChatroom

> 一款基于局域网的 P2P 聊天应用，重拾 space age 的通信体验。

## ✨ 特性

- 🌐 **局域网 P2P 聊天** - 无需服务器，同一局域网内直接点对点通信
- 📁 **文件传输** - 支持发送文件到任意在线用户
- 👥 **联系人管理** - 添加好友、设置别名、收藏常用联系人
- 💬 **私聊会话** - 一对一私聊，支持会话管理
- 🔔 **在线状态** - 实时显示用户在线状态
- 🎨 **透明窗口** - 无边框异形窗口，CSS 自绘 UI
- 💾 **本地存储** - 使用 sql.js 存储本地数据，隐私安全
- 📦 **单机部署** - 无需配置服务器，开箱即用

## 技术栈

### 前端
- **Electron** - 桌面应用框架
- **React 19** - UI 框架
- **Vite** - 构建工具
- **React Router** - 路由管理
- **React Window** - 滚动容器
- **Zustand** - 状态管理
- **sql.js** - SQLite WebAssembly 实现

### 网络层
- **UDP P2P** - 局域网点对点通信
- **UUID** - 唯一标识符

## 系统要求

- Windows 10/11
- macOS 10.14+
- Linux (推荐 Ubuntu 20.04+)

## 安装

### 前置要求

- Node.js 18+ (推荐 20.x LTS)
- npm 或 yarn

### 克隆项目

```bash
git clone https://github.com/ljh32768/LANChatroom.git
cd LANChatroom
```

### 安装依赖

```bash
npm install
```

## 开发

### 启动开发服务器

```bash
npm run dev
```

这会同时启动 Vite 开发服务器和 Electron 主进程。

### 仅启动主进程

```bash
npm start
```

### 构建项目

```bash
npm run build
```

## 使用

### 首次运行

1. 启动应用后会进入登录界面
2. 输入昵称并选择一个头像
3. 点击"加入局域网"开始使用

### 基本操作

- **发送消息** - 在聊天窗口输入消息，按回车发送
- **文件传输** - 点击聊天窗口顶部的"发送文件"按钮选择文件
- **添加好友** - 在右侧联系人列表点击"添加好友"输入好友的设备 ID
- **切换聊天** - 点击左侧联系人列表切换聊天会话
- **窗口控制** - 点击窗口右上角图标最小化/最大化/关闭

### 密钥特性

#### 邀请好友

1. 进入设置面板
2. 点击"显示设备 ID"
3. 将设备 ID 发送给好友
4. 在好友的联系人列表点击"添加好友"粘贴设备 ID

#### 文件传输

- 支持发送任意文件到在线好友
- 文件会自动分割并断点续传
- 接收文件会自动保存到默认下载目录

#### 在线状态

- 用户上线后，"在线"状态会实时同步
- 离线后，状态会在一段时间后更新为"离线"

## 项目结构

```
LANChatroom/
├── main.js              # Electron 主进程入口
├── preload.js           # 预加载脚本（IPC 桥接）
├── vite.config.js       # Vite 构建配置
├── package.json         # 项目依赖和脚本
├── pages/
│   └── src/
│       ├── main/        # 主进程代码
│       │   ├── db/      # 数据库操作
│       │   ├── ipc/     # IPC 处理器
│       │   └── network/ # UDP P2P 网络通信
│       ├── renderer/    # 渲染进程代码（React）
│       │   ├── components/  # UI 组件
│       │   ├── hooks/       # 自定义 Hooks
│       │   ├── stores/      # Zustand 状态管理
│       │   └── utils/       # 工具函数
│       └── shared/      # 共享代码
├── assets/              # 资源文件（图片、图标等）
├── dist/                # Vite 构建输出
├── data/                # 开发环境数据目录
└── docs/                # 项目文档
```

## 构建发布

### Windows 安装包

```bash
# NSIS 安装包
npm run dist:nsis

# 便携版
npm run dist:portable
```

安装包将生成在 `dist-build/` 目录。

### 构建选项

在 `package.json` 中可配置：

- `appId` - 应用唯一标识符
- `productName` - 应用名称
- `nsis` - NSIS 安装器选项
- `compression` - 压缩级别（maximum/default/minimal）

## 开发说明

### 日志

应用会记录日志到 `userData/net.log`：
- 开发环境：`data/net.log`
- 生产环境：系统标准用户数据目录下的 `net.log`

### 数据库

使用 sql.js 实现，数据存储在：
- 开发环境：`data/lanchat.db`
- 生产环境：用户数据目录下的 `lanchat.db`

数据库包含以下表：
- `contacts` - 联系人信息
- `sessions` - 会话记录
- `messages` - 消息记录
- `files` - 文件记录

### 网络协议

应用使用 UDP P2P 通信，无需服务器：

1. **设备发现** - 广播自己的存在
2. **用户连接** - 基于设备 ID 建立连接
3. **消息传输** - UDP 分片传输
4. **在线状态** - 心跳包保持状态

### 窗口设计

窗口特性：
- 透明背景（`transparent: true`）
- 无边框（`frame: false`）
- 自定义标题栏（使用自定义组件）
- 响应式布局

## 常见问题

### Q: 无法发现其他用户？

**A:** 确保所有设备在同一局域网，并允许防火墙通过 UDP 端口。检查应用日志 `net.log` 获取详细信息。

### Q: 文件传输失败？

**A:** 检查：
- 接收方是否在线
- 防火墙是否阻止 UDP 通信
- 磁盘空间是否充足

### Q: 如何备份数据？

**A:** 复制 `data/lanchat.db` 文件即可（开发环境）或用户数据目录下的对应文件（生产环境）。

## 开发路线图

- [ ] 聊室（群聊）功能
- [ ] 消息加密
- [ ] 语音/视频通话
- [ ] 离线消息
- [ ] 消息撤回
- [ ] 多语言支持

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License

## 致谢

- [Electron](https://www.electronjs.org/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [sql.js](https://github.com/sql-js/sql.js)

---

Made with ❤️ by ljh32768 with AI 
