// 消息 store：按会话维护消息流
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useSessionsStore } from './useSessionsStore';

export const useMessagesStore = create(
  subscribeWithSelector((set, get) => ({
    messagesBySession: {},   // session_id -> [msg]
    loadedSessions: new Set(),

    getMessages: (sessionId) => get().messagesBySession[sessionId] || [],

    load: async (sessionId) => {
      if (!sessionId) return;
      const msgs = await window.api.invoke('message:list', sessionId);
      set((state) => ({
        messagesBySession: { ...state.messagesBySession, [sessionId]: msgs },
        loadedSessions: new Set([...state.loadedSessions, sessionId])
      }));
    },

    send: async (sessionId, content, type = 'text') => {
      const res = await window.api.invoke('message:send', { session_id: sessionId, content, type });
      const msg = {
        message_id: res.message_id,
        session_id: sessionId,
        sender_contact_id: 'self',
        content,
        type,
        timestamp: res.timestamp,
        local_id: res.local_id
      };
      set((state) => {
        const list = state.messagesBySession[sessionId] || [];
        return { messagesBySession: { ...state.messagesBySession, [sessionId]: [...list, msg] } };
      });
      return msg;
    },

    addReceived: (msg) => {
      const sessionId = msg.session_id;
      set((state) => {
        const list = state.messagesBySession[sessionId] || [];
        if (list.some((m) => m.message_id === msg.message_id)) return state;
        return { messagesBySession: { ...state.messagesBySession, [sessionId]: [...list, msg] } };
      });
      useSessionsStore.getState().incrementUnread(sessionId);
    },

    clear: (sessionId) => {
      set((state) => {
        const next = { ...state.messagesBySession };
        delete next[sessionId];
        return { messagesBySession: next };
      });
    }
  }))
);
