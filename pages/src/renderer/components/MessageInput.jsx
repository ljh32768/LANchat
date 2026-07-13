import { useState } from 'react';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useFilesStore } from '../stores/useFilesStore';
import { useT } from '../locales/useLocale';

export default function MessageInput({ sessionId, disabled }) {
  const t = useT();
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const send = useMessagesStore((s) => s.send);
  const upload = useFilesStore((s) => s.upload);

  const handleSend = async () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText('');
    try {
      await send(sessionId, t, 'text');
    } catch (e) {
      console.error('send failed:', e);
      setText(t); // 恢复输入内容
    }
  };

  const handleFile = async () => {
    if (disabled || uploading) return;
    const filePath = await window.api.selectFile();
    if (!filePath) return;
    setUploading(true);
    try {
      const res = await upload(sessionId, filePath);
      // 直接添加文件消息到 store，避免 load 竞态导致后续文本消息被覆盖
      if (res && res.file_id) {
        useMessagesStore.setState((state) => {
          const list = state.messagesBySession[sessionId] || [];
          // 幂等：已有该 message_id 则跳过
          if (list.some((m) => m.message_id === res.message_id)) return state;
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: [...list, {
                message_id: res.message_id,
                session_id: sessionId,
                sender_contact_id: 'self',
                content: JSON.stringify({ file_id: res.file_id, file_name: res.file_name, file_size: res.file_size }),
                type: 'file',
                timestamp: res.timestamp,
                local_id: res.local_id
              }]
            }
          };
        });
      }
    } catch (e) {
      console.error('upload failed:', e);
      const reason = e?.message || String(e) || 'unknown error';
      alert(t('input.sendFailed') + reason + '\n\nPlease check your network connection and try again, or ask the session host to recreate the session.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="msg-input-area">
      <button className="mi-file-btn" title={t('input.sendFile')} onClick={handleFile} disabled={disabled || uploading}>
        {uploading ? '⏳' : '📎'}
      </button>
      <textarea
        className="mi-text"
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={disabled ? t('input.endedPlaceholder') : t('input.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      <button className="mi-send-btn" onClick={handleSend} disabled={disabled || !text.trim()}>
        {t('input.send')}
      </button>
    </div>
  );
}
