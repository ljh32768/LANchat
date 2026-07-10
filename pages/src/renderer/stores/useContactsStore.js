// 联系人 store
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export const useContactsStore = create(
  subscribeWithSelector((set, get) => ({
    contacts: [],
    onlineIds: new Set(),
    peers: [],   // 在线用户：[{ client_id, nickname, ip }]

    load: async () => {
      const contacts = await window.api.invoke('contacts:list');
      set({ contacts });
    },

    setOnline: (clientId, online, peer) => {
      const next = new Set(get().onlineIds);
      let peers = get().peers;
      if (online) {
        next.add(clientId);
        if (peer) {
          const idx = peers.findIndex((p) => p.client_id === clientId);
          if (idx >= 0) peers = peers.map((p, i) => (i === idx ? { ...p, ...peer } : p));
          else peers = [...peers, peer];
        }
      } else {
        next.delete(clientId);
        peers = peers.filter((p) => p.client_id !== clientId);
      }
      set({ onlineIds: next, peers });
    },

    setAlias: async (contactId, alias) => {
      const contacts = await window.api.invoke('contacts:set-alias', { contact_id: contactId, alias });
      set({ contacts });
    },

    toggleFavorite: async (contactId) => {
      const contacts = await window.api.invoke('contacts:toggle-favorite', contactId);
      set({ contacts });
    },

    upsertLocal: (contact) => {
      const list = get().contacts;
      const idx = list.findIndex((c) => c.contact_id === contact.contact_id);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = { ...next[idx], ...contact };
        set({ contacts: next });
      } else {
        set({ contacts: [contact, ...list] });
      }
    }
  }))
);
