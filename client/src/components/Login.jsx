import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';

export default function Login({ onLogin }) {
  const resetToken = new URLSearchParams(location.search).get('reset');
  const [mode, setMode] = useState(resetToken ? 'reset' : 'login'); // login | signup | 2fa | forgot | reset
  const [ticket, setTicket] = useState(null);
  const [code, setCode] = useState('');
  const [info, setInfo] = useState('');
  const [cfg, setCfg] = useState({ enabled: false, domain: '' });
  const [form, setForm] = useState({ email: '', password: '', name: '', username: '', confirm: '', recoveryEmail: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [avail, setAvail] = useState(null);
  const timer = useRef();

  const captchaRef = useRef();
  const [captcha, setCaptcha] = useState('');
  useEffect(() => { api.signupConfig().then(setCfg).catch(() => {}); }, []);

  // Optional Cloudflare Turnstile "I am human" check on sign-up
  useEffect(() => {
    if (mode !== 'signup' || !cfg.turnstileSiteKey) return;
    const render = () => window.turnstile?.render(captchaRef.current, { sitekey: cfg.turnstileSiteKey, callback: setCaptcha, 'expired-callback': () => setCaptcha('') });
    if (window.turnstile) return void render();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = render;
    document.head.appendChild(s);
  }, [mode, cfg.turnstileSiteKey]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (mode !== 'signup' || !form.username) return setAvail(null);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.get('/api/signup/check', { username: form.username.toLowerCase() }).then((r) => setAvail(r.available)).catch(() => setAvail(null));
    }, 350);
  }, [form.username, mode]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if ((mode === 'signup' || mode === 'reset') && form.password !== form.confirm) return setError('Passwords don\'t match');
    setBusy(true); setInfo('');
    try {
      if (mode === 'login') {
        const r = await api.login(form.email, form.password);
        if (r.twoFactor) { setTicket(r.ticket); setMode('2fa'); return; }
      } else if (mode === '2fa') {
        await api.post('/api/login/2fa', { ticket, code });
      } else if (mode === 'forgot') {
        const r = await api.post('/api/password/forgot', { email: form.email });
        setInfo(r.message); return;
      } else if (mode === 'reset') {
        const r = await api.post('/api/password/reset', { token: resetToken, password: form.password });
        history.replaceState(null, '', '/');
        setForm((f) => ({ ...f, email: r.email, password: '' })); setMode('login'); setInfo('Password changed. Sign in with your new password.'); return;
      } else await api.signup({ name: form.name, username: form.username.toLowerCase(), password: form.password, captcha, recoveryEmail: form.recoveryEmail });
      await onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-brand">
        <div className="logo-big"><Icon name="mail" size={36} /></div>
        <h1>Mail</h1>
        <p>Fast, private email for you and your business.</p>
        <ul className="login-points">
          <li><Icon name="check" /> Conversations, search and smart folders</li>
          <li><Icon name="check" /> Use your own business domain</li>
          <li><Icon name="check" /> Admin portal to manage your team</li>
        </ul>
      </div>
      <form className="login-card" onSubmit={submit}>
        {cfg.enabled && (mode === 'login' || mode === 'signup') && (
          <div className="seg">
            <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Sign in</button>
            <button type="button" className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>Create account</button>
          </div>
        )}
        <h2>{{ login: 'Sign in', signup: 'Create your free account', '2fa': '2-step verification', forgot: 'Reset your password', reset: 'Choose a new password' }[mode]}</h2>
        {info && <div className="form-info">{info}</div>}
        {mode === 'login' ? (
          <>
            <label>Email address<input type="email" autoComplete="username" required value={form.email} onChange={set('email')} autoFocus /></label>
            <label>Password<input type="password" autoComplete="current-password" required value={form.password} onChange={set('password')} /></label>
            <button type="button" className="link left" onClick={() => { setMode('forgot'); setError(''); setInfo(''); }}>Forgot password?</button>
          </>
        ) : mode === '2fa' ? (
          <>
            <p className="muted">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
            <input className="code-input big" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="123456" required />
            <button type="button" className="link left" onClick={() => { setMode('login'); setCode(''); }}>← Back</button>
          </>
        ) : mode === 'forgot' ? (
          <>
            <p className="muted">We'll email a reset link to the recovery address on your account. Business users can also ask their administrator.</p>
            <label>Your email address<input type="email" required value={form.email} onChange={set('email')} autoFocus /></label>
            <button type="button" className="link left" onClick={() => { setMode('login'); setInfo(''); }}>← Back to sign in</button>
          </>
        ) : mode === 'reset' ? (
          <>
            <label>New password<input type="password" minLength={10} required value={form.password} onChange={set('password')} autoComplete="new-password" autoFocus />
              <small>At least 10 characters, with letters and numbers.</small></label>
            <label>Confirm password<input type="password" required value={form.confirm} onChange={set('confirm')} autoComplete="new-password" /></label>
          </>
        ) : (
          <>
            <label>Your name<input required value={form.name} onChange={set('name')} autoFocus autoComplete="name" /></label>
            <label>Choose your address
              <div className="addr-input">
                <input required value={form.username} onChange={set('username')} pattern="[A-Za-z0-9._\-]+" autoComplete="off" />
                <span>@{cfg.domain}</span>
              </div>
              {avail === true && <small className="ok">✓ Available</small>}
              {avail === false && <small className="bad">✗ Not available</small>}
            </label>
            <label>Password<input type="password" minLength={10} required value={form.password} onChange={set('password')} autoComplete="new-password" />
              <small>At least 10 characters, with letters and numbers.</small></label>
            <label>Confirm password<input type="password" required value={form.confirm} onChange={set('confirm')} autoComplete="new-password" /></label>
            <label>Recovery email <small>(recommended, so you can reset a forgotten password)</small><input type="email" value={form.recoveryEmail} onChange={set('recoveryEmail')} placeholder="you@another-provider.com" /></label>
            {cfg.turnstileSiteKey && <div ref={captchaRef} />}
          </>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary wide" disabled={busy}>{busy ? 'Please wait…' : { login: 'Sign in', signup: 'Create account', '2fa': 'Verify', forgot: 'Send reset link', reset: 'Change password' }[mode]}</button>
        {mode === 'signup' && <p className="fine">Want email on your own domain? Create an account, then choose <b>Set up business email</b>.</p>}
      </form>
    </div>
  );
}
