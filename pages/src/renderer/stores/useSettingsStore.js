// 设置 store：主题、性能模式
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export const useSettingsStore = create(
  subscribeWithSelector((set, get) => ({
    soundEnabled: true,
    loaded: false,

    load: async () => {
      const sound = await window.api.invoke('settings:get', { key: 'soundEnabled', defaultValue: 'true' });
      set({
        soundEnabled: sound !== 'false',
        loaded: true
      });
    },

    setSoundEnabled: async (enabled) => {
      await window.api.invoke('settings:set', { key: 'soundEnabled', value: String(enabled) });
      set({ soundEnabled: enabled });
    }
  }))
);
