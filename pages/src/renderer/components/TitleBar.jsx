import { useClientStore } from '../stores/useClientStore';
import { useT } from '../locales/useLocale';

export default function TitleBar({ onSettings }) {
  const t = useT();
  const nickname = useClientStore((s) => s.nickname);
  const clientId = useClientStore((s) => s.clientId);
  const ip = useClientStore((s) => s.ip);

  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <span className="titlebar-brand">◆ LAN·CHATROOM</span>
        <span className="titlebar-user">
          {nickname} <span className="titlebar-id">#{clientId ? clientId.slice(0, 6) : '------'}</span>
          {ip && <span className="titlebar-ip">@{ip}</span>}
        </span>
      </div>
      <div className="titlebar-actions">
        <button className="tb-btn tb-settings" title={t('titlebar.settings')} onClick={onSettings}>⚙</button>
        <button className="tb-btn tb-min" title={t('titlebar.minimize')} onClick={() => window.api.window.minimize()}>—</button>
        <button className="tb-btn tb-max" title={t('titlebar.maximize')} onClick={() => window.api.window.maximizeToggle()}>▢</button>
        <button className="tb-btn tb-close" title={t('titlebar.close')} onClick={() => window.api.window.close()}>✕</button>
      </div>
    </div>
  );
}
