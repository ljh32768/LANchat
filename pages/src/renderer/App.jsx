import { useEffect, useState } from 'react';
import { useClientStore } from './stores/useClientStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSessionsStore } from './stores/useSessionsStore';
import { useContactsStore } from './stores/useContactsStore';
import { useIpcEvents } from './hooks/useIpcEvents';
import LoginScreen from './components/LoginScreen';
import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import SettingsPanel from './components/SettingsPanel';
import NewSessionModal from './components/NewSessionModal';

export default function App() {
  const [booted, setBooted] = useState(false);
  const [entered, setEntered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);

  const initClient = useClientStore((s) => s.init);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadSessions = useSessionsStore((s) => s.load);
  const loadContacts = useContactsStore((s) => s.load);
  const addDiscovered = useSessionsStore((s) => s.addDiscovered);

  useIpcEvents();

  useEffect(() => {
    (async () => {
      await initClient();
      await loadSettings();
      await loadSessions();
      await loadContacts();
      try {
        const data = await window.api.invoke('network:get-discovered');
        data.sessions.forEach((s) => addDiscovered(s));
      } catch {}
      setBooted(true);
    })();
  }, []);

  if (!booted) {
    return (
      <div className="app-shell">
        <div className="boot-screen">
          <div className="boot-logo">LAN·CHATROOM</div>
          <div className="boot-spinner" />
          <div className="boot-text">系统初始化中…</div>
        </div>
      </div>
    );
  }

  if (!entered) {
    return <LoginScreen onEnter={() => setEntered(true)} />;
  }

  return (
    <div className="app-shell">
      <TitleBar onSettings={() => setShowSettings(true)} />
      <div className="app-body">
        <Sidebar onNewSession={() => setShowNewSession(true)} />
        <ChatView />
      </div>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showNewSession && <NewSessionModal onClose={() => setShowNewSession(false)} />}
    </div>
  );
}
