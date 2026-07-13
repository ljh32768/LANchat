import { useState } from 'react';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useContactsStore } from '../stores/useContactsStore';
import { useT } from '../locales/useLocale';

export default function NewSessionModal({ onClose }) {
  const t = useT();
  const create = useSessionsStore((s) => s.create);
  const loadMessages = useMessagesStore((s) => s.load);
  const peers = useContactsStore((s) => s.peers);
  const [name, setName] = useState('');
  const [type, setType] = useState('group');
  const [selectedPeer, setSelectedPeer] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    if (type === 'private' && !selectedPeer) return;
    setBusy(true);
    try {
      const invitee = type === 'private' ? {
        ip: selectedPeer.ip,
        client_id: selectedPeer.client_id
      } : null;
      const session = await create(name.trim(), type, invitee);
      await loadMessages(session.session_id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const canCreate = name.trim() && (type === 'group' || selectedPeer);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('ns.title')}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="setting-row">
            <label>{t('ns.sessionName')}</label>
            <input
              className="setting-input"
              value={name}
              autoFocus
              maxLength={32}
              placeholder={type === 'private' ? t('ns.privateNamePlaceholder') : t('ns.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canCreate && handleCreate()}
            />
          </div>
          <div className="setting-row">
            <label>{t('ns.type')}</label>
            <div className="setting-modes">
              <button className={`mode-btn ${type === 'group' ? 'on' : ''}`} onClick={() => { setType('group'); setSelectedPeer(null); }}>
                {t('ns.group')}
              </button>
              <button className={`mode-btn ${type === 'private' ? 'on' : ''}`} onClick={() => setType('private')}>
                {t('ns.private')}
              </button>
            </div>
          </div>
          {type === 'private' ? (
            <div className="setting-row">
              <label>{t('ns.invitee')}</label>
              {peers.length === 0 ? (
                <div className="setting-hint">{t('ns.noOnline')}</div>
              ) : (
                <div className="peer-list">
                  {peers.map((p) => (
                    <button
                      key={p.client_id}
                      className={`peer-item ${selectedPeer?.client_id === p.client_id ? 'on' : ''}`}
                      onClick={() => setSelectedPeer(p)}
                    >
                      <span className="peer-name">{p.nickname}</span>
                      <span className="peer-id">#{p.client_id.slice(0, 6)}</span>
                      <span className="peer-ip">@{p.ip}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="setting-hint">{t('ns.privateHint')}</div>
            </div>
          ) : (
            <div className="setting-hint">{t('ns.groupHint')}</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="setting-btn ghost" onClick={onClose}>{t('ns.cancel')}</button>
          <button className="setting-btn" onClick={handleCreate} disabled={busy || !canCreate}>
            {busy ? t('ns.creating') : t('ns.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
