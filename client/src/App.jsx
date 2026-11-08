import { clearOutbox } from './outbox.js';
import { refreshPush } from './push.js';
import { useEffect, useState } from 'react';
import { api, setMailboxId } from './api.js';
import { parseLocation, setHosts, loginHref } from './nav.js';
import Login from './components/Login.jsx';
import Mail from './components/Mail.jsx';
import { ToastProvider } from './components/Toast.jsx';
import SetupWizard from './components/SetupWizard.jsx';

const route = parseLocation();
if (route.id) setMailboxId(route.id);

export default function App() {
  const [me, setMe] = useState(undefined);
  const [hostsReady, setHostsReady] = useState(false);
  // keep the wizard open through its optional steps once it started
  const [wizardOpen, setWizardOpen] = useState(true);
  useEffect(() => { api.signupConfig().then(setHosts).catch(() => {}).finally(() => setHostsReady(true)); }, []);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const refreshMe = () => api.me().then(setMe).catch(() => setMe(null));
  useEffect(() => { if (me) refreshPush(); }, [me?.email]); // keeps this device's notifications from expiring
  // Back from Stripe checkout: confirm the payment with the server (which asks Stripe directly)
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (['success', 'canceled', 'portal'].includes(p.get('billing')) && me) {
      const sid = p.get('session_id');
      history.replaceState(null, '', location.pathname);
      localStorage.setItem('startBusiness', '1');
      if (sid) api.post('/api/billing/confirm', { sessionId: sid }).then(() => refreshMe()).catch(() => {});
    }
  }, [!!me]);
  // From the website's "Set up your domain" button: open the business set-up, remembering monthly/yearly
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('setup') === 'domain') {
      localStorage.setItem('startBusiness', '1');
      if (['monthly', 'yearly'].includes(p.get('billing'))) localStorage.setItem('preferredBilling', p.get('billing') === 'yearly' ? 'year' : 'month');
      history.replaceState(null, '', location.pathname);
    }
  }, []);
  useEffect(() => {
    if (!route.id) { setMe(null); return undefined; }
    refreshMe();
    const onExpired = () => setMe(null);
    const on2fa = () => refreshMe();
    window.addEventListener('auth:expired', onExpired);
    window.addEventListener('auth:2fa', on2fa);
    return () => { window.removeEventListener('auth:expired', onExpired); window.removeEventListener('auth:2fa', on2fa); };
  }, []);

  // Signed out (or the session ended) while on a mailbox URL: go to the sign-in page
  useEffect(() => { if (route.id && me === null && hostsReady) location.assign(loginHref()); }, [me, hostsReady]);
  const afterAuth = (r) => location.assign(r?.redirect || '/');
  const signOut = async (all) => {
    // Forget the offline copy of mail and anything waiting in the Outbox on this device
    navigator.serviceWorker?.controller?.postMessage({ type: 'signout' });
    await clearOutbox().catch(() => {});
    api.post('/api/logout', all ? { all: true } : {}).finally(() => location.assign(loginHref()));
  };

  if (me === undefined || !hostsReady || (route.id && !me)) return <div className="splash"><div className="spinner" /></div>;
  return (
    <ToastProvider>
      {me && (me.setup?.setupRequired?.length || (me.setup && !me.setup.onboarded && wizardOpen)) ? (
        <SetupWizard me={me} onDone={() => { setWizardOpen(false); refreshMe(); }} onLogout={() => signOut(false)} />
      ) : me ? (
        <Mail me={me} route={route} refreshMe={refreshMe} theme={theme} setTheme={setTheme} onLogout={signOut} />
      ) : (
        <Login mode={route.page} onLogin={afterAuth} />
      )}
    </ToastProvider>
  );
}
