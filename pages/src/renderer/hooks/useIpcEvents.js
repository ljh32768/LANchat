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
    // V17：消息接收批处理（使用 RAF 聚合更新，避免频繁 React 重渲染）
    // 未读只在此处按条数累加一次（addReceived 不再碰 unread）
    let pendingMessages = [];
    let rafScheduled = false;
    const flushUpdates = () => {
      rafScheduled = false;

      if (pendingMessages.length === 0) return;

      const messageStore = useMessagesStore.getState();
      const sessionStore = useSessionsStore.getState();
      const sessions = sessionStore.sessions;
      const soundOn = useSettingsStore.getState().soundEnabled;
      const batch = pendingMessages;
      pendingMessages = [];

      // 历史同步消息：只入库，不涨未读、不响提示
      const live = [];
      for (const msg of batch) {
        messageStore.addReceived(msg);
        if (msg.source === 'history') continue;
        live.push(msg);
        sessionStore.incrementUnread(msg.session_id);
      }

      // 私聊强反馈：本批最多触发一次，避免历史/刷屏时连闪
      const hasPrivateLive = live.some((msg) => {
        const session = sessions.find((s) => s.session_id === msg.session_id);
        return session?.type === 'private';
      });
      if (hasPrivateLive) {
        if (soundOn && !document.hasFocus()) playMessageSound();
        if (!document.hasFocus()) {
          window.api.invoke('window:flash').catch(() => {});
        }
        document.body.classList.add('pulse-border');
        setTimeout(() => document.body.classList.remove('pulse-border'), 1200);
      }
    };

    unsubs.push(
      window.api.on('message:received', (msg) => {
        pendingMessages.push(msg);
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flushUpdates);
        }
      })
    );
    // V15：文件下载进度用 rAF 节流，避免每个 TCP 块都触发 React 重渲染
    let pendingProgress = {};
    let progressRafScheduled = false;
    const flushProgress = () => {
      progressRafScheduled = false;
      const store = useFilesStore.getState();
      for (const [fid, p] of Object.entries(pendingProgress)) {
        store.setProgress(fid, p);
      }
      pendingProgress = {};
    };
    unsubs.push(
      window.api.on('file:download-progress', ({ file_id, progress }) => {
        pendingProgress[file_id] = progress;
        if (!progressRafScheduled) {
          progressRafScheduled = true;
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

    // V16：事件驱动的会话发现（移除 4 秒轮询，改用事件驱动）
    // 主进程在会话被发现/移除时会发送相应事件，无需轮询

    return () => {
      unsubs.forEach((u) => u && u());
    };
  }, []);
}
