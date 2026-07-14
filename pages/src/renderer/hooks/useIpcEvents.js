// 订阅主进程推送事件，更新各 store；并触发通知反馈
import { useEffect } from 'react';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useMessagesStore } from '../stores/useMessagesStore';
import { useFilesStore } from '../stores/useFilesStore';
import { useContactsStore } from '../stores/useContactsStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { playMessageSound } from '../utils/sound';

/** 不计入未读 / 不触发提示的消息来源 */
function isQuietSource(source) {
  return source === 'history' || source === 'self-reply' || source === 'local';
}

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

      // 历史同步 / 本机快捷回复：只入库，不涨未读、不响提示
      const live = [];
      for (const msg of batch) {
        messageStore.addReceived(msg);
        if (isQuietSource(msg.source)) continue;
        live.push(msg);
        // 当前正在看的会话不累加未读
        if (sessionStore.activeSessionId !== msg.session_id) {
          sessionStore.incrementUnread(msg.session_id);
        }
      }

      if (live.length === 0) return;

      // 窗口未聚焦时：轻微提示音（所有会话）；私聊额外闪框/描边
      const unfocused = !document.hasFocus();
      if (unfocused && soundOn) {
        playMessageSound();
      }

      const hasPrivateLive = live.some((msg) => {
        const session = sessions.find((s) => s.session_id === msg.session_id);
        return session?.type === 'private';
      });
      if (hasPrivateLive) {
        if (unfocused) {
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

    // 点击系统桌面通知 → 主进程已聚焦窗口；此处切到对应会话
    unsubs.push(
      window.api.on('notification:clicked', ({ session_id }) => {
        if (!session_id) return;
        useSessionsStore.getState().setActive(session_id);
        // 确保消息列表已加载
        const loaded = useMessagesStore.getState().loadedSessions;
        if (!loaded.has(session_id)) {
          useMessagesStore.getState().load(session_id).catch(() => {});
        }
      })
    );

    // macOS 快捷回复后主进程已发送；渲染层收到 notification:reply 时可做额外 UI（可选）
    // 实际消息会再走 message:received (source=self-reply)
    unsubs.push(
      window.api.on('notification:reply', ({ session_id }) => {
        if (session_id) useSessionsStore.getState().setActive(session_id);
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
