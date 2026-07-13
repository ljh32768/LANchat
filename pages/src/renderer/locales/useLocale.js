import { create } from 'zustand';
import zh from './zh.json';
import en from './en.json';

const locales = { zh, en };

export const useLocaleStore = create((set, get) => ({
  locale: 'zh',
  messages: zh,

  load: async () => {
    const saved = await window.api.invoke('settings:get', { key: 'language', defaultValue: 'zh' });
    const locale = saved === 'en' ? 'en' : 'zh';
    set({ locale, messages: locales[locale] });
  },

  setLocale: async (locale) => {
    await window.api.invoke('settings:set', { key: 'language', value: locale });
    set({ locale, messages: locales[locale] || zh });
  }
}));

export function useT() {
  const messages = useLocaleStore((s) => s.messages);
  return (key, params) => {
    let text = messages[key];
    if (text === undefined) text = key;
    if (params && params.n !== undefined) {
      text = text.replace('{n}', params.n);
    }
    return text;
  };
}