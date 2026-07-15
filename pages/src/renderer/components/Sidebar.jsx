import { useState } from 'react';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useContactsStore } from '../stores/useContactsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useClientStore } from '../stores/useClientStore';
import { resolveIdentity } from '../utils/identity';
import { useT } from '../locales/useLocale';

export default function Sidebar({ onNewSession }) {
  const t = useT();
  const sessions = useSessionsStore((s) => s.sessions);
  const discovered = useSessionsStore((s) => s.discovered);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const unread = useSessionsStore((s) => s.unread);
  const setActive = useSessionsStore((s) => s.setActive);
  const openPrivate = useSessionsStore((s) => s.openPrivate);
  const join = useSessionsStore((s) => s.join);
  const remove = useSessionsStore((s) => s.remove);
  const contacts = useContactsStore((s) => s.contacts);
  const onlineIds = useContactsStore((s) => s.onlineIds);
  const peers = useContactsStore((s) => s.peers);
  const setAlias = useContactsStore((s) => s.setAlias);
  const deleteContact = useContactsStore((s) => s.deleteContact);
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

  // 当前活跃私聊的对方 contact_id（用于联系人高亮）
  const activeSession = sessions.find((s) => s.session_id === activeSessionId);
  const activePrivatePeer = activeSession && activeSession.type === 'private'
    ? (activeSession.host_contact_id === clientId ? activeSession.peer_contact_id : activeSession.host_contact_id)
    : null;

  // 仅显示群聊活跃会话；私聊不在此列表
  const activeSessions = sessions.filter((s) => s.status === 'active' && s.type !== 'private');
  const endedSessions = sessions.filter((s) => s.status === 'ended');
  const joinedIds = new Set(sessions.map((s) => s.session_id));
  const discoverable = discovered.filter((s) => !joinedIds.has(s.session_id) && s.host_contact_id !== clientId && s.type !== 'private');

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">{t('sidebar.title')}</span>
        <button className="btn-new" onClick={onNewSession}>{t('sidebar.newSession')}</button>
      </div>

      <div className="sidebar-scroll">
        <Section title={t('sidebar.activeSessions')} count={activeSessions.length}>
          {activeSessions.length === 0 && <Empty text={t('sidebar.noActiveSessions')} />}
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
          <Section title={t('sidebar.discovered')} count={discoverable.length}>
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
          <Section title={t('sidebar.discovered')} count={0}>
            <Empty text={t('sidebar.noDiscovered')} />
          </Section>
        )}

        {endedSessions.length > 0 && (
          <Section title={t('sidebar.ended')} count={endedSessions.length}>
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

        <Section title={t('sidebar.contacts')} count={contacts.length}>
          {contacts.length === 0 && <Empty text={t('sidebar.noContacts')} />}
          {contacts.map((c) => {
            // 找到该联系人的私聊 session 以显示未读
            const privateSession = sessions.find(
              (s) => s.type === 'private' &&
                (s.host_contact_id === c.contact_id || s.peer_contact_id === c.contact_id)
            );
            const privateUnread = privateSession ? (unread[privateSession.session_id] || 0) : 0;
            return (
              <ContactItem
                key={c.contact_id}
                contact={c}
                peers={peers}
                contacts={contacts}
                online={onlineIds.has(c.contact_id)}
                self={c.contact_id === clientId}
                active={activePrivatePeer === c.contact_id}
                unread={privateUnread}
                onOpenPrivate={async () => {
                  const s = await openPrivate(c.contact_id, c.nickname);
                  if (s && !s.error) await loadMessages(s.session_id);
                }}
                onSetAlias={setAlias}
                onDeleteContact={deleteContact}
              />
            );
          })}
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
  const t = useT();
  return (
    <div className={`sb-item-row ${ended ? 'ended' : ''}`}>
      <button className={`sb-item ${active ? 'active' : ''} ${ended ? 'ended' : ''}`} onClick={onClick}>
        <span className="sb-icon">{type === 'private' ? '◈' : '⬡'}</span>
        <span className="sb-name">{name}</span>
        {ended && <span className="sb-tag ended-tag">{t('sidebar.endedTag')}</span>}
        {!ended && unread > 0 && <span className="sb-unread">{unread}</span>}
      </button>
      {ended && onDelete && (
        <button className="sb-del" title={t('sidebar.deleteSession')} onClick={onDelete}>✕</button>
      )}
    </div>
  );
}

function DiscoveredItem({ name, type, members, onClick }) {
  const t = useT();
  return (
    <button className="sb-item discovered" onClick={onClick}>
      <span className="sb-icon">{type === 'private' ? '◈' : '⬡'}</span>
      <span className="sb-name">{name}</span>
      <span className="sb-members">{t('sidebar.members', { n: members })}</span>
      <span className="sb-join">{t('sidebar.join')}</span>
    </button>
  );
}

function ContactItem({ contact, peers, contacts, online, self, active, unread, onOpenPrivate, onSetAlias, onDeleteContact }) {
  const t = useT();
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
    <div
      className={`sb-item contact ${identity.level >= 3 ? 'warn' : ''} ${!self ? 'clickable' : ''} ${active ? 'active' : ''}`}
      title={identity.tooltip || ''}
      role={!self ? 'button' : undefined}
      onClick={!self ? () => onOpenPrivate(contact) : undefined}
    >
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
          placeholder={t('sidebar.aliasPlaceholder')}
        />
      ) : (
        <>
          <span className="sb-name">
            {identity.segs.map((seg, i) => (
              <span key={i} className={seg.cls}>{seg.text}</span>
            ))}
            {self && t('sidebar.self')}
            {contact.alias && <span className="sb-alias">{contact.alias}</span>}
          </span>
          {!self && (
            <div className="sb-contact-actions">
              <button className="sb-action" title={t('sidebar.editAlias')} onClick={(e) => { e.stopPropagation(); startEdit(); }}>✎</button>
              <button className="sb-action sb-del-action" title={t('sidebar.deleteContact')} onClick={(e) => { e.stopPropagation(); onDeleteContact(contact.contact_id); }}>✕</button>
            </div>
          )}
          {!self && unread > 0 && <span className="sb-unread">{unread}</span>}
        </>
      )}
    </div>
  );
}
