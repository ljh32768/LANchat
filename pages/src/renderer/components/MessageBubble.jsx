import { useFilesStore } from '../stores/useFilesStore';
import { resolveIdentity } from '../utils/identity';

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

export default function MessageBubble({ message, isSelf, clientId, contacts, peers, hostIp, filePort, ended }) {
  const download = useFilesStore((s) => s.download);
  const resume = useFilesStore((s) => s.resume);

  // 身份解析（仅对收到的消息需要复杂显示）
  const identity = isSelf
    ? { segs: [{ text: '我', cls: 'id-name' }], tooltip: null }
    : resolveIdentity(
        { contact_id: message.sender_contact_id, ip: contacts.find((c) => c.contact_id === message.sender_contact_id)?.last_seen_ip },
        peers,
        contacts
      );

  const isFile = message.type === 'file';
  let fileMeta = null;
  if (isFile) {
    try { fileMeta = JSON.parse(message.content); } catch {}
  }

  return (
    <div className={`msg-row ${isSelf ? 'self' : 'other'}`}>
      <div className="msg-bubble">
        {!isSelf && (
          <div className="msg-sender" title={identity.tooltip || ''}>
            {identity.segs.map((seg, i) => (
              <span key={i} className={seg.cls}>{seg.text}</span>
            ))}
            {identity.tooltip && <span className="id-warn"> ⚠</span>}
          </div>
        )}
        {isFile && fileMeta ? (
          <FileCard
            meta={fileMeta}
            isSelf={isSelf}
            ended={ended}
            onDownload={() => fileMeta.file_id && hostIp && download(fileMeta.file_id, hostIp, filePort)}
            onResume={() => fileMeta.file_id && hostIp && resume(fileMeta.file_id, hostIp, filePort)}
          />
        ) : (
          <div className="msg-text">{message.content}</div>
        )}
        <div className="msg-time">{formatTime(message.timestamp)}</div>
      </div>
    </div>
  );
}

function FileCard({ meta, isSelf, ended, onDownload, onResume }) {
  const progress = useFilesStore((s) => s.progress[meta.file_id] ?? null);
  // 仅发送方（isSelf）本机拥有原文件 → completed；主机作为接收方仍需下载
  const status = useFilesStore((s) => s.status[meta.file_id] ?? (isSelf ? 'completed' : 'pending'));

  return (
    <div className="file-card">
      <div className="file-icon">▮</div>
      <div className="file-info">
        <div className="file-name" title={meta.file_name}>{meta.file_name}</div>
        <div className="file-size">{formatSize(meta.file_size)}</div>
        {status === 'downloading' && progress != null && (
          <div className="file-progress">
            <div className="file-progress-bar" style={{ width: Math.round(progress * 100) + '%' }} />
            <span>{Math.round(progress * 100)}%</span>
          </div>
        )}
        {status === 'failed' && <div className="file-failed">下载失败</div>}
      </div>
      <div className="file-action">
        {isSelf ? (
          <span className="file-done">已暂存</span>
        ) : status === 'completed' ? (
          <span className="file-done">已下载</span>
        ) : status === 'downloading' ? (
          <span className="file-busy">传输中</span>
        ) : status === 'failed' ? (
          <button className="file-dl-btn" onClick={onResume}>续传</button>
        ) : ended ? (
          <span className="file-unavail">不可用</span>
        ) : (
          <button className="file-dl-btn" onClick={onDownload}>下载</button>
        )}
      </div>
    </div>
  );
}
