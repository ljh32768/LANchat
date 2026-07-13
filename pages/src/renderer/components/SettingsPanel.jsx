import { useState } from 'react';
import { useClientStore } from '../stores/useClientStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';

export default function SettingsPanel({ onClose }) {
  const nickname = useClientStore((s) => s.nickname);
  const setNickname = useClientStore((s) => s.setNickname);
  const performanceMode = useSettingsStore((s) => s.performanceMode);
  const setPerformanceMode = useSettingsStore((s) => s.setPerformanceMode);
  const soundEnabled = useSettingsStore((s) => s.soundEnabled);
  const setSoundEnabled = useSettingsStore((s) => s.setSoundEnabled);

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
          <span>系统设置</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="setting-row">
            <label>呼号</label>
            <div className="setting-inline">
              <input className="setting-input" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
              <button className="setting-btn" onClick={saveName} disabled={!name.trim() || name.trim() === nickname}>
                {saved ? '已保存' : '保存'}
              </button>
            </div>
          </div>

          <div className="setting-row">
            <label>视觉模式</label>
            <div className="setting-modes">
              <button
                className={`mode-btn ${performanceMode === 'cool' ? 'on' : ''}`}
                onClick={() => setPerformanceMode('cool')}
              >
                炫酷模式（完整动效）
              </button>
              <button
                className={`mode-btn ${performanceMode === 'performance' ? 'on' : ''}`}
                onClick={() => setPerformanceMode('performance')}
              >
                性能模式（减少动效）
              </button>
            </div>
          </div>

          <div className="setting-row">
            <label>提示音</label>
            <button
              className={`toggle-btn ${soundEnabled ? 'on' : 'off'}`}
              onClick={() => setSoundEnabled(!soundEnabled)}
            >
              {soundEnabled ? '开启' : '关闭'}
            </button>
          </div>

          <div className="setting-row">
            <label>数据清理</label>
            <div className="setting-inline">
              <button
                className="setting-btn"
                onClick={async () => {
                  if (!confirm('确认清理 30 天前的消息？此操作不可撤销。')) return;
                  try {
                    await window.api.invoke('db:cleanup', { days: 30 });
                    // 刷新会话列表和消息，清理 UI 残留
                    await useSessionsStore.getState().load();
                    useMessagesStore.setState({ messagesBySession: {}, loadedSessions: new Set() });
                    alert('清理完成');
                  } catch (e) {
                    alert('清理失败: ' + e.message);
                  }
                }}
              >
                清理 30 天前消息
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
