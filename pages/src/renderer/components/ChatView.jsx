import { useEffect, useRef } from 'react';
import { SESSION_STATUS } from '../constants';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useClientStore } from '../stores/useClientStore';
import { useContactsStore } from '../stores/useContactsStore';
import { useFilesStore } from '../stores/useFilesStore';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';

// 文件传输默认端口（与 shared/constants 的 TCP_FILE_PORT_BASE 一致）
// 实际使用时优先从 discovered session 的 file_port 获取
const DEFAULT_FILE_PORT = 47890;
// 稳定引用的空数组，避免 selector 在消息未加载时每次渲染创建新引用导致无限重渲染
const EMPTY_MESSAGES = [];

export default function ChatView() {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const sessions = useSessionsStore((s) => s.sessions);
  const discovered = useSessionsStore((s) => s.discovered);
  const close = useSessionsStore((s) => s.close);
  const leave = useSessionsStore((s) => s.leave);
  const messages = useMessagesStore((s) =>
    activeSessionId ? (s.messagesBySession[activeSessionId] || EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const clientId = useClientStore((s) => s.clientId);
  const selfIp = useClientStore((s) => s.ip);
  const contacts = useContactsStore((s) => s.contacts);
  const peers = useContactsStore((s) => s.peers);
  const scrollRef = useRef(null);

  const session = sessions.find((s) => s.session_id === activeSessionId);

  // 自动滚动到底部（原生滚动，无虚拟列表双重渲染）
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, activeSessionId]);

  // 切换会话时从 DB 恢复文件状态（避免重启后状态丢失）
  useEffect(() => {
    if (activeSessionId) {
      useFilesStore.getState().loadSessionFiles(activeSessionId);
    }
  }, [activeSessionId]);

  if (!session) {
    return (
      <main className="chat-view empty">
        <div className="chat-placeholder">
          <div className="ph-glyph">⬡</div>
          <div className="ph-title">选择一个会话开始通讯</div>
          <div className="ph-sub">或新建会话 / 加入局域网发现的会话</div>
        </div>
      </main>
    );
  }

  const isHost = session.host_contact_id === clientId;
  const ended = session.status === SESSION_STATUS.ENDED;
  const hostInfo = discovered.find((d) => d.session_id === session.session_id);
  // 主机不在自己的 discovered 列表中，下载文件时回退使用本机 IP
  const hostIp = hostInfo?.host_ip || (isHost ? selfIp : undefined);
  // 文件端口：优先从 discovered session 获取，主机回退到默认端口
  const filePort = hostInfo?.file_port || DEFAULT_FILE_PORT;

  return (
    <main className="chat-view">
      <header className="chat-header">
        <div className="chat-title">
          <span className="chat-type">{session.type === 'private' ? '◈ 私聊' : '⬡ 群聊'}</span>
          <span className="chat-name">{session.name}</span>
          {isHost && <span className="chat-host">主机</span>}
          {ended && <span className="chat-ended-tag">已结束</span>}
        </div>
        {!ended && (
          <button
            className="chat-close"
            onClick={() => (isHost ? close(session.session_id) : leave(session.session_id))}
          >
            {isHost ? '解散会话' : '离开会话'}
          </button>
        )}
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && <div className="chat-empty-msg">暂无消息，发送第一条讯息吧。</div>}
        {messages.map((m) => {
          const isSelf = m.sender_contact_id === 'self' || m.sender_contact_id === clientId;
          return (
            <MessageBubble
              key={m.message_id}
              message={m}
              isSelf={isSelf}
              clientId={clientId}
              contacts={contacts}
              peers={peers}
              hostIp={hostIp}
              filePort={filePort}
              ended={ended}
            />
          );
        })}
      </div>

      <MessageInput sessionId={session.session_id} disabled={ended} />
    </main>
  );
}
