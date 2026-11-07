import { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './components/Login.jsx';
import Mail from './components/Mail.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { TwoFactorGate } from './components/TwoFactorSetup.jsx';

export default function App() {
  const [me, setMe] = useState(undefined);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const refreshMe = () => api.me().then(setMe).catch(() => setMe(null));
  // Back from Stripe checkout: confirm the payment with the server (which asks Stripe directly)
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('billing') && me) {
      const sid = p.get('session_id');
      history.replaceState(null, '', '/');
      localStorage.setItem('startBusiness', '1');
      if (sid) api.post('/api/billing/confirm', { sessionId: sid }).then(() => refreshMe()).catch(() => {});
    }
  }, [!!me]);
  useEffect(() => {
    refreshMe();
    const onExpired = () => setMe(null);
    const on2fa = () => refreshMe();
    window.addEventListener('auth:expired', onExpired);
    window.addEventListener('auth:2fa', on2fa);
    return () => { window.removeEventListener('auth:expired', onExpired); window.removeEventListener('auth:2fa', on2fa); };
  }, []);

  if (me === undefined) return <div className="splash"><div className="spinner" /></div>;
  return (
    <ToastProvider>
      {me && me.twoFactor?.requiredByOrg && !me.twoFactor?.enabled ? (
        <TwoFactorGate me={me} reason="Your organization requires 2-step verification for everyone." onDone={refreshMe} onLogout={() => api.logout().finally(() => setMe(null))} />
      ) : me ? (
        <Mail me={me} refreshMe={refreshMe} theme={theme} setTheme={setTheme} onLogout={() => api.logout().finally(() => setMe(null))} />
      ) : (
        <Login onLogin={refreshMe} />
      )}
    </ToastProvider>
  );
}
