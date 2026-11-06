import { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './components/Login.jsx';
import Mail from './components/Mail.jsx';
import { ToastProvider } from './components/Toast.jsx';

export default function App() {
  const [me, setMe] = useState(undefined);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const refreshMe = () => api.me().then(setMe).catch(() => setMe(null));
  useEffect(() => {
    refreshMe();
    const onExpired = () => setMe(null);
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  if (me === undefined) return <div className="splash"><div className="spinner" /></div>;
  return (
    <ToastProvider>
      {me ? (
        <Mail me={me} refreshMe={refreshMe} theme={theme} setTheme={setTheme} onLogout={() => api.logout().finally(() => setMe(null))} />
      ) : (
        <Login onLogin={refreshMe} />
      )}
    </ToastProvider>
  );
}
