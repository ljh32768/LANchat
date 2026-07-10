import { useState } from 'react';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useContactsStore } from '../stores/useContactsStore';

export default function NewSessionModal({ onClose }) {
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
          <span>新建会话</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="setting-row">
            <label>会话名称</label>
            <input
              className="setting-input"
              value={name}
              autoFocus
              maxLength={32}
              placeholder={type === 'private' ? '例如：与指挥官的专线' : '例如：控制中心会议室'}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canCreate && handleCreate()}
            />
          </div>
          <div className="setting-row">
            <label>类型</label>
            <div className="setting-modes">
              <button className={`mode-btn ${type === 'group' ? 'on' : ''}`} onClick={() => { setType('group'); setSelectedPeer(null); }}>
                ⬡ 群聊
              </button>
              <button className={`mode-btn ${type === 'private' ? 'on' : ''}`} onClick={() => setType('private')}>
                ◈ 私聊
              </button>
            </div>
          </div>
          {type === 'private' ? (
            <div className="setting-row">
              <label>邀请对象（在线联系人）</label>
              {peers.length === 0 ? (
                <div className="setting-hint">暂无在线联系人，等待其他人启动客户端…</div>
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
              <div className="setting-hint">私聊仅邀请指定对象，不广播到局域网。</div>
            </div>
          ) : (
            <div className="setting-hint">创建后你即为主机，其他人可通过局域网发现并加入。</div>
          )}
        </div>
        <div className="modal-footer">
          <button className="setting-btn ghost" onClick={onClose}>取消</button>
          <button className="setting-btn" onClick={handleCreate} disabled={busy || !canCreate}>
            {busy ? '创建中…' : '创建会话'}
          </button>
        </div>
      </div>
    </div>
  );
}
