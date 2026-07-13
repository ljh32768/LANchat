import { useState } from 'react';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useContactsStore } from '../stores/useContactsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useClientStore } from '../stores/useClientStore';
import { resolveIdentity } from '../utils/identity';

export default function Sidebar({ onNewSession }) {
  const sessions = useSessionsStore((s) => s.sessions);
  const discovered = useSessionsStore((s) => s.discovered);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const unread = useSessionsStore((s) => s.unread);
  const setActive = useSessionsStore((s) => s.setActive);
  const join = useSessionsStore((s) => s.join);
  const remove = useSessionsStore((s) => s.remove);
  const contacts = useContactsStore((s) => s.contacts);
  const onlineIds = useContactsStore((s) => s.onlineIds);
  const peers = useContactsStore((s) => s.peers);
  const toggleFavorite = useContactsStore((s) => s.toggleFavorite);
  const setAlias = useContactsStore((s) => s.setAlias);
  const loadMessages = useMessagesStore((s) => s.load);
  const clientId = useClientStore((s) => s.clientId);

  const openSession = async (sid) => {
    await loadMessages(sid);
    setActive(sid);
  };

  const handleJoin = async (s) => {
    await join(s);
    await loadMessages(s.session_id);
  };

  const activeSessions = sessions.filter((s) => s.status === 'active');
  const endedSessions = sessions.filter((s) => s.status === 'ended');
  const joinedIds = new Set(sessions.map((s) => s.session_id));
  const discoverable = discovered.filter((s) => !joinedIds.has(s.session_id) && s.host_contact_id !== clientId && s.type !== 'private');

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">通讯矩阵</span>
        <button className="btn-new" onClick={onNewSession}>＋ 新建</button>
      </div>

      <div className="sidebar-scroll">
        <Section title="活跃会话" count={activeSessions.length}>
          {activeSessions.length === 0 && <Empty text="尚无活跃会话" />}
          {activeSessions.map((s) => (
            <SessionItem
              key={s.session_id}
              name={s.name}
              type={s.type}
              active={s.session_id === activeSessionId}
              unread={unread[s.session_id] || 0}
              onClick={() => openSession(s.session_id)}
            />
          ))}
        </Section>

        {discoverable.length > 0 && (
          <Section title="局域网发现" count={discoverable.length}>
            {discoverable.map((s) => (
              <DiscoveredItem
                key={s.session_id}
                name={s.name}
                type={s.type}
                members={s.member_count}
                onClick={() => handleJoin(s)}
              />
            ))}
          </Section>
        )}

        {discoverable.length === 0 && (
          <Section title="局域网发现" count={0}>
            <Empty text="未发现可加入的会话" />
          </Section>
        )}

        {endedSessions.length > 0 && (
          <Section title="已结束" count={endedSessions.length}>
            {endedSessions.map((s) => (
              <SessionItem
                key={s.session_id}
                name={s.name}
                type={s.type}
                ended
                active={s.session_id === activeSessionId}
                unread={0}
                onClick={() => openSession(s.session_id)}
                onDelete={() => remove(s.session_id)}
              />
            ))}
          </Section>
        )}

        <Section title="联系人" count={contacts.length}>
          {contacts.length === 0 && <Empty text="尚未发现其他用户" />}
          {contacts.map((c) => (
            <ContactItem
              key={c.contact_id}
              contact={c}
              peers={peers}
              contacts={contacts}
              online={onlineIds.has(c.contact_id)}
              self={c.contact_id === clientId}
              onToggleFavorite={toggleFavorite}
              onSetAlias={setAlias}
            />
          ))}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, count, children }) {
  return (
    <div className="sb-section">
      <div className="sb-section-title">{title} <span className="sb-count">{count}</span></div>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <div className="sb-empty">{text}</div>;
}

function SessionItem({ name, type, active, ended, unread, onClick, onDelete }) {
  return (
    <div className={`sb-item-row ${ended ? 'ended' : ''}`}>
      <button className={`sb-item ${active ? 'active' : ''} ${ended ? 'ended' : ''}`} onClick={onClick}>
        <span className="sb-icon">{type === 'private' ? '◈' : '⬡'}</span>
        <span className="sb-name">{name}</span>
        {ended && <span className="sb-tag ended-tag">已结束</span>}
        {!ended && unread > 0 && <span className="sb-unread">{unread}</span>}
      </button>
      {ended && onDelete && (
        <button className="sb-del" title="删除会话" onClick={onDelete}>✕</button>
      )}
    </div>
  );
}

function DiscoveredItem({ name, type, members, onClick }) {
  return (
    <button className="sb-item discovered" onClick={onClick}>
      <span className="sb-icon">{type === 'private' ? '◈' : '⬡'}</span>
      <span className="sb-name">{name}</span>
      <span className="sb-members">{members}人</span>
      <span className="sb-join">加入</span>
    </button>
  );
}

function ContactItem({ contact, peers, contacts, online, self, onToggleFavorite, onSetAlias }) {
  const [editing, setEditing] = useState(false);
  const [aliasInput, setAliasInput] = useState('');

  // 身份防伪造层级解析（联系人列表不显示 IP，会话内消息气泡才显示）
  const identity = resolveIdentity(
    { contact_id: contact.contact_id, nickname: contact.nickname, ip: contact.last_seen_ip },
    peers,
    contacts,
    false
  );

  const startEdit = () => {
    setAliasInput(contact.alias || '');
    setEditing(true);
  };
  const saveAlias = () => {
    const trimmed = aliasInput.trim();
    onSetAlias(contact.contact_id, trimmed || null);
    setEditing(false);
  };

  return (
    <div className={`sb-item contact ${identity.level >= 3 ? 'warn' : ''}`} title={identity.tooltip || ''}>
      <span className={`sb-dot ${online ? 'on' : 'off'}`} />
      {editing ? (
        <input
          className="sb-alias-input"
          autoFocus
          value={aliasInput}
          onChange={(e) => setAliasInput(e.target.value)}
          onBlur={saveAlias}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveAlias();
            if (e.key === 'Escape') setEditing(false);
          }}
          placeholder="备注名"
        />
      ) : (
        <>
          <span className="sb-name">
            {identity.segs.map((seg, i) => (
              <span key={i} className={seg.cls}>{seg.text}</span>
            ))}
            {self && '（我）'}
          </span>
          {contact.is_favorite && <span className="sb-star">★</span>}
          {!self && (
            <div className="sb-contact-actions">
              <button
                className="sb-action"
                title={contact.is_favorite ? '取消星标' : '星标联系人'}
                onClick={() => onToggleFavorite(contact.contact_id)}
              >
                {contact.is_favorite ? '☆' : '★'}
              </button>
              <button className="sb-action" title="设置备注名" onClick={startEdit}>✎</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
