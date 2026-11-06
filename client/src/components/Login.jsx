import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';

export default function Login({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [cfg, setCfg] = useState({ enabled: false, domain: '' });
  const [form, setForm] = useState({ email: '', password: '', name: '', username: '', confirm: '' });
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
    if (mode === 'signup' && form.password !== form.confirm) return setError('Passwords don\'t match');
    setBusy(true);
    try {
      if (mode === 'login') await api.login(form.email, form.password);
      else await api.signup({ name: form.name, username: form.username.toLowerCase(), password: form.password, captcha });
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
        {cfg.enabled && (
          <div className="seg">
            <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Sign in</button>
            <button type="button" className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>Create account</button>
          </div>
        )}
        <h2>{mode === 'login' ? 'Sign in' : 'Create your free account'}</h2>
        {mode === 'login' ? (
          <>
            <label>Email address<input type="email" autoComplete="username" required value={form.email} onChange={set('email')} autoFocus /></label>
            <label>Password<input type="password" autoComplete="current-password" required value={form.password} onChange={set('password')} /></label>
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
            {cfg.turnstileSiteKey && <div ref={captchaRef} />}
          </>
        )}
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary wide" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        {mode === 'signup' && <p className="fine">Want email on your own domain? Create an account, then choose <b>Set up business email</b>.</p>}
      </form>
    </div>
  );
}
