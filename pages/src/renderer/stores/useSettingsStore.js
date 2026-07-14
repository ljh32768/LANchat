// 设置 store：提示音、桌面通知等
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export const useSettingsStore = create(
  subscribeWithSelector((set, get) => ({
    soundEnabled: true,
    desktopNotifyEnabled: true,
    loaded: false,

    load: async () => {
      const [sound, desktopNotify] = await Promise.all([
        window.api.invoke('settings:get', { key: 'soundEnabled', defaultValue: 'true' }),
        window.api.invoke('settings:get', { key: 'desktopNotifyEnabled', defaultValue: 'true' })
      ]);
      const soundEnabled = sound !== 'false';
      const desktopNotifyEnabled = desktopNotify !== 'false';
      set({ soundEnabled, desktopNotifyEnabled, loaded: true });
      // 同步主进程桌面通知开关
      window.api.invoke('notification:set-enabled', { enabled: desktopNotifyEnabled }).catch(() => {});
    },

    setSoundEnabled: async (enabled) => {
      await window.api.invoke('settings:set', { key: 'soundEnabled', value: String(enabled) });
      set({ soundEnabled: enabled });
    },

    setDesktopNotifyEnabled: async (enabled) => {
      await window.api.invoke('settings:set', { key: 'desktopNotifyEnabled', value: String(enabled) });
      await window.api.invoke('notification:set-enabled', { enabled }).catch(() => {});
      set({ desktopNotifyEnabled: enabled });
    }
  }))
);
