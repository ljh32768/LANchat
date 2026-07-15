import { useEffect, useState, useRef } from 'react';
import { SESSION_STATUS } from '../constants';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useClientStore } from '../stores/useClientStore';
import { useContactsStore } from '../stores/useContactsStore';
import { useT } from '../locales/useLocale';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';

const DEFAULT_FILE_PORT = 47890;
const EMPTY_MESSAGES = [];

export default function ChatView() {
  const t = useT();
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const sessions = useSessionsStore((s) => s.sessions);
  const close = useSessionsStore((s) => s.close);
  const leave = useSessionsStore((s) => s.leave);
  const messages = useMessagesStore((s) =>
    activeSessionId ? (s.messagesBySession[activeSessionId] || EMPTY_MESSAGES) : EMPTY_MESSAGES
  );
  const clientId = useClientStore((s) => s.clientId);
  const selfIp = useClientStore((s) => s.ip);
  const contacts = useContactsStore((s) => s.contacts);
  const peers = useContactsStore((s) => s.peers);
  const setAlias = useContactsStore((s) => s.setAlias);
  const scrollRef = useRef(null);

  // hooks 必须在顶层无条件调用
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasInput, setAliasInput] = useState('');

  const session = sessions.find((s) => s.session_id === activeSessionId);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, activeSessionId]);

  if (!session) {
    return (
      <main className="chat-view empty">
        <div className="chat-placeholder">
          <div className="ph-glyph">⬡</div>
          <div className="ph-title">{t('chatview.placeholderTitle')}</div>
          <div className="ph-sub">{t('chatview.placeholderSub')}</div>
        </div>
      </main>
    );
  }

  const isHost = session.host_contact_id === clientId;
  const isPrivate = session.type === 'private';
  const ended = session.status === SESSION_STATUS.ENDED;
  const hostInfo = sessions.find((d) => d.session_id === session.session_id);
  const hostIp = hostInfo?.host_ip || (isHost ? selfIp : undefined);
  const filePort = hostInfo?.file_port || DEFAULT_FILE_PORT;

  // 获取对方展示名（备注优先，否则昵称）
  const peerDisplayName = isPrivate
    ? (() => {
        const peerId = isHost ? session.peer_contact_id : session.host_contact_id;
        const peer = contacts.find((c) => c.contact_id === peerId);
        return peer?.alias || peer?.nickname || session.name;
      })()
    : session.name;

  // 备注保存
  const saveAlias = () => {
    const trimmed = aliasInput.trim();
    setAliasInput(trimmed);
    setEditingAlias(false);
    if (isPrivate && trimmed) {
      const peerId = isHost ? session.peer_contact_id : session.host_contact_id;
      setAlias(peerId, trimmed || null);
    }
  };

  // 初始化编辑
  const startEditAlias = () => {
    const peerId = isHost ? session.peer_contact_id : session.host_contact_id;
    const peer = contacts.find((c) => c.contact_id === peerId);
    setAliasInput(peer?.alias || '');
    setEditingAlias(true);
  };

  return (
    <main className="chat-view">
      <header className="chat-header">
        <div className="chat-title">
          <span className="chat-type">{isPrivate ? t('chatview.privateTag') : t('chatview.groupTag')}</span>
          {editingAlias && isPrivate ? (
            <input
              className="chat-alias-input"
              autoFocus
              value={aliasInput}
              placeholder={t('sidebar.aliasPlaceholder')}
              onChange={(e) => setAliasInput(e.target.value)}
              onBlur={saveAlias}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveAlias();
                if (e.key === 'Escape') setEditingAlias(false);
              }}
            />
          ) : (
            <span className="chat-name">{peerDisplayName}</span>
          )}
          {isPrivate && !editingAlias && (
            <button className="chat-alias-btn" title={t('chatview.editAlias')} onClick={startEditAlias} disabled={ended}>
              ✎
            </button>
          )}
          {isHost && <span className="chat-host">{t('chatview.hostTag')}</span>}
          {ended && <span className="chat-ended-tag">{t('chatview.endedTag')}</span>}
        </div>
        <button
          className="chat-close"
          onClick={() => (isHost ? close(session.session_id) : leave(session.session_id))}
          disabled={ended}
        >
          {isHost ? t('chatview.closeSession') : t('chatview.leaveSession')}
        </button>
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && <div className="chat-empty-msg">{t('chatview.noMessages')}</div>}
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