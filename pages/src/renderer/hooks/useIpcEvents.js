// 订阅主进程推送事件，更新各 store；并触发通知反馈
import { useEffect } from 'react';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useFilesStore } from '../stores/useFilesStore';
import { useContactsStore } from '../stores/useContactsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { playMessageSound } from '../utils/sound';

export function useIpcEvents() {
  useEffect(() => {
    const unsubs = [];

    unsubs.push(
      window.api.on('network:session-discovered', (session) => {
        useSessionsStore.getState().addDiscovered(session);
      })
    );
    unsubs.push(
      window.api.on('network:session-removed', ({ session_id }) => {
        useSessionsStore.getState().removeDiscovered(session_id);
      })
    );
    unsubs.push(
      window.api.on('network:presence-update', (info) => {
        if (info.client_id !== undefined) {
          const peer = info.online ? { client_id: info.client_id, nickname: info.nickname, ip: info.ip } : null;
          useContactsStore.getState().setOnline(info.client_id, !!info.online, peer);
          // 仅新联系人首次上线时全量 load（写库后同步），已知联系人只更新在线状态，避免频繁重排
          if (info.online) {
            const known = useContactsStore.getState().contacts.some((c) => c.contact_id === info.client_id);
            if (!known) useContactsStore.getState().load();
          }
        }
      })
    );
    unsubs.push(
      window.api.on('message:received', (msg) => {
        useMessagesStore.getState().addReceived(msg);
        // 未读计数（私聊群聊均计）
        useSessionsStore.getState().incrementUnread(msg.session_id);

        // 查找会话类型以差异化反馈
        const sessions = useSessionsStore.getState().sessions;
        const session = sessions.find((s) => s.session_id === msg.session_id);
        const isPrivate = session?.type === 'private';

        if (isPrivate) {
          // 私聊：强反馈（脉冲 + 音效 + 闪烁）
          const soundOn = useSettingsStore.getState().soundEnabled;
          if (soundOn && !document.hasFocus()) playMessageSound();
          if (!document.hasFocus()) {
            window.api.invoke('window:flash').catch(() => {});
          }
          document.body.classList.add('pulse-border');
          setTimeout(() => document.body.classList.remove('pulse-border'), 1200);
        }
        // 群聊：仅未读指示器呼吸灯（incrementUnread 已处理，CSS .sb-unread 自带呼吸动画）
      })
    );
    // V15：文件下载进度用 rAF 节流，避免每个 TCP 块都触发 React 重渲染
    let pendingProgress = {};
    let rafScheduled = false;
    const flushProgress = () => {
      rafScheduled = false;
      const store = useFilesStore.getState();
      for (const [fid, p] of Object.entries(pendingProgress)) {
        store.setProgress(fid, p);
      }
      pendingProgress = {};
    };
    unsubs.push(
      window.api.on('file:download-progress', ({ file_id, progress }) => {
        pendingProgress[file_id] = progress;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flushProgress);
        }
      })
    );
    unsubs.push(
      window.api.on('file:download-complete', ({ file_id, storage_path, error }) => {
        if (error) useFilesStore.getState().setFailed(file_id);
        else useFilesStore.getState().setComplete(file_id, storage_path);
      })
    );
    unsubs.push(
      window.api.on('session:ended', ({ session_id }) => {
        useSessionsStore.getState().markEnded(session_id);
      })
    );
    unsubs.push(
      window.api.on('session:created', () => {
        // 本地新建会话（如收到私聊邀请自动加入），重新加载会话列表
        useSessionsStore.getState().load();
        useContactsStore.getState().load();
      })
    );

    // 定期刷新发现的会话/在线用户
    const refreshTimer = setInterval(async () => {
      const data = await window.api.invoke('network:get-discovered');
      data.sessions.forEach((s) => useSessionsStore.getState().addDiscovered(s));
    }, 4000);

    return () => {
      unsubs.forEach((u) => u && u());
      clearInterval(refreshTimer);
    };
  }, []);
}
