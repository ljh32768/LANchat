import { useFilesStore } from '../stores/useFilesStore';
import { resolveIdentity } from '../utils/identity';
import { useT, useLocaleStore } from '../locales/useLocale';

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

function getFileIcon(fileName) {
  if (!fileName) return '📎';
  const ext = fileName.split('.').pop().toLowerCase();
  const map = {
    pdf: '📄', doc: '📘', docx: '📘', txt: '📄',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', webp: '🖼️', svg: '🖼️',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', gz: '🗜️', tar: '🗜️',
    exe: '⚙️', msi: '⚙️', bat: '⚙️',
    mp3: '🎵', wav: '🎵', flac: '🎵',
    mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬',
    xls: '📊', xlsx: '📊', csv: '📊',
    ppt: '📽️', pptx: '📽️',
  };
  return map[ext] || '📎';
}

export default function MessageBubble({ message, isSelf, clientId, contacts, peers, hostIp, filePort, ended }) {
  const t = useT();
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
  const status = useFilesStore((s) => s.status[meta.file_id] ?? (isSelf ? 'completed' : 'pending'));
  const isEmpty = !meta.file_size || meta.file_size === 0;

  return (
    <div className="file-card">
      <div className="file-icon">{getFileIcon(meta.file_name)}</div>
      <div className="file-info">
        <div className="file-name" title={meta.file_name}>{meta.file_name}</div>
        <div className="file-size">{formatSize(meta.file_size)}</div>
        {status === 'failed' && <div className="file-failed">{t('msg.downloadFailed')}</div>}
      </div>
      <div className="file-action">
        {isEmpty ? (
          <span className="file-unavail">{t('msg.emptyFile')}</span>
        ) : isSelf ? (
          <span className="file-done">{t('msg.cached')}</span>
        ) : status === 'completed' ? (
          <span className="file-done">{t('msg.downloaded')}</span>
        ) : status === 'downloading' ? (
          <FileRing progress={progress} />
        ) : status === 'failed' ? (
          <button className="file-dl-btn" onClick={onResume}>{t('msg.retry')}</button>
        ) : ended ? (
          <span className="file-unavail">{t('msg.unavailable')}</span>
        ) : (
          <button className="file-dl-btn" onClick={onDownload}>{t('msg.download')}</button>
        )}
      </div>
    </div>
  );
}

function FileRing({ progress }) {
  const p = Math.round((progress ?? 0) * 100);
  const r = 11;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - (progress ?? 0));
  return (
    <div className="file-ring" title={p + '%'}>
      <svg width="28" height="28" viewBox="0 0 28 28">
        <circle cx="14" cy="14" r={r} fill="none" stroke="#E8EAED" strokeWidth="3" />
        <circle
          cx="14" cy="14" r={r} fill="none" stroke="var(--primary)" strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform="rotate(-90 14 14)"
        />
      </svg>
      <span className="file-ring-pct">{p}%</span>
    </div>
  );
}
