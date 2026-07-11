import { useEffect, useRef, useState } from 'react';
import { FixedSizeList as List } from 'react-window';
import { SESSION_STATUS } from '../constants';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useClientStore } from '../stores/useClientStore';
import { useContactsStore } from '../stores/useContactsStore';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';

// 文件传输固定端口（与 shared/constants 的 TCP_FILE_PORT_BASE 一致）
const FILE_PORT = 47890;
// 稳定引用的空数组，避免 useSyncExternalStore 的 getSnapshot 无限循环
const EMPTY_MESSAGES = [];
// V14：虚拟列表固定行高
const ITEM_HEIGHT = 80;

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
  const listRef = useRef(null);
  const [containerHeight, setContainerHeight] = useState(400);

  const session = sessions.find((s) => s.session_id === activeSessionId);

  // V14：测量容器高度供 FixedSizeList 使用
  useEffect(() => {
    if (!scrollRef.current) return;
    const updateHeight = () => {
      if (scrollRef.current) setContainerHeight(scrollRef.current.clientHeight);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, []);

  // V14：自动滚动到底部（虚拟列表用 scrollToItem）
  useEffect(() => {
    if (listRef.current && messages.length > 0) {
      listRef.current.scrollToItem(messages.length - 1, 'end');
    }
  }, [messages.length, activeSessionId]);

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

  // V14：虚拟列表行渲染器
  const renderRow = ({ index, style }) => {
    const m = messages[index];
    return (
      <div style={{ ...style, overflow: 'hidden' }}>
        <MessageBubble
          message={m}
          isSelf={m.sender_contact_id === 'self' || m.sender_contact_id === clientId}
          clientId={clientId}
          contacts={contacts}
          peers={peers}
          hostIp={hostIp}
          filePort={FILE_PORT}
          ended={ended}
        />
      </div>
    );
  };

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
        {messages.length > 0 && (
          <List
            height={containerHeight}
            itemCount={messages.length}
            itemSize={ITEM_HEIGHT}
            width="100%"
            ref={listRef}
          >
            {renderRow}
          </List>
        )}
      </div>

      <MessageInput sessionId={session.session_id} disabled={ended} />
    </main>
  );
}
