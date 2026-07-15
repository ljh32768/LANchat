// 会话 store：本地会话 + 已发现会话 + 未读计数
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { SESSION_STATUS } from '../constants';

export const useSessionsStore = create(
  subscribeWithSelector((set, get) => ({
    sessions: [],            // 本地记录的会话
    discovered: [],          // 局域网发现的活跃会话
    activeSessionId: null,
    unread: {},              // session_id -> count

    load: async () => {
      const sessions = await window.api.invoke('session:list');
      set({ sessions });
    },

    setActive: (sessionId) => {
      set({ activeSessionId: sessionId });
      if (sessionId) {
        const unread = { ...get().unread };
        delete unread[sessionId];
        set({ unread });
      }
    },

    create: async (name, type, invitee) => {
      const payload = { name, type };
      if (type === 'private' && invitee) {
        payload.invitee_ip = invitee.ip;
        payload.invitee_client_id = invitee.client_id;
      }
      const session = await window.api.invoke('session:create', payload);
      set({ sessions: [session, ...get().sessions], activeSessionId: session.session_id });
      return session;
    },

    // 打开/创建与某联系人的私聊（私聊通过联系人点击进入）
    openPrivate: async (peer_contact_id, peer_nickname) => {
      try {
        const result = await window.api.invoke('session:open-private', { peer_contact_id, peer_nickname });
        if (result && result.error) {
          console.error('[openPrivate] error:', result.error);
          return { error: result.error };
        }
        const session = result;
        set({ sessions: [session, ...get().sessions], activeSessionId: session.session_id });
        return session;
      } catch (e) {
        console.error('[openPrivate] error:', e);
        return { error: e.message };
      }
    },

    join: async (session) => {
      await window.api.invoke('session:join', {
        session_id: session.session_id,
        host_ip: session.host_ip,
        host_port: session.message_port
      });
      set({ activeSessionId: session.session_id });
      // 重新加载本地会话列表
      await get().load();
    },

    close: async (sessionId) => {
      await window.api.invoke('session:close', sessionId);
      const sessions = get().sessions.map((s) =>
        s.session_id === sessionId ? { ...s, status: SESSION_STATUS.ENDED, ended_at: Date.now() } : s
      );
      set({ sessions, activeSessionId: null });
    },

    // 成员退出：仅断开自己的连接 + 删除本地 session 记录（保留消息历史，会话重新出现在发现分区）
    leave: async (sessionId) => {
      await window.api.invoke('session:leave', sessionId);
      const sessions = get().sessions.filter((s) => s.session_id !== sessionId);
      set({ sessions, activeSessionId: null });
    },

    // 删除已结束会话（级联清理消息+文件记录）
    remove: async (sessionId) => {
      await window.api.invoke('session:delete', sessionId);
      const sessions = get().sessions.filter((s) => s.session_id !== sessionId);
      const unread = { ...get().unread };
      delete unread[sessionId];
      set({
        sessions,
        unread,
        activeSessionId: get().activeSessionId === sessionId ? null : get().activeSessionId
      });
    },

    addDiscovered: (session) => {
      const list = get().discovered;
      if (list.some((s) => s.session_id === session.session_id)) {
        set({ discovered: list.map((s) => (s.session_id === session.session_id ? { ...s, ...session } : s)) });
      } else {
        set({ discovered: [...list, session] });
      }
    },

    // 仅从”局域网发现”列表移除；不把本地活跃会话标为 ended
    // （UDP 超时/扫表也会发 session-removed，真正结束走 session:ended）
    removeDiscovered: (sessionId) => {
      set({ discovered: get().discovered.filter((s) => s.session_id !== sessionId) });
    },

    markEnded: (sessionId) => {
      const sessions = get().sessions.map((s) =>
        s.session_id === sessionId ? { ...s, status: SESSION_STATUS.ENDED, ended_at: Date.now() } : s
      );
      set({ sessions });
    },

    incrementUnread: (sessionId) => {
      if (get().activeSessionId === sessionId) return;
      const unread = { ...get().unread };
      unread[sessionId] = (unread[sessionId] || 0) + 1;
      set({ unread });
    }
  }))
);
