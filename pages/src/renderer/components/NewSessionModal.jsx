import { useState } from 'react';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useT } from '../locales/useLocale';

export default function NewSessionModal({ onClose }) {
  const t = useT();
  const create = useSessionsStore((s) => s.create);
  const loadMessages = useMessagesStore((s) => s.load);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const session = await create(name.trim(), 'group', null);
      await loadMessages(session.session_id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

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
              placeholder={t('ns.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && handleCreate()}
            />
          </div>
          <div className="setting-hint">{t('ns.groupHint')}</div>
        </div>
        <div className="modal-footer">
          <button className="setting-btn ghost" onClick={onClose}>{t('ns.cancel')}</button>
          <button className="setting-btn" onClick={handleCreate} disabled={busy || !name.trim()}>
            {busy ? t('ns.creating') : t('ns.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
