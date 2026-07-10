# 修复局域网 UDP peer 发现失效（多台电脑无法互相发现）

## 摘要

项目当前在「同局域网多台电脑」环境下无法发现对方用户与会话。经排查，网络通信模块的 UDP 发现层存在三个根因，按可能性排序：

1. **Windows 防火墙拦截入站 UDP 47831**（最可能）：每台机器都能发出广播，但无法接收他人广播，导致双向发现失败。
2. **广播到 `255.255.255.255` 在多网卡机器上不可靠**：有限广播地址只走默认路由接口，若机器装有 Docker/Hyper-V/VMware/WSL 等虚拟网卡，广播会从虚拟接口发出，到不了真实局域网。
3. **`getLocalIp()` 选错网卡**：返回第一个非 internal IPv4，无物理网卡优先策略，可能取到虚拟网卡 IP，导致私聊邀请中的 `host_ip` 指向不可达地址。

本计划修复发现层的上述三个问题，并增加一个启动诊断能力，帮助用户快速定位剩余环境问题（如防火墙）。

---

## 当前状态分析

### 相关文件与关键代码位置

| 文件 | 关键位置 | 现状 |
|------|----------|------|
| `pages/src/main/network/network.js` | 行 19-27 `getLocalIp()` | 遍历 `os.networkInterfaces()`，返回第一个非 internal IPv4，无优先级 |
| 同上 | 行 74-83 UDP socket 初始化 | `dgram.createSocket({type:'udp4', reuseAddr:true})`，`bind(47831)` 绑定到 `0.0.0.0`，`setBroadcast(true)` |
| 同上 | 行 101-126 `_broadcastPresence()` | 构造 PRESENCE 包，`udpSocket.send(..., UDP_BROADCAST_PORT, '255.255.255.255')` 单目标广播 |
| 同上 | 行 128-180 `_onUdpMessage()` | 用 `packet.client_id === this.clientInfo.client_id` 过滤自包（可靠，不依赖 IP）；用 `rinfo.address` 作为 peer IP（可靠） |
| 同上 | 行 183-200 `sendPrivateInvite()` | `host_ip: this.localIp` —— 若 `localIp` 是虚拟网卡 IP，私聊邀请指向不可达地址 |
| `pages/src/shared/constants.js` | 行 4-8 | `UDP_BROADCAST_PORT=47831` 等常量 |
| `pages/src/main/ipc/index.js` | 行 391-394 `NETWORK_GET_DISCOVERED` | 现有获取已发现 peers/sessions 的 IPC |

### 根因详解

**根因 A：广播目标单一且为有限广播地址**
`network.js:125` 仅向 `255.255.255.255` 发送。该地址是「有限广播」，不会被路由器转发，且在多宿主机器上**只从默认路由对应的接口发出**。如果默认路由指向虚拟网卡（Docker 的 `docker0`、WSL 的 `vEthernet (WSL)`、Hyper-V 的 `vEthernet (Default Switch)` 等），广播就到不了物理局域网。

**根因 B：`getLocalIp()` 无物理网卡优先策略**
`network.js:19-27` 遍历 `os.networkInterfaces()` 的 `Object.keys()` 顺序，Windows 上虚拟网卡常排在物理网卡之前。返回错误 IP 的后果：
- `localIp` 写入 PRESENCE 包的 `ip` 字段（影响小，接收方用 `rinfo.address`）
- `localIp` 作为 `sendPrivateInvite` 的 `host_ip`（影响大，私聊邀请指向不可达 IP，即使发现成功私聊也连不上）
- 用于自包过滤？否，自包过滤用 `client_id`，不受影响

**根因 C：Windows 防火墙拦截入站 UDP**
这是 Electron 应用跨机通信最常见的坑。开发态应用没有签名，Windows 防火墙默认拦截其入站 UDP。表现：每台机器都在发广播，但谁都收不到别人的。同机多开能发现（loopback 不经防火墙），跨机不行。

---

## 提议的改动

### 改动 1：多接口定向广播（network.js）

**文件**：`pages/src/main/network/network.js`

**做什么**：新增 `getBroadcastTargets()` 方法，收集本机所有非 internal IPv4 接口，对每个接口计算其子网定向广播地址（`ip | ~netmask`），返回 `[{ip, broadcast, name}]` 列表。修改 `_broadcastPresence()`，将单个 `255.255.255.255` 发送改为遍历所有定向广播地址逐一发送，并保留 `255.255.255.255` 作为兜底。

**为什么**：定向广播会从对应的具体网卡发出，确保物理局域网接口一定能收到广播，彻底解决多网卡下广播走错接口的问题。

**怎么做**：
1. 新增工具函数 `getLocalInterfaces()`：遍历 `os.networkInterfaces()`，过滤 `internal`、非 IPv4、以及已知虚拟网卡名（见改动 2 的过滤名单），返回 `[{name, address, netmask}]`。
2. 新增 `getBroadcastTargets()`：对 `getLocalInterfaces()` 每项计算 `broadcast = intToIp(ipToInt(address) | ~ipToInt(netmask))`，返回含广播地址的列表。
3. 修改 `_broadcastPresence()` 第 124-125 行：
   ```js
   const msg = Buffer.from(JSON.stringify(packet));
   const targets = this.getBroadcastTargets();
   for (const t of targets) {
     this.udpSocket.send(msg, 0, msg.length, UDP_BROADCAST_PORT, t.broadcast);
   }
   // 兜底：有限广播
   this.udpSocket.send(msg, 0, msg.length, UDP_BROADCAST_PORT, '255.255.255.255');
   ```
4. `ipToInt` / `intToIp` 用标准 Buffer 转换实现，避免引入依赖。

### 改动 2：`getLocalIp()` 优先物理网卡（network.js）

**文件**：`pages/src/main/network/network.js`

**做什么**：重写 `getLocalIp()`，增加虚拟网卡名过滤与物理网卡优先策略。同步新增 `getAllLocalIps()` 供改动 1 复用。

**为什么**：确保 `localIp`（用于私聊邀请 `host_ip`）指向真实局域网 IP，而非虚拟网卡 IP。

**怎么做**：
1. 定义虚拟网卡名匹配正则（不区分大小写）：
   - `vmware`、`virtualbox`、`vbox`
   - `docker`、`wsl`、`vethernet`（Hyper-V/WSL 的 vEthernet 适配器）
   - `tap-windows`、`tun`、`openvpn`
   - `loopback pseudo`、`bluetooth`、`radius`
2. `getLocalInterfaces()` 过滤掉匹配上述正则的网卡名。
3. `getLocalIp()` 在过滤后的列表中，优先选择名称含 `ethernet`、`wi-fi`、`wlan`、`以太网`、`无线` 的网卡；若无匹配则取第一个。
4. 保留 `127.0.0.1` 作为最终兜底。

### 改动 3：UDP socket 显式绑定到所有接口 + 增强 error 日志（network.js）

**文件**：`pages/src/main/network/network.js`

**做什么**：将 `udpSocket.bind(UDP_BROADCAST_PORT)` 显式改为 `udpSocket.bind(UDP_BROADCAST_PORT, '0.0.0.0')`；在 `udpSocket.on('error')` 中打印更详细的错误码（如 `EADDRINUSE`、`EACCES`）。

**为什么**：当前省略 bind 地址时默认也是 `0.0.0.0`，但显式写出可避免歧义；`EACCES` 错误码能提示用户端口被占用或权限不足（Windows 上 47831 若被其他进程占用会报 `EADDRINUSE`，若被策略限制会报 `EACCES`）。

**怎么做**：修改 `network.js:79` 为 `this.udpSocket.bind(UDP_BROADCAST_PORT, '0.0.0.0', () => {...})`；增强 `error` 回调输出 `e.code` 与 `e.message`。

### 改动 4：发现层启动诊断 + 防火墙提示（network.js + ipc/index.js + 渲染层）

**文件**：
- `pages/src/main/network/network.js`
- `pages/src/main/ipc/index.js`
- `pages/src/shared/constants.js`（新增 IPC 通道常量）
- `preload.js`（白名单新增 `network:diagnostic`）

**做什么**：新增 `network:diagnostic` IPC invoke 通道，返回当前网络发现状态快照；在渲染层增加一个简易诊断入口（设置页或发现列表的「刷新/诊断」按钮），展示：检测到的本机 IP 列表、广播目标列表、UDP socket 绑定状态、已发现 peers 数量、自环测试结果。若启动 10 秒后自环成功但 peers 为空，提示用户检查 Windows 防火墙是否放行 UDP 47831。

**为什么**：跨机发现问题中，防火墙是高频根因，但代码层面无法自动添加防火墙规则（需管理员权限）。提供诊断信息让用户能自助确认是「广播没发出」还是「广播发出但被防火墙拦了」。

**怎么做**：
1. `constants.js` 的 `IPC` 对象新增 `NETWORK_DIAGNOSTIC: 'network:diagnostic'`。
2. `preload.js` 白名单新增 `'network:diagnostic'`。
3. `network.js` 新增 `diagnose()` 方法，返回：
   ```js
   {
     localIp: this.localIp,
     allInterfaces: getLocalInterfaces(),
     broadcastTargets: this.getBroadcastTargets(),
     udpBound: !!this.udpSocket,
     peersCount: this.peers.size,
     discoveredSessionsCount: this.discoveredSessions.size,
     selfLoopSeen: this._selfLoopSeen, // 是否收到过自己的广播
     uptimeMs: Date.now() - this._startedAt
   }
   ```
4. `network.js` 的 `start()` 记录 `this._startedAt = Date.now()` 和 `this._selfLoopSeen = false`；在 `_onUdpMessage` 收到自己的包（被 client_id 过滤前）时置 `this._selfLoopSeen = true`。注意：当前第 131 行直接 return，需在 return 前置位。
5. `ipc/index.js` 新增 `NETWORK_DIAGNOSTIC` handler 调用 `net.diagnose()`。
6. 渲染层：在发现列表为空时显示提示文案「未发现其他用户。若你处于多台电脑的局域网中，请确认 Windows 防火墙已允许本应用接收 UDP 47831 端口的入站流量。」并提供「查看诊断」按钮调用 `network:diagnostic` 并弹窗展示结果。

**渲染层改动范围**：定位现有的「已发现会话/在线用户」空状态组件（`pages/src/renderer/components` 下，如 Sidebar 或专门的发现视图），在空状态分支追加提示文案与诊断按钮。具体文件在实现阶段定位，不在本计划中臆断路径。

---

## 假设与决策

1. **不引入 multicast**：保持 UDP broadcast 方案，仅改为定向广播。理由：multicast 需要额外的 IGMP 加入逻辑与 224.0.0.x 地址管理，复杂度更高，且 Windows 防火墙对 multicast 同样有入站限制，不解决核心问题。定向广播是最小改动且有效。
2. **不自动添加 Windows 防火墙规则**：通过 `netsh advfirewall` 添加规则需要管理员权限，Electron 应用提权会触发 UAC 弹窗，体验差且涉及安全策略。改为提供诊断 + 文案提示，由用户手动放行或运行一次性脚本。
3. **不引入第三方网络库**：继续用 Node 内置 `dgram`/`net`，与现有零依赖风格一致。
4. **自包过滤维持 client_id 方案**：已验证可靠，不改为基于 IP 的过滤。
5. **改动 4 的渲染层提示为增量**：不重构现有发现 UI，仅在空状态分支追加文案与按钮。
6. **TCP 层的已知 bug（端口分配无 EADDRINUSE 检查、downloadFile 忽略 hostPort 等）不在本次范围**：用户当前症状是「无法发现对方」，属 UDP 发现层问题；TCP 层 bug 在发现修复后、用户尝试私聊/群聊时才可能暴露，留待后续处理。

---

## 验证步骤

1. **单机自环测试**：在一台机器上启动应用，查看诊断输出，确认 `selfLoopSeen=true`、`udpBound=true`、`broadcastTargets` 列表非空且包含物理网卡子网广播地址。
2. **双机跨机发现测试**：在两台同局域网物理机器上启动应用，确认双方都能在「在线用户」/「已发现会话」中看到对方。
   - 若仍失败，查看诊断输出：若 `selfLoopSeen=true` 但 `peersCount=0`，确认是防火墙问题，按提示放行 UDP 47831 后重试。
3. **多网卡场景测试**：在装有 Docker 或 Hyper-V 的机器上启动应用，查看诊断输出的 `allInterfaces`，确认虚拟网卡被过滤、物理网卡被选中、`localIp` 为真实局域网 IP。
4. **私聊邀请回归测试**：发现成功后，发起私聊，确认被邀请方能收到邀请并自动加入会话（验证 `host_ip` 正确）。
5. **群聊创建与加入回归测试**：一方创建群聊，另一方在发现列表中看到并加入，确认消息可双向收发（验证发现修复后 TCP 层正常工作）。
6. **回归同机多开**：确认同一台机器多开实例仍能互相发现（loopback 场景不破坏）。
