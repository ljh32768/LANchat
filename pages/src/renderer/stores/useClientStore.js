// 本机客户端信息 store
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export const useClientStore = create(
  subscribeWithSelector((set) => ({
    clientId: null,
    nickname: '',
    createdAt: null,
    ip: null,
    initialized: false,

    init: async () => {
      const info = await window.api.invoke('client:init');
      set({
        clientId: info.client_id,
        nickname: info.nickname,
        createdAt: info.created_at,
        ip: info.ip,
        initialized: true
      });
      return info;
    },

    setNickname: async (nickname) => {
      const info = await window.api.invoke('client:set-nickname', nickname);
      set({ nickname: info.nickname, ip: info.ip });
      return info;
    }
  }))
);
