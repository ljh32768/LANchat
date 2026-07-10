import { useState } from 'react';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useFilesStore } from '../stores/useFilesStore';

export default function MessageInput({ sessionId, disabled }) {
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
      await upload(sessionId, filePath);
      // 文件消息会通过 IPC 返回并由本地 store 补一条；此处主动重载消息
      await useMessagesStore.getState().load(sessionId);
    } catch (e) {
      console.error('upload failed:', e);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="msg-input-area">
      <button className="mi-file-btn" title="发送文件" onClick={handleFile} disabled={disabled || uploading}>
        {uploading ? '⏳' : '📎'}
      </button>
      <textarea
        className="mi-text"
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={disabled ? '会话已结束，无法发送' : '输入讯息…  Enter 发送，Shift+Enter 换行'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
      />
      <button className="mi-send-btn" onClick={handleSend} disabled={disabled || !text.trim()}>
        发送
      </button>
    </div>
  );
}
