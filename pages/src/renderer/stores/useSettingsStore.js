// 设置 store：主题、性能模式
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export const useSettingsStore = create(
  subscribeWithSelector((set, get) => ({
    performanceMode: 'cool',   // 'performance' | 'cool'
    soundEnabled: true,
    loaded: false,

    load: async () => {
      const [perf, sound] = await Promise.all([
        window.api.invoke('settings:get', { key: 'performanceMode', defaultValue: 'cool' }),
        window.api.invoke('settings:get', { key: 'soundEnabled', defaultValue: 'true' })
      ]);
      set({
        performanceMode: perf || 'cool',
        soundEnabled: sound !== 'false',
        loaded: true
      });
    },

    setPerformanceMode: async (mode) => {
      await window.api.invoke('settings:set', { key: 'performanceMode', value: mode });
      set({ performanceMode: mode });
    },

    setSoundEnabled: async (enabled) => {
      await window.api.invoke('settings:set', { key: 'soundEnabled', value: String(enabled) });
      set({ soundEnabled: enabled });
    }
  }))
);
