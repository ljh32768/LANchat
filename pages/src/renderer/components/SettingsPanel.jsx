import { useState } from 'react';
import { useClientStore } from '../stores/useClientStore';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useT, useLocaleStore } from '../locales/useLocale';

export default function SettingsPanel({ onClose }) {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const nickname = useClientStore((s) => s.nickname);
  const setNickname = useClientStore((s) => s.setNickname);

  const [name, setName] = useState(nickname);
  const [saved, setSaved] = useState(false);

  const saveName = async () => {
    if (!name.trim() || name.trim() === nickname) return;
    await setNickname(name.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('settings.title')}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="setting-row">
            <label>{t('settings.nickname')}</label>
            <div className="setting-inline">
              <input className="setting-input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
              <button className="setting-btn" onClick={saveName} disabled={!name.trim() || name.trim() === nickname}>
                {saved ? t('settings.saved') : t('settings.save')}
              </button>
            </div>
          </div>

          <div className="setting-row">
            <label>{t('settings.language')}</label>
            <div className="setting-modes">
              <button className={`mode-btn ${locale === 'zh' ? 'on' : ''}`} onClick={() => setLocale('zh')}>
                中文
              </button>
              <button className={`mode-btn ${locale === 'en' ? 'on' : ''}`} onClick={() => setLocale('en')}>
                English
              </button>
            </div>
          </div>

          <div className="setting-row">
            <label>{t('settings.dataCleanup')}</label>
            <div className="setting-inline">
              <button
                className="setting-btn"
                onClick={async () => {
                  if (!confirm(t('settings.cleanupConfirm'))) return;
                  try {
                    await window.api.invoke('db:cleanup', { days: 30 });
                    await useSessionsStore.getState().load();
                    useMessagesStore.setState({ messagesBySession: {}, loadedSessions: new Set() });
                    alert(t('settings.cleanupDone'));
                  } catch (e) {
                    alert(t('settings.cleanupFailed') + e.message);
                  }
                }}
              >
                {t('settings.cleanupBtn')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
