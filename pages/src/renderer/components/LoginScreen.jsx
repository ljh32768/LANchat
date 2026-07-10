import { useState } from 'react';
import { useClientStore } from '../stores/useClientStore';

export default function LoginScreen({ onEnter }) {
  const nickname = useClientStore((s) => s.nickname);
  const clientId = useClientStore((s) => s.clientId);
  const ip = useClientStore((s) => s.ip);
  const setNickname = useClientStore((s) => s.setNickname);
  const [value, setValue] = useState(nickname || '');
  const [busy, setBusy] = useState(false);

  const handleEnter = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      if (value.trim() !== nickname) await setNickname(value.trim());
    } finally {
      setBusy(false);
      onEnter();
    }
  };

  return (
    <div className="app-shell">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-logo">LAN·CHATROOM</div>
        <div className="login-sub">
          局域网通讯终端 // 识别码 {clientId ? clientId.slice(0, 8) : '--------'}
          {ip ? ` @ ${ip}` : ''}
        </div>
        <div className="login-field">
          <label>呼号 / Nickname</label>
          <input
            className="login-input"
            value={value}
            autoFocus
            maxLength={24}
            placeholder="输入你的呼号…"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleEnter()}
          />
        </div>
        <button className="login-btn" disabled={busy || !value.trim()} onClick={handleEnter}>
          {busy ? '连接中…' : '进入终端'}
        </button>
        <div className="login-hint">无需服务器 · 局域网自动发现 · 临时会话</div>
      </div>
    </div>
  );
}
