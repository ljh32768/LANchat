// 网络层：UDP 局域网发现 + 每会话独立 TCP 连接 + 文件点对点传输。
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');
const {
  UDP_BROADCAST_PORT,
  UDP_BROADCAST_INTERVAL_MS,
  UDP_PEER_TIMEOUT_MS,
  TCP_MESSAGE_PORT_BASE,
  TCP_FILE_PORT_BASE,
  PACKET
} = require('../../shared/constants');

// 虚拟网卡名匹配（不区分大小写）：仅用于 getLocalIp 的优先级降权，不再从广播目标中剔除
const VIRTUAL_ADAPTER_RE = /vmware|virtualbox|vbox|docker|wsl|vethernet|tap-?windows|tun|openvpn|loopback pseudo|bluetooth|radius/i;

// 判断是否为常见局域网 IP 段（192.168.x.x / 10.x.x.x）
function isCommonLanIp(ip) {
  const a = ip.split('.')[0] | 0;
  return a === 192 || a === 10;
}

// 收集本机所有非 internal 的 IPv4 接口（不过滤虚拟网卡，确保广播覆盖所有子网）
function getLocalInterfaces() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        result.push({ name, address: iface.address, netmask: iface.netmask });
      }
    }
  }
  return result;
}

// IPv4 字符串 ↔ 无符号 32 位整数
function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  // 192.168.1.10 → ((192<<24)|(168<<16)|(1<<8)|10) >>> 0
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

// 获取局域网 IPv4：优先 192.168/10 段 + 非虚拟网卡名，避免选到 172.16-31 虚拟网段
function getLocalIp() {
  const list = getLocalInterfaces();
  if (!list.length) return '127.0.0.1';
  // 优先级 1：192.168/10 段且非虚拟网卡名
  const best = list.find((i) => isCommonLanIp(i.address) && !VIRTUAL_ADAPTER_RE.test(i.name));
  if (best) return best.address;
  // 优先级 2：192.168/10 段（即使网卡名像虚拟的，IP 段对就用）
  const lan = list.find((i) => isCommonLanIp(i.address));
  if (lan) return lan.address;
  // 优先级 3：非虚拟网卡名
  const physical = list.find((i) => !VIRTUAL_ADAPTER_RE.test(i.name));
  if (physical) return physical.address;
  // 兜底：第一个
  return list[0].address;
}

// 按行（\n）拆分缓冲区，用于 TCP 帧拆包
class LineBuffer {
  constructor() { this.buf = ''; }
  push(chunk) {
    this.buf += chunk.toString('utf8');
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    return lines;
  }
}

class NetworkManager extends EventEmitter {
  constructor() {
    super();
    this.clientInfo = null;
    this.localIp = getLocalIp();
    this.udpSocket = null;
    this.broadcastTimer = null;
    this.sweepTimer = null;

    // 已发现的在线用户: client_id -> { client_id, nickname, ip, last_seen }
    this.peers = new Map();
    // 已发现的会话: session_id -> { session_id, name, host_ip, host_port, host_contact_id, member_count, last_seen }
    this.discoveredSessions = new Map();

    // 本机作为主机托管的会话: session_id -> { session, server, members: Map(socket -> {client_id, nickname}) , port }
    this.hosted = new Map();
    // 本机作为成员加入的会话: session_id -> { socket, lineBuffer, host_ip, host_port }
    this.joined = new Map();

    this.nextMsgPort = TCP_MESSAGE_PORT_BASE;
    this.nextFilePort = TCP_FILE_PORT_BASE;
    this.fileServer = null;
    this.fileServerPort = TCP_FILE_PORT_BASE;
    this.fileStoreDir = null; // 延迟到 start() 内初始化（需 app.whenReady 后）
  }

  // ---- 启动 ----
  start(clientInfo) {
    this.clientInfo = clientInfo;
    console.log('[net] localIp =', this.localIp);
    // 输出所有原始网卡（含被过滤的虚拟网卡），用于排查网络拓扑
    const allRaw = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        allRaw.push(`${name}[${iface.family}]:${iface.address}/${iface.netmask}${iface.internal ? '(internal)' : ''}`);
      }
    }
    console.log('[net] all raw interfaces =', allRaw.join(' | ') || '(none)');
    console.log('[net] filtered interfaces =', getLocalInterfaces().map((i) => i.name + ':' + i.address + '/' + i.netmask).join(', ') || '(none)');

    // 文件存储目录（主机暂存）—— 必须在 app.whenReady 之后初始化
    this.fileStoreDir = path.join(app.getPath('userData'), 'filestore');
    if (!fs.existsSync(this.fileStoreDir)) fs.mkdirSync(this.fileStoreDir, { recursive: true });

    this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.udpSocket.on('message', (msg, rinfo) => this._onUdpMessage(msg, rinfo));
    this.udpSocket.on('error', (e) => {
      // 输出错误码便于定位：EADDRINUSE=端口被占用，EACCES=权限/策略限制
      console.error('[net] udp error:', e.code, e.message);
    });
    this.udpSocket.on('listening', () => {
      const addr = this.udpSocket.address();
      console.log('[net] udp bound', addr.address + ':' + addr.port, 'broadcast=true');
    });

    this.udpSocket.bind(UDP_BROADCAST_PORT, '0.0.0.0', () => {
      this.udpSocket.setBroadcast(true);
      this.broadcastTimer = setInterval(() => this._broadcastPresence(), UDP_BROADCAST_INTERVAL_MS);
      this._broadcastPresence();
    });

    this.sweepTimer = setInterval(() => this._sweep(), UDP_PEER_TIMEOUT_MS / 2);

    // 启动文件传输服务（本机作为主机时供他人下载）
    this._startFileServer();
  }

  stop() {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const [, h] of this.hosted) { try { h.server.close(); } catch {} }
    for (const [, j] of this.joined) { try { j.socket.destroy(); } catch {} }
    if (this.udpSocket) this.udpSocket.close();
    if (this.fileServer) this.fileServer.close();
  }

  // ---- UDP 广播 ----
  // 计算本机所有物理接口的子网定向广播地址（ip | ~netmask）
  // 定向广播会从对应的具体网卡发出，解决 255.255.255.255 在多网卡下只走默认路由的问题
  getBroadcastTargets() {
    return getLocalInterfaces().map((i) => ({
      name: i.name,
      ip: i.address,
      broadcast: intToIp(ipToInt(i.address) | (~ipToInt(i.netmask) >>> 0))
    }));
  }

  _broadcastPresence(sessionEnd = null) {
    if (!this.udpSocket) return;
    let packet;
    if (sessionEnd) {
      packet = { type: PACKET.SESSION_END, client_id: this.clientInfo.client_id, session_id: sessionEnd };
    } else {
      packet = {
        type: PACKET.PRESENCE,
        client_id: this.clientInfo.client_id,
        nickname: this.clientInfo.nickname,
        ip: this.localIp,
        sessions: Array.from(this.hosted.values())
          .filter((h) => h.session.type !== 'private') // 私聊不广播到局域网
          .map((h) => ({
            session_id: h.session.session_id,
            name: h.session.name,
            type: h.session.type,
            host_contact_id: h.session.host_contact_id,
            member_count: h.members.size + 1,
            message_port: h.port
          }))
      };
    }
    const msg = Buffer.from(JSON.stringify(packet));
    // 定向广播：逐个物理网卡子网发送，确保广播从正确接口发出
    const targets = this.getBroadcastTargets();
    const sessionCount = packet.type === PACKET.PRESENCE ? (packet.sessions || []).length : -1;
    console.log('[net] broadcast type=' + packet.type, 'sessions=' + sessionCount, 'hosted=' + this.hosted.size, 'targets:', targets.map((t) => t.broadcast + '@' + t.name).join(', ') || '(none, only 255.255.255.255)');
    for (const t of targets) {
      this.udpSocket.send(msg, 0, msg.length, UDP_BROADCAST_PORT, t.broadcast, (err) => {
        if (err) console.error('[net] send directed fail', t.broadcast, err.code, err.message);
      });
    }
    // 兜底：有限广播（单网卡环境或定向广播失败时仍可覆盖）
    this.udpSocket.send(msg, 0, msg.length, UDP_BROADCAST_PORT, '255.255.255.255', (err) => {
      if (err) console.error('[net] send limited fail', err.code, err.message);
    });
  }

  // V19：主动广播防抖（500ms 内多次操作合并为一次广播）
  // 定时广播（start 中的 setInterval）和会话结束广播仍直接调用 _broadcastPresence
  _broadcastPresenceDebounced() {
    if (this._broadcastTimer) return;
    this._broadcastTimer = setTimeout(() => {
      this._broadcastTimer = null;
      this._broadcastPresence();
    }, 500);
  }

  _onUdpMessage(msg, rinfo) {
    // V10：UDP 包大小上限校验（防超大包阻塞 JSON.parse）
    if (msg.length > 16384) {
      console.warn('[net] oversized udp packet', msg.length, 'from', rinfo.address);
      return;
    }
    let packet;
    try { packet = JSON.parse(msg.toString()); } catch {
      console.log('[net] recv bad json from', rinfo.address);
      return;
    }
    // V10：未知包类型告警
    if (!packet || !['presence', 'session_end', 'private_invite'].includes(packet.type)) {
      console.warn('[net] unknown packet type', packet?.type, 'from', rinfo.address);
      return;
    }
    console.log('[net] recv from', rinfo.address + ':' + rinfo.port, 'type=' + packet.type, 'cid=' + (packet.client_id || '').slice(0, 8));
    // 忽略自己的广播
    if (packet.client_id === this.clientInfo.client_id) return;
    if (!packet.client_id) return;

    if (packet.type === PACKET.PRESENCE) {
      // peer IP 优选：已记录的是常见局域网段（192.168/10）时不被虚拟网段（如 172.22）覆盖
      // 否则私聊邀请 UDP 单播会发到虚拟网卡导致不可达
      const existing = this.peers.get(packet.client_id);
      const incomingIp = rinfo.address;
      const shouldOverwriteIp = !existing ||
        !isCommonLanIp(existing.ip) ||
        isCommonLanIp(incomingIp);
      const finalIp = shouldOverwriteIp ? incomingIp : existing.ip;
      this.peers.set(packet.client_id, {
        client_id: packet.client_id,
        nickname: packet.nickname,
        ip: finalIp,
        last_seen: Date.now()
      });
      for (const s of packet.sessions || []) {
        const existingSession = this.discoveredSessions.get(s.session_id);
        this.discoveredSessions.set(s.session_id, {
          ...s,
          host_ip: finalIp,
          last_seen: Date.now()
        });
        if (!existingSession) {
          this.emit('session-discovered', {
            session_id: s.session_id,
            name: s.name,
            type: s.type,
            host_ip: finalIp,
            host_contact_id: s.host_contact_id,
            member_count: s.member_count,
            message_port: s.message_port
          });
        } else {
          this.emit('presence-update', {
            session_id: s.session_id,
            member_count: s.member_count
          });
        }
      }
      this.emit('peer-online', this.peers.get(packet.client_id));
    } else if (packet.type === PACKET.SESSION_END) {
      this.discoveredSessions.delete(packet.session_id);
      this.emit('session-removed', { session_id: packet.session_id });
    } else if (packet.type === PACKET.PRIVATE_INVITE) {
      // 私聊邀请（单播）：目标是自己才处理
      // 关键：用 rinfo.address（UDP 包真实来源 IP）覆盖 packet.host_ip
      // 因为发起方的 this.localIp 可能是虚拟网卡 IP（如 Hyper-V 的 172.22.x.x），
      // 用它连 TCP 会失败；rinfo.address 是内核确认可达的真实对端 IP
      console.log('[net] recv PRIVATE_INVITE from', rinfo.address, 'to', packet.to, 'packet_host_ip', packet.host_ip, 'port', packet.message_port);
      if (packet.to === this.clientInfo.client_id) {
        // 把邀请方写入 peers，让 _sweep 的 joined 清理能识别 host_ip 仍在线
        // 否则 B 加入私聊后 sweep 会因 peers 里没有 A 而误删 joined 会话
        this.peers.set(packet.from.client_id, {
          client_id: packet.from.client_id,
          nickname: packet.from.nickname,
          ip: rinfo.address,
          last_seen: Date.now()
        });
        this.emit('private-invite', {
          session_id: packet.session_id,
          session_name: packet.session_name,
          host_ip: rinfo.address,
          message_port: packet.message_port,
          from: packet.from
        });
      }
    }
  }

  // 发送私聊邀请：UDP 单播到目标 IP + 广播兜底（to 字段保证只有目标方处理）
  sendPrivateInvite(targetIp, invite) {
    if (!this.udpSocket) return;
    const packet = {
      type: PACKET.PRIVATE_INVITE,
      client_id: this.clientInfo.client_id,
      from: {
        client_id: this.clientInfo.client_id,
        nickname: this.clientInfo.nickname,
        ip: this.localIp
      },
      to: invite.to,
      session_id: invite.session_id,
      session_name: invite.session_name,
      host_ip: this.localIp,
      message_port: invite.message_port
    };
    const msg = Buffer.from(JSON.stringify(packet));
    console.log('[net] sendPrivateInvite to', targetIp, 'host_ip', this.localIp, 'port', invite.message_port, 'sid', invite.session_id.slice(0, 8));
    // 1. 单播到已知 IP
    this.udpSocket.send(msg, 0, msg.length, UDP_BROADCAST_PORT, targetIp, (err) => {
      if (err) console.error('[net] sendPrivateInvite unicast fail', targetIp, err.code, err.message);
    });
    // 2. 定向广播兜底：targetIp 可能是虚拟网卡地址（不可达），广播保证对方从真实网卡收到
    for (const t of this.getBroadcastTargets()) {
      this.udpSocket.send(msg, 0, msg.length, UDP_BROADCAST_PORT, t.broadcast, (err) => {
        if (err) console.error('[net] sendPrivateInvite bcast fail', t.broadcast, err.code, err.message);
      });
    }
  }

  _sweep() {
    const now = Date.now();
    for (const [id, p] of this.peers) {
      if (now - p.last_seen > UDP_PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        this.emit('peer-offline', { client_id: id });
      }
    }
    for (const [id, s] of this.discoveredSessions) {
      if (now - s.last_seen > UDP_PEER_TIMEOUT_MS) {
        this.discoveredSessions.delete(id);
        this.emit('session-removed', { session_id: id });
      }
    }
    // 主机异常离线清理：TCP 连接已断 且 UDP peers 里也找不到主机时才清理
    // 私聊是两人会话，以 TCP 连接为第一准则——只要 TCP 还活着，绝不因 UDP 短暂丢包而误删
    for (const [sid, ctx] of this.joined) {
      if (ctx.ended) continue;
      const tcpAlive = ctx.socket && !ctx.socket.destroyed && ctx.socket.writable;
      if (tcpAlive) continue; // TCP 还在 → 保留（可能在重连中，也可能是正常连接）
      // TCP 已断 → 看 UDP peers 里主机是否还在线
      const hostStillOnline = Array.from(this.peers.values()).some((p) => p.ip === ctx.host_ip);
      if (!hostStillOnline) {
        console.warn('[net] sweep: host offline and tcp dead, remove joined session', sid.slice(0, 8), 'host_ip', ctx.host_ip);
        this._stopHeartbeat(sid);
        try { ctx.socket.destroy(); } catch {}
        this.joined.delete(sid);
        this.emit('session-removed', { session_id: sid });
      }
    }
  }

  // 通过 host_ip 反查 client_id（用于 sweep 时的 peer 查找，返回 null 表示未知）
  _hostClientIdByIp(ip) {
    for (const p of this.peers.values()) {
      if (p.ip === ip) return p.client_id;
    }
    return null;
  }

  getDiscoveredSessions() {
    return Array.from(this.discoveredSessions.values());
  }

  getPeers() {
    return Array.from(this.peers.values());
  }

  // ---- 主机：创建会话并监听 TCP ----
  // 端口冲突时自动重试，最多尝试 20 个端口
  // onReady(finalPort)：listen 成功后回调，私聊邀请需在此回调里发（确保 server 已就绪）
  hostSession(session, attempt = 0, onReady) {
    if (attempt > 20) {
      console.error('[net] hostSession give up after 20 attempts', session.name);
      if (onReady) onReady(null);
      return null;
    }
    const port = this._allocPort();
    const server = net.createServer((socket) => this._onHostSocket(socket, session.session_id));

    // 先把 session 登记进 hosted（立即生效，不依赖 listen 回调）
    this.hosted.set(session.session_id, { session, server, members: new Map(), port });

    server.on('error', (e) => {
      console.error('[net] host server error:', session.session_id, 'port', port, e.code, e.message);
      // 端口被占用（EADDRINUSE）时自动换端口重试，传递 onReady 以便最终回调
      if (e.code === 'EADDRINUSE') {
        this.hosted.delete(session.session_id);
        try { server.close(); } catch {}
        this.hostSession(session, attempt + 1, onReady);
      } else if (onReady) {
        onReady(null);
      }
    });

    server.listen(port, '0.0.0.0', () => {
      console.log('[net] hostSession listen ok', session.name, 'port', port, 'type', session.type);
      const h = this.hosted.get(session.session_id);
      if (h) h.port = port;
      this._broadcastPresence();
      // listen 成功后才回调，确保私聊邀请里的 port 是已就绪的真实端口
      if (onReady) onReady(port);
    });
    return port;
  }

  _allocPort() {
    return this.nextMsgPort++;
  }

  _onHostSocket(socket, sessionId) {
    const lb = new LineBuffer();
    // 记录对端 IP 用于身份绑定校验（V3：防 client_id 冒充）
    const memberInfo = { client_id: null, nickname: null, socket, remoteAddress: socket.remoteAddress };
    // V5：TCP keep-alive + 超时 + 禁用 Nagle
    socket.setKeepAlive(true, 30000);
    socket.setNoDelay(true);
    socket.setTimeout(60000);
    socket.on('timeout', () => {
      console.warn('[net] host socket idle timeout, destroy', socket.remoteAddress);
      socket.destroy();
    });
    socket.on('data', (chunk) => {
      for (const line of lb.push(chunk)) {
        try { this._onHostLine(line, socket, sessionId, memberInfo); } catch (e) { console.error(e); }
      }
    });
    socket.on('end', () => this._removeMember(sessionId, socket));
    socket.on('error', () => this._removeMember(sessionId, socket));
  }

  _onHostLine(line, socket, sessionId, memberInfo) {
    const msg = JSON.parse(line);
    if (msg.kind === 'join') {
      // V3：校验 client_id 与对端 IP 是否与 peers 中登记的一致（防冒充）
      const peer = this.peers.get(msg.client_id);
      if (peer && peer.ip && peer.ip !== socket.remoteAddress) {
        console.warn('[net] join rejected: client_id IP mismatch', msg.client_id.slice(0, 8), 'peer.ip=', peer.ip, 'socket=', socket.remoteAddress);
        socket.destroy();
        return;
      }
      memberInfo.client_id = msg.client_id;
      memberInfo.nickname = msg.nickname;
      const h = this.hosted.get(sessionId);
      if (h) {
        h.members.set(socket, memberInfo);
        // 成员重连进来：取消私聊自动解散的宽限定时器
        if (h._autoEndTimer) {
          console.log('[net] member rejoined, cancel auto-end timer', sessionId.slice(0, 8));
          clearTimeout(h._autoEndTimer);
          h._autoEndTimer = null;
        }
        this._broadcastPresenceDebounced();
        // 回送 joined + 当前成员列表
        this._sendJson(socket, {
          kind: 'joined',
          session_id: sessionId,
          members: Array.from(h.members.values()).map((m) => ({ client_id: m.client_id, nickname: m.nickname }))
        });
        this.emit('member-joined', { session_id: sessionId, client_id: msg.client_id, nickname: msg.nickname });
      }
    } else if (msg.kind === 'msg' || msg.kind === 'file') {
      // V3：强制用 memberInfo 绑定的身份覆盖消息中的 sender 字段，防止成员 A 冒充成员 B 发言
      if (memberInfo.client_id) {
        msg.sender_contact_id = memberInfo.client_id;
        msg.sender_nickname = memberInfo.nickname;
        msg.sender_ip = memberInfo.remoteAddress;
      }
      this.emit('message', msg);
      this._relay(sessionId, msg, socket);
    } else if (msg.kind === 'ping') {
      // V4：心跳响应
      this._sendJson(socket, { kind: 'pong' });
    }
  }

  _removeMember(sessionId, socket) {
    const h = this.hosted.get(sessionId);
    if (!h) return;
    const m = h.members.get(socket);
    h.members.delete(socket);
    try { socket.destroy(); } catch {}
    this._broadcastPresence();
    if (m) {
      this.emit('member-left', { session_id: sessionId, client_id: m.client_id });
      // 私聊会话：成员断开给 15s 宽限期（应对网络抖动后重连），超时且无成员才真正解散
      // 群聊成员断开不影响会话存续
      if (h.session && h.session.type === 'private') {
        if (h.members.size === 0) {
          console.log('[net] private member left, grace 15s before auto-end', sessionId.slice(0, 8));
          h._autoEndTimer = setTimeout(() => {
            const cur = this.hosted.get(sessionId);
            if (cur && cur.members.size === 0) {
              console.log('[net] private grace expired, auto-end', sessionId.slice(0, 8));
              this.emit('session-auto-end', { session_id: sessionId });
              this.closeHostedSession(sessionId);
            }
          }, 15000);
        }
      }
    }
  }

  _relay(sessionId, msg, exceptSocket) {
    const h = this.hosted.get(sessionId);
    if (!h) return;
    const line = JSON.stringify(msg) + '\n';
    for (const s of h.members.keys()) {
      if (s !== exceptSocket) { try { s.write(line); } catch {} }
    }
  }

  // 主机本地发送（自己发的消息）：仅转发给成员；存储由 IPC 层完成
  relayToMembers(sessionId, msg) {
    this._relay(sessionId, msg, null);
  }

  // 主机向指定成员（按 client_id）推送历史消息包
  // messages: 已组装好的消息数组（含 sender_nickname 等）
  sendHistoryToMember(sessionId, clientId, messages) {
    const h = this.hosted.get(sessionId);
    if (!h) return;
    for (const [sock, m] of h.members.entries()) {
      if (m.client_id === clientId) {
        const packet = { kind: 'history', session_id: sessionId, messages };
        this._sendJson(sock, packet);
        console.log('[net] sent history to', clientId.slice(0, 8), 'count', messages.length, 'sid', sessionId.slice(0, 8));
        return;
      }
    }
    console.log('[net] sendHistoryToMember: member not found', clientId.slice(0, 8), 'sid', sessionId.slice(0, 8));
  }

  // ---- 成员：加入会话 ----
  // 网络抖动时自动重连（最多 5 次，间隔 2s），只在主机明确解散（session-end）时才结束
  joinSession(sessionId, hostIp, hostPort, onMessage) {
    if (this.joined.has(sessionId)) return;
    console.log('[net] joinSession connecting to', hostIp + ':' + hostPort, 'sid', sessionId.slice(0, 8));
    const socket = net.createConnection({ host: hostIp, port: hostPort });
    const lb = new LineBuffer();
    const ctx = {
      socket,
      lineBuffer: lb,
      host_ip: hostIp,
      host_port: hostPort,
      onMessage,
      reconnectAttempts: 0,
      ended: false, // 主机明确解散后才置 true，阻止重连
      heartbeatTimer: null,
      missedPongs: 0
    };
    this.joined.set(sessionId, ctx);

    // V5：TCP keep-alive + 禁用 Nagle
    socket.setKeepAlive(true, 30000);
    socket.setNoDelay(true);

    socket.on('connect', () => {
      console.log('[net] joinSession connected to', hostIp + ':' + hostPort);
      ctx.reconnectAttempts = 0; // 连接成功后重置重连计数
      ctx.missedPongs = 0;
      this._sendJson(socket, {
        kind: 'join',
        client_id: this.clientInfo.client_id,
        nickname: this.clientInfo.nickname,
        session_id: sessionId
      });
      // V4：启动心跳（30s 一次，3 次未收到 pong 则认为主机已离线，触发重连）
      this._startHeartbeat(sessionId);
    });
    socket.on('data', (chunk) => {
      for (const line of lb.push(chunk)) {
        try {
          const msg = JSON.parse(line);
          if (msg.kind === 'joined') {
            this.emit('joined', { session_id: sessionId, members: msg.members });
          } else if (msg.kind === 'session-end') {
            // 主机明确解散：标记结束，不再重连
            console.log('[net] recv session-end from host, stopping', sessionId.slice(0, 8));
            ctx.ended = true;
            this.emit('session-removed', { session_id: sessionId });
          } else if (msg.kind === 'pong') {
            // 心跳响应：重置未响应计数
            ctx.missedPongs = 0;
          } else if (msg.kind === 'history') {
            // 主机推送的历史消息：逐条交给上层（db.addMessage 幂等，已存在会跳过）
            for (const m of (msg.messages || [])) {
              try { onMessage(m); } catch (e) { console.error('[net] history item error:', e); }
            }
          } else if (msg.kind === 'msg' || msg.kind === 'file') {
            onMessage(msg);
          }
        } catch (e) { console.error(e); }
      }
    });
    socket.on('error', (e) => {
      console.error('[net] joinSession error:', hostIp + ':' + hostPort, e.code, e.message);
      // 不立即 emit session-removed，交给 end 处理（重连或结束）
    });
    socket.on('end', () => {
      console.log('[net] joinSession ended:', hostIp + ':' + hostPort, 'ended flag=', ctx.ended);
      this._stopHeartbeat(sessionId);
      if (ctx.ended) return; // 主机解散，已处理
      // 网络抖动：自动重连
      this._reconnectJoined(sessionId);
    });
  }

  // V4：成员端心跳（30s 发 ping，3 次未收到 pong 则断开重连）
  _startHeartbeat(sessionId) {
    const ctx = this.joined.get(sessionId);
    if (!ctx) return;
    this._stopHeartbeat(sessionId);
    ctx.heartbeatTimer = setInterval(() => {
      if (!this.joined.has(sessionId) || ctx.ended) {
        this._stopHeartbeat(sessionId);
        return;
      }
      ctx.missedPongs++;
      if (ctx.missedPongs >= 3) {
        console.warn('[net] heartbeat: 3 pongs missed, host likely offline, reconnect', sessionId.slice(0, 8));
        this._stopHeartbeat(sessionId);
        try { ctx.socket.destroy(); } catch {}
        // 触发 end 事件 → _reconnectJoined
        return;
      }
      try { this._sendJson(ctx.socket, { kind: 'ping' }); } catch {}
    }, 30000);
  }

  _stopHeartbeat(sessionId) {
    const ctx = this.joined.get(sessionId);
    if (ctx && ctx.heartbeatTimer) {
      clearInterval(ctx.heartbeatTimer);
      ctx.heartbeatTimer = null;
    }
  }

  // 成员端自动重连：最多 5 次，间隔 2s
  _reconnectJoined(sessionId) {
    const ctx = this.joined.get(sessionId);
    if (!ctx || ctx.ended) return;
    if (ctx.reconnectAttempts >= 5) {
      console.error('[net] reconnect give up after 5 attempts', sessionId.slice(0, 8));
      this.joined.delete(sessionId);
      this.emit('session-removed', { session_id: sessionId });
      return;
    }
    ctx.reconnectAttempts++;
    const delay = 2000 * ctx.reconnectAttempts; // 2s, 4s, 6s, 8s, 10s
    console.log('[net] reconnect in', delay, 'ms attempt', ctx.reconnectAttempts, sessionId.slice(0, 8));
    setTimeout(() => {
      if (ctx.ended || !this.joined.has(sessionId)) return;
      try { ctx.socket.destroy(); } catch {}
      console.log('[net] reconnecting to', ctx.host_ip + ':' + ctx.host_port, sessionId.slice(0, 8));
      const socket = net.createConnection({ host: ctx.host_ip, port: ctx.host_port });
      ctx.socket = socket;
      socket.setKeepAlive(true, 30000);
      socket.setNoDelay(true);
      socket.setTimeout(60000);
      socket.on('timeout', () => {
        console.warn('[net] reconnect socket idle timeout, destroy', ctx.host_ip + ':' + ctx.host_port);
        socket.destroy();
      });
      socket.on('connect', () => {
        console.log('[net] reconnect ok', ctx.host_ip + ':' + ctx.host_port);
        ctx.reconnectAttempts = 0;
        ctx.missedPongs = 0;
        this._sendJson(socket, {
          kind: 'join',
          client_id: this.clientInfo.client_id,
          nickname: this.clientInfo.nickname,
          session_id: sessionId
        });
        this._startHeartbeat(sessionId);
      });
      socket.on('data', (chunk) => {
        for (const line of ctx.lineBuffer.push(chunk)) {
          try {
            const msg = JSON.parse(line);
            if (msg.kind === 'joined') {
              this.emit('joined', { session_id: sessionId, members: msg.members });
            } else if (msg.kind === 'session-end') {
              ctx.ended = true;
              this._stopHeartbeat(sessionId);
              this.emit('session-removed', { session_id: sessionId });
            } else if (msg.kind === 'pong') {
              ctx.missedPongs = 0;
            } else if (msg.kind === 'history') {
              for (const m of (msg.messages || [])) {
                try { ctx.onMessage(m); } catch (e) { console.error('[net] history item error:', e); }
              }
            } else if (msg.kind === 'msg' || msg.kind === 'file') {
              ctx.onMessage(msg);
            }
          } catch (e) { console.error(e); }
        }
      });
      socket.on('error', (e) => {
        console.error('[net] reconnect error:', ctx.host_ip + ':' + ctx.host_port, e.code, e.message);
      });
      socket.on('end', () => {
        console.log('[net] reconnect ended again, retry', sessionId.slice(0, 8));
        this._stopHeartbeat(sessionId);
        if (ctx.ended) return;
        this._reconnectJoined(sessionId);
      });
    }, delay);
  }

  memberSend(sessionId, msg) {
    const ctx = this.joined.get(sessionId);
    if (!ctx) return;
    this._sendJson(ctx.socket, msg);
  }

  leaveSession(sessionId) {
    const ctx = this.joined.get(sessionId);
    if (ctx) {
      this._stopHeartbeat(sessionId);
      try { ctx.socket.destroy(); } catch {}
      this.joined.delete(sessionId);
    }
  }

  // ---- 关闭自己托管的会话 ----
  closeHostedSession(sessionId) {
    const h = this.hosted.get(sessionId);
    if (h) {
      const line = JSON.stringify({ kind: 'session-end', session_id: sessionId }) + '\n';
      for (const s of h.members.keys()) { try { s.write(line); s.end(); } catch {} }
      try { h.server.close(); } catch {}
      this.hosted.delete(sessionId);
    }
    this._broadcastPresence();
  }

  isHosting(sessionId) {
    return this.hosted.has(sessionId);
  }

  isJoined(sessionId) {
    return this.joined.has(sessionId);
  }

  getHostedPort(sessionId) {
    return this.hosted.get(sessionId)?.port;
  }

  // ---- 文件传输（头部 JSON 行 + 纯二进制流，使用 Buffer 拆帧避免编码损坏） ----
  // 校验 file_id 为合法 UUID 格式，防止路径遍历（如 ../../evil.exe）
  _isSafeFileId(file_id) {
    return typeof file_id === 'string' && /^[a-f0-9-]{36}$/i.test(file_id);
  }
  // 校验解析后路径仍在 fileStoreDir 内（双重防御）
  _safeFilePath(file_id) {
    if (!this._isSafeFileId(file_id)) return null;
    const dest = path.join(this.fileStoreDir, file_id);
    const resolved = path.resolve(dest);
    const storeRoot = path.resolve(this.fileStoreDir) + path.sep;
    if (resolved !== path.resolve(this.fileStoreDir) && !resolved.startsWith(storeRoot)) return null;
    return resolved;
  }

  _startFileServer(attempt = 0) {
    if (attempt > 20) {
      console.error('[net] file server give up after 20 attempts');
      return;
    }
    this.fileServer = net.createServer((socket) => this._onFileSocket(socket));
    this.fileServer.on('error', (e) => {
      console.error('[net] file server error:', e.code, e.message);
      if (e.code === 'EADDRINUSE') {
        try { this.fileServer.close(); } catch {}
        this.fileServerPort++;
        console.log('[net] file server retry on port', this.fileServerPort);
        this._startFileServer(attempt + 1);
      }
    });
    this.fileServer.listen(this.fileServerPort, '0.0.0.0', () => {
      console.log('[net] file server listen on', this.fileServerPort);
    });
  }

  _onFileSocket(socket) {
    const state = { phase: 'header', buf: Buffer.alloc(0), ws: null, remaining: 0, header: null, timeoutTimer: null };
    // 文件传输超时清理（2 分钟无活动则关闭，防 socket/文件句柄泄漏）
    state.timeoutTimer = setTimeout(() => {
      console.warn('[net] file socket timeout, destroy');
      if (state.ws) state.ws.destroy();
      socket.destroy();
    }, 120000);
    const refreshTimeout = () => {
      if (state.timeoutTimer) state.timeoutTimer.refresh();
    };
    socket.on('data', (chunk) => {
      refreshTimeout();
      if (state.phase === 'header') {
        state.buf = Buffer.concat([state.buf, chunk]);
        const idx = state.buf.indexOf(0x0a); // '\n'
        if (idx === -1) return;
        const headerLine = state.buf.slice(0, idx).toString('utf8');
        const rest = state.buf.slice(idx + 1);
        state.buf = Buffer.alloc(0);
        let header;
        try { header = JSON.parse(headerLine); } catch { socket.destroy(); return; }
        state.header = header;

        if (header.kind === 'download') {
          const filePath = this._safeFilePath(header.file_id);
          if (!filePath) { console.warn('[net] reject unsafe file_id', header.file_id); socket.destroy(); return; }
          this._serveFileDownload(socket, filePath, header.file_id);
        } else if (header.kind === 'upload') {
          const dest = this._safeFilePath(header.file_id);
          if (!dest) { console.warn('[net] reject unsafe file_id', header.file_id); socket.destroy(); return; }
          state.ws = fs.createWriteStream(dest);
          state.remaining = header.file_size;
          state.phase = 'body';
          if (rest.length) this._consumeUploadBody(state, rest, socket);
        }
      } else if (state.phase === 'body') {
        this._consumeUploadBody(state, chunk, socket);
      }
    });
    socket.on('error', () => { if (state.ws) state.ws.destroy(); });
    socket.on('end', () => { if (state.timeoutTimer) clearTimeout(state.timeoutTimer); });
    socket.on('close', () => { if (state.timeoutTimer) clearTimeout(state.timeoutTimer); });
  }

  _consumeUploadBody(state, chunk, socket) {
    if (state.remaining <= 0) return;
    const toWrite = chunk.slice(0, state.remaining);
    state.ws.write(toWrite);
    state.remaining -= toWrite.length;
    if (state.remaining <= 0) {
      state.ws.end();
      state.phase = 'done';
      this._sendJson(socket, { kind: 'upload-done', file_id: state.header.file_id });
      socket.end();
      this.emit('file-uploaded', { file_id: state.header.file_id, file_name: state.header.file_name });
    }
  }

  _serveFileDownload(socket, filePath, fileId) {
    if (!fs.existsSync(filePath)) {
      this._sendJson(socket, { kind: 'download-error', file_id: fileId });
      socket.end();
      return;
    }
    const stat = fs.statSync(filePath);
    socket.write(Buffer.from(JSON.stringify({ kind: 'download-start', file_id: fileId, size: stat.size }) + '\n', 'utf8'));
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => socket.write(d));
    stream.on('end', () => socket.end());
    stream.on('error', () => socket.destroy());
  }

  // 成员上传文件到主机暂存（头部 + 原始字节）
  uploadFileToHost(sessionId, { file_id, file_name, file_size, file_path }, cb) {
    const ctx = this.joined.get(sessionId);
    if (!ctx) { cb(new Error('not joined')); return; }
    const sock = net.createConnection({ host: ctx.host_ip, port: this.fileServerPort });
    let timeoutTimer = setTimeout(() => { sock.destroy(); cb(new Error('upload timeout')); }, 120000);
    sock.on('connect', () => {
      sock.write(Buffer.from(JSON.stringify({
        kind: 'upload', file_id, file_name, file_size, session_id: sessionId
      }) + '\n', 'utf8'));
      const stream = fs.createReadStream(file_path);
      stream.on('data', (d) => { sock.write(d); timeoutTimer.refresh(); });
      stream.on('end', () => sock.end());
      stream.on('error', (e) => { clearTimeout(timeoutTimer); sock.destroy(); cb(e); });
    });
    sock.on('data', () => { timeoutTimer.refresh(); }); // 等待 upload-done
    sock.on('end', () => { clearTimeout(timeoutTimer); cb(null); });
    sock.on('error', (e) => { clearTimeout(timeoutTimer); sock.destroy(); cb(e); });
  }

  // 下载主机上的文件
  downloadFile(hostIp, hostPort, fileId, destPath, onProgress, onDone) {
    const sock = net.createConnection({ host: hostIp, port: this.fileServerPort });
    const state = { phase: 'header', buf: Buffer.alloc(0), ws: null, size: 0, total: 0 };
    let timeoutTimer = setTimeout(() => { if (state.ws) state.ws.destroy(); sock.destroy(); onDone(new Error('download timeout')); }, 120000);
    sock.on('connect', () => {
      sock.write(Buffer.from(JSON.stringify({ kind: 'download', file_id: fileId }) + '\n', 'utf8'));
    });
    sock.on('data', (chunk) => {
      timeoutTimer.refresh();
      if (state.phase === 'header') {
        state.buf = Buffer.concat([state.buf, chunk]);
        const idx = state.buf.indexOf(0x0a);
        if (idx === -1) return;
        const header = JSON.parse(state.buf.slice(0, idx).toString('utf8'));
        const rest = state.buf.slice(idx + 1);
        state.buf = Buffer.alloc(0);
        if (header.kind !== 'download-start') {
          clearTimeout(timeoutTimer);
          onDone(new Error('download error: ' + (header.kind || 'unknown')));
          sock.destroy();
          return;
        }
        state.size = header.size;
        state.ws = fs.createWriteStream(destPath);
        state.phase = 'body';
        if (rest.length) { state.ws.write(rest); state.total += rest.length; }
        if (state.size > 0) onProgress(state.total / state.size);
      } else {
        state.ws.write(chunk);
        state.total += chunk.length;
        if (state.size > 0) onProgress(state.total / state.size);
      }
    });
    sock.on('end', () => {
      clearTimeout(timeoutTimer);
      if (state.ws) state.ws.end(() => onDone(null, destPath)); else onDone(new Error('connection closed'));
    });
    sock.on('error', (e) => { clearTimeout(timeoutTimer); if (state.ws) state.ws.destroy(); onDone(e); });
  }

  getFileStorePath(file_id) {
    return this._safeFilePath(file_id) || path.join(this.fileStoreDir, 'invalid');
  }

  fileExistsOnHost(file_id) {
    const p = this._safeFilePath(file_id);
    return p ? fs.existsSync(p) : false;
  }

  // 主机本地写入文件（本机作为发送方时）
  storeLocalFile(file_id, srcPath, cb) {
    const dest = this._safeFilePath(file_id);
    if (!dest) { cb(new Error('invalid file_id')); return; }
    fs.copyFile(srcPath, dest, (e) => cb(e, dest));
  }

  // ---- 工具 ----
  _sendJson(socket, obj) {
    try { socket.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  setClientInfo(info) {
    this.clientInfo = info;
    this._broadcastPresenceDebounced();
  }
}

module.exports = { NetworkManager, getLocalIp };
