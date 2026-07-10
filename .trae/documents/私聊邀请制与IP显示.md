# 私聊邀请制与身份显示 IP

## 摘要

1. **私聊改为邀请制**：创建私聊时从在线联系人列表选择一人，直接向对方发起单播邀请，对方自动加入。私聊会话不再通过 UDP 广播到局域网，仅受邀者可加入。
2. **身份显示追加内网地址**：所有显示"名字+识别码"的位置（TitleBar、LoginScreen、MessageBubble 发送者、Sidebar 联系人）统一在识别码后追加 `@IP` 显示。

---

## 当前状态分析

### 私聊现状（问题）
- `NewSessionModal` 创建私聊时仅传 `type:'private'`，不指定被邀请人
- `session:create` handler 不区分 type，统一调用 `net.hostSession(session)`
- `hostSession` 立即调用 `_broadcastPresence()`，**私聊被广播到 255.255.255.255**
- `_broadcastPresence` 遍历 `this.hosted.values()` 时**无 type 过滤**
- 接收方 `_onUdpMessage` 发现私聊会话后 emit `session-discovered`，**Sidebar 的 `discoverable` 列表不过滤 type**
- 任何人都能在"局域网发现"区看到私聊并点"加入"
- 网络层无邀请/白名单/token 机制

### IP 显示现状
- `resolveIdentity`（identity.js）仅在 level 3（同昵称≥2 且 IP 不一致）才显示 IP
- TitleBar 显示 `nickname #clientId前6位`，无 IP
- LoginScreen 显示 `识别码 clientId前8位`，无 IP
- MessageBubble / Sidebar ContactItem 调用 resolveIdentity，level 1/2 不显示 IP
- 数据已具备：`NetworkManager.localIp`（本机）、`contacts.last_seen_ip`（他人）、`peers[].ip`（在线他人）

---

## 改动清单

### A. 私聊邀请制

#### A1. 新增 PRIVATE_INVITE 包类型
**文件**：`pages/src/shared/constants.js`
- 在 `PACKET` 枚举中新增 `PRIVATE_INVITE: 'private_invite'`
- 在 `IPC_EVENT` 中新增 `PRIVATE_INVITE_RECEIVED: 'network:private-invite'`（主→渲染通知，可选；主要走自动加入流程）

#### A2. 网络层：发送邀请 + 过滤广播 + 接收邀请
**文件**：`pages/src/main/network/network.js`

**(a) 新增 `sendPrivateInvite(targetIp, invite)` 方法**：
- 构造 `{ type: PACKET.PRIVATE_INVITE, from: clientInfo, session_id, session_name, host_ip, message_port }` 包
- 用 `this.udpSocket.send(msg, 0, msg.length, UDP_BROADCAST_PORT, targetIp)` **单播**到目标 IP（不走广播）
- 目标客户端的 UDP socket（已监听 47831）会收到此包

**(b) 修改 `_broadcastPresence`**：
- 遍历 `this.hosted.values()` 时过滤掉 `h.session.type === 'private'` 的会话
```js
sessions: Array.from(this.hosted.values())
  .filter((h) => h.session.type !== 'private')
  .map((h) => ({ ... }))
```

**(c) 修改 `_onUdpMessage`**：
- 新增对 `packet.type === PACKET.PRIVATE_INVITE` 的分支处理
- 检查 `packet.to === this.clientInfo.client_id`（目标是自己才处理）
- emit `private-invite` 事件，payload: `{ session_id, session_name, host_ip, message_port, from: { client_id, nickname, ip } }`

#### A3. IPC 层：创建私聊时发送邀请 + 接收邀请时自动加入
**文件**：`pages/src/main/ipc/index.js`

**(a) 修改 `session:create` handler**：
- 新增可选参数 `{ name, type, invitee_ip, invitee_client_id }`
- 当 `type === 'private'` 时：
  - 正常创建会话 + `net.hostSession(session)`
  - 调用 `net.sendPrivateInvite(invitee_ip, { session_id, session_name, host_ip: net.localIp, message_port, from: clientInfo })`
  - 把被邀请人信息记入会话（可选：存 session.name 或单独字段，这里复用 name）

**(b) 新增 `private-invite` 事件监听**（在 `registerNetworkEvents` 中）：
```js
net.on('private-invite', (invite) => {
  // 自动加入：建立 TCP 连接
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
  }
  // 通知渲染层有新会话（刷新列表）
  send(IPC_EVENT.SESSION_DISCOVERED, {
    session_id: invite.session_id,
    name: invite.session_name,
    type: SESSION_TYPE.PRIVATE,
    host_ip: invite.host_ip,
    host_contact_id: invite.from.client_id,
    member_count: 2,
    message_port: invite.message_port,
    auto_join: true  // 标记已自动加入
  });
});
```

#### A4. 渲染层：NewSessionModal 私聊时选择联系人
**文件**：`pages/src/renderer/components/NewSessionModal.jsx`
- 当 `type === 'private'` 时，显示在线联系人选择列表（从 `useContactsStore.peers` 获取）
- 列表项显示：`昵称 (id前6位) @ip`
- 选中后，`handleCreate` 把 `invitee_ip` 和 `invitee_client_id` 传入 `create()`

**文件**：`pages/src/renderer/stores/useSessionsStore.js`
- `create` 方法新增 `invitee` 参数，透传给 `session:create` IPC

#### A5. Sidebar 防御性过滤
**文件**：`pages/src/renderer/components/Sidebar.jsx`
- `discoverable` 过滤增加 `&& s.type !== 'private'`（双保险，即使广播泄露也不会显示）

---

### B. 身份显示追加 IP

#### B1. 修改 resolveIdentity 始终显示 ID + IP
**文件**：`pages/src/renderer/utils/identity.js`
- level 1：`昵称 (id前6位, ip)` —— 原 level 1 仅显示昵称，改为追加 id+ip
- level 2：`昵称 (id前6位, ip)` —— 保持显示 id，追加 ip（同昵称但 IP 一致时本就该显示 IP）
- level 3：`昵称 (id前6位, ip)` + ⚠ + tooltip —— 保持不变（已含 ip）
- 三层统一格式：`昵称 (id前6位, ip)`，区别仅在 level 3 有警告图标和 tooltip

```js
// level 1 新实现
return {
  level: 1,
  nick,
  segs: [
    { text: nick + ' ', cls: 'id-name' },
    { text: `(${idShort}, `, cls: 'id-id' },
    { text: ip || '未知', cls: 'id-ip' },
    { text: ')', cls: 'id-id' }
  ],
  tooltip: null
};
```

#### B2. 暴露本机 IP 给渲染层
**文件**：`pages/src/main/ipc/index.js`
- `client:init` 返回的 clientInfo 追加 `ip: net.localIp`
- `client:set-nickname` 返回也追加 `ip: net.localIp`

**文件**：`pages/src/renderer/stores/useClientStore.js`
- state 新增 `ip: null`
- `init` / `setNickname` 时从返回值提取 `ip` 存入 state

#### B3. TitleBar 显示 IP
**文件**：`pages/src/renderer/components/TitleBar.jsx`
- 当前：`{nickname} <span className="titlebar-id">#{clientId前6位}</span>`
- 改为：`{nickname} <span className="titlebar-id">#{clientId前6位}</span> <span className="titlebar-ip">@{ip}</span>`

#### B4. LoginScreen 显示 IP
**文件**：`pages/src/renderer/components/LoginScreen.jsx`
- 当前：`识别码 {clientId前8位}`
- 改为：`识别码 {clientId前8位} @ {ip}`

#### B5. 样式：titlebar-ip
**文件**：`pages/src/renderer/styles/layout.css`
- 新增 `.titlebar-ip { color: var(--neon-orange); font-family: var(--font-mono); font-size: 11px; }`
  （用霓虹橙区分 IP，呼应规格文档"IP 部分霓虹橙"的设计）

---

## 假设与决策

1. **邀请传输方式**：用 UDP 单播（`udpSocket.send` 指定目标 IP），不走广播。目标客户端的 UDP socket 已监听 47831 端口，无需新增端口。
2. **私聊不广播**：`_broadcastPresence` 过滤 `type==='private'`，私聊仅通过 PRIVATE_INVITE 单播包通知被邀请人。
3. **自动加入**：被邀请方收到 PRIVATE_INVITE 后自动 joinSession + 创建本地会话记录，无需用户点确认（符合用户选择的"选联系人直接创建"流程）。
4. **IP 显示格式**：统一 `昵称 (id前6位, ip)`，IP 用霓虹橙色，呼应规格文档身份防伪造层级中"IP 部分霓虹橙"的设计。
5. **自己 IP 来源**：`NetworkManager.localIp`（启动时通过 `getLocalIp()` 获取）。
6. **他人 IP 来源**：`contacts.last_seen_ip`（已由 peer-online / handleReceivedMessage 持续更新）。
7. **保留三层防伪造逻辑**：level 3 仍有 ⚠ 图标和 tooltip，只是 level 1/2 也追加 IP 显示。

---

## 验证步骤

1. **构建验证**：`npm run build` 成功无报错
2. **语法检查**：`node --check` 所有修改的 CommonJS 文件
3. **运行时验证**：`$env:NODE_ENV='production'; npx electron .` 启动无崩溃
4. **功能验证**（需两台机器或两个实例）：
   - 创建私聊时能看到在线联系人列表
   - 选中联系人后对方自动加入私聊（无需对方操作）
   - 私聊不出现在其他人的"局域网发现"列表
   - TitleBar / LoginScreen / 消息气泡 / 联系人列表都显示 IP
5. **回归验证**：
   - 群聊创建/发现/加入流程不受影响
   - 联系人星标/备注名功能不受影响
   - 身份防伪造 level 3 警告仍生效
