import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';

function strength(pw) {
  let s = 0;
  if (pw.length >= 10) s++; if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; if (/\d/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}
const STRENGTH = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'];

function Card({ title, subtitle, children, onSubmit, footer }) {
  return (
    <form className="g-card" onSubmit={onSubmit} noValidate>
      <img className="g-mark" src="/assets/roammail-symbol.png" alt="Roammail" />
      <h1>{title}</h1>
      {subtitle && <p className="g-sub">{subtitle}</p>}
      <div className="g-body">{children}</div>
      {footer && <div className="g-foot">{footer}</div>}
    </form>
  );
}
function Field({ label, error, hint, ...props }) {
  return (
    <label className={`g-field ${error ? 'err' : ''}`}>
      <input placeholder=" " {...props} />
      <span>{label}</span>
      {error ? <small className="g-err"><Icon name="alert" size={14} /> {error}</small> : hint ? <small className="g-hint">{hint}</small> : null}
    </label>
  );
}

export default function Login({ onLogin, mode = 'signin' }) {
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('reset');
  const [cfg, setCfg] = useState({ enabled: false, domain: 'roammail.net' });
  // login.roammail.net/signup?type=free|domain&billing=monthly|yearly comes from the website's buttons
  const signupType = params.get('type') === 'domain' ? 'domain' : 'free';
  const billing = ['monthly', 'yearly'].includes(params.get('billing')) ? params.get('billing') : '';
  const [step, setStep] = useState(resetToken ? 'reset' : mode === 'signup' || params.get('signup') ? 'name' : 'email');
  const [f, setF] = useState({ email: '', password: '', code: '', first: '', last: '', purpose: signupType === 'domain' ? 'business' : 'personal', username: '', custom: false, pw: '', pw2: '', recovery: '', terms: false, phone: '', code: '', phoneToken: null, codeSent: false, remember: localStorage.getItem('remember') === '1' });
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState(null);
  const [sugg, setSugg] = useState([]);
  const [avail, setAvail] = useState(null);
  const [captcha, setCaptcha] = useState('');
  const captchaRef = useRef(); const timer = useRef();
  const set = (k) => (e) => { setError(''); setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })); };
  const go = (s) => { setError(''); setInfo(''); setStep(s); };
  useEffect(() => { api.signupConfig().then(setCfg).catch(() => {}); }, []);
  const fullEmail = f.email.includes('@') ? f.email.trim() : `${f.email.trim()}@${cfg.domain}`;

  // live availability for the custom address
  useEffect(() => {
    if (step !== 'address' || !f.custom || !f.username) { setAvail(null); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api.get('/api/signup/check', { username: f.username.toLowerCase() }).then(setAvail).catch(() => setAvail(null)), 350);
  }, [f.username, f.custom, step]);
  useEffect(() => {
    if (step !== 'review' || !cfg.turnstileSiteKey) return;
    const render = () => window.turnstile?.render(captchaRef.current, { sitekey: cfg.turnstileSiteKey, callback: setCaptcha, 'expired-callback': () => setCaptcha('') });
    if (window.turnstile) { render(); return; }
    const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.onload = render; document.head.appendChild(s);
  }, [step, cfg.turnstileSiteKey]);

  const run = async (fn) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };

  // ---------------- sign in
  if (step === 'email') return (
    <Shell>
      <Card title="Sign in" subtitle="to continue to Roammail" onSubmit={(e) => { e.preventDefault(); if (!f.email.trim()) return setError('Enter an email address'); go('password'); }}
        footer={<>{cfg.enabled && <button type="button" className="g-link" onClick={() => go('name')}>Create account</button>}<button className="g-btn">Next</button></>}>
        <Field label="Email" type="text" inputMode="email" autoComplete="username" autoFocus value={f.email} onChange={set('email')} error={error} hint={!f.email.includes('@') && f.email ? `Signing in as ${fullEmail}` : ''} />
        <button type="button" className="g-link left" onClick={() => go('forgot-address')}>Forgot email?</button>
        {info && <div className="g-info">{info}</div>}
      </Card>
    </Shell>
  );
  if (step === 'password') return (
    <Shell>
      <Card title="Welcome" onSubmit={(e) => { e.preventDefault(); run(async () => {
        localStorage.setItem('remember', f.remember ? '1' : '0');
        const r = await api.login(fullEmail, f.password, f.remember);
        if (r.twoFactor) { setTicket(r.ticket); go('code'); } else await onLogin(r);
      }); }} footer={<><button type="button" className="g-link" onClick={() => go('forgot')}>Forgot password?</button><button className="g-btn" disabled={busy}>{busy ? 'Signing in…' : 'Next'}</button></>}>
        <button type="button" className="g-chip" onClick={() => go('email')}><Icon name="mail" size={14} /> {fullEmail} <Icon name="down" size={12} /></button>
        <input type="email" name="username" autoComplete="username" value={fullEmail} readOnly hidden />
        <Field label="Enter your password" type={show ? 'text' : 'password'} autoComplete="current-password" autoFocus value={f.password} onChange={set('password')} error={error} />
        <label className="g-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password</label>
        <label className="g-check" title="Stay signed in on this device for 30 days, renewed each time you use it. Don't use on shared computers."><input type="checkbox" checked={f.remember} onChange={set('remember')} /> Keep me signed in</label>
      </Card>
    </Shell>
  );
  if (step === 'code') return (
    <Shell>
      <Card title="2-Step Verification" subtitle="Open your authenticator app and enter the 6-digit code. You can also use a backup code."
        onSubmit={(e) => { e.preventDefault(); run(async () => { onLogin(await api.post('/api/login/2fa', { ticket, code: f.code })); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('password')}>Back</button><button className="g-btn" disabled={busy}>Next</button></>}>
        <button type="button" className="g-chip" onClick={() => go('email')}><Icon name="shield" size={14} /> {fullEmail}</button>
        <Field label="Enter code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={f.code} onChange={set('code')} error={error} />
        <button type="button" className="g-link left" onClick={() => go('lost')}>Lost your phone and backup codes?</button>
      </Card>
    </Shell>
  );
  if (step === 'forgot') return (
    <Shell>
      <Card title="Account recovery" subtitle="We'll email a reset link to the recovery address on your account. Business users can also ask their administrator."
        onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/api/password/forgot', { email: fullEmail }); setInfo(r.message); go('email'); setInfo(r.message); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('email')}>Back</button><button className="g-btn" disabled={busy}>Send link</button></>}>
        <Field label="Your email" type="text" inputMode="email" autoFocus value={f.email} onChange={set('email')} error={error} />
      </Card>
    </Shell>
  );
  if (step === 'lost') return (
    <Shell>
      <Card title="Lost your phone?" subtitle="We can turn off 2-step verification after a 72-hour safety wait. We'll email you and your recovery address, with a link to cancel if it wasn't you."
        onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/api/recovery/2fa', { ticket }); setInfo(r.message); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('code')}>Back</button>{!info && <button className="g-btn" disabled={busy}>Start recovery</button>}</>}>
        <button type="button" className="g-chip" onClick={() => go('email')}><Icon name="shield" size={14} /> {fullEmail}</button>
        {error && <div className="g-err"><Icon name="alert" size={14} /> {error}</div>}
        {info && <div className="g-info">{info}</div>}
      </Card>
    </Shell>
  );
  if (step === 'forgot-address') return (
    <Shell>
      <Card title="Find your email" subtitle="Enter your recovery email. If it's linked to any accounts, we'll send it a list of them."
        onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/api/password/forgot-address', { recoveryEmail: f.recovery }); go('email'); setInfo(r.message); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('email')}>Back</button><button className="g-btn" disabled={busy}>Send</button></>}>
        <Field label="Recovery email" type="email" autoFocus value={f.recovery} onChange={set('recovery')} error={error} />
      </Card>
    </Shell>
  );
  if (step === 'reset') return (
    <Shell>
      <Card title="Choose your password" onSubmit={(e) => { e.preventDefault(); if (f.pw !== f.pw2) return setError('Those passwords didn\'t match'); run(async () => {
        const r = await api.post('/api/password/reset', { token: resetToken, password: f.pw });
        if (r.redirect) { onLogin(r); return; } // accepted an invite: straight into the new inbox
        history.replaceState(null, '', location.pathname); setF((x) => ({ ...x, email: r.email })); go('email'); setInfo('Password changed. Sign in with your new password.');
      }); }} footer={<button className="g-btn" disabled={busy}>Change password</button>}>
        <Field label="New password" type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus value={f.pw} onChange={set('pw')} />
        <Field label="Confirm" type={show ? 'text' : 'password'} autoComplete="new-password" value={f.pw2} onChange={set('pw2')} error={error} />
        <label className="g-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password</label>
      </Card>
    </Shell>
  );

  // ---------------- sign up
  const username = f.custom ? f.username.toLowerCase().trim() : f.username;
  if (step === 'name') return (
    <Shell>
      <Card title="Create a Roammail account" subtitle="Enter your name" onSubmit={(e) => { e.preventDefault(); if (!f.first.trim()) return setError('Enter your first name');
        run(async () => { const r = await api.get('/api/signup/suggest', { first: f.first, last: f.last }); setSugg(r.suggestions); setF((x) => ({ ...x, username: r.suggestions[0] || '', custom: !r.suggestions.length })); go('address'); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('email')}>Sign in instead</button><button className="g-btn" disabled={busy}>Next</button></>}>
        {!cfg.enabled && <div className="g-info warn">New sign-ups are closed right now.</div>}
        <Field label="First name" autoComplete="given-name" autoFocus value={f.first} onChange={set('first')} error={error} />
        <Field label="Last name (optional)" autoComplete="family-name" value={f.last} onChange={set('last')} />
        <div className="g-purpose">
          {[['personal', 'For myself', 'A free personal address'], ['business', 'For my business', 'Use your own domain for your team']].map(([v, l, d]) => (
            <label key={v} className={f.purpose === v ? 'on' : ''}><input type="radio" checked={f.purpose === v} onChange={() => setF({ ...f, purpose: v })} /><b>{l}</b><small>{d}</small></label>
          ))}
        </div>
      </Card>
    </Shell>
  );
  if (step === 'address') return (
    <Shell>
      <Card title="Choose your address" subtitle={f.purpose === 'business' ? `This is your sign-in. You'll set up your business domain next.` : 'Pick an address or create your own'}
        onSubmit={(e) => { e.preventDefault(); if (!username) return setError('Choose an address'); if (f.custom && avail && !avail.available) return setError(avail.reason || 'That address is taken'); run(async () => {
          const r = await api.get('/api/signup/check', { username }); if (!r.available) throw new Error(r.reason || 'That address is taken. Try another.'); go('password-new'); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('name')}>Back</button><button className="g-btn" disabled={busy}>Next</button></>}>
        <div className="g-options">
          {sugg.map((s) => (
            <label key={s} className={!f.custom && f.username === s ? 'on' : ''}><input type="radio" checked={!f.custom && f.username === s} onChange={() => setF({ ...f, custom: false, username: s })} /><span><b>{s}</b>@{cfg.domain}</span><Icon name="check" size={16} /></label>
          ))}
          <label className={f.custom ? 'on' : ''}><input type="radio" checked={f.custom} onChange={() => setF({ ...f, custom: true, username: '' })} /><span>Create your own address</span></label>
        </div>
        {f.custom && (
          <div className="g-addr">
            <Field label="Username" autoFocus autoCapitalize="off" spellCheck="false" value={f.username} onChange={set('username')}
              error={error || (avail && !avail.available ? (avail.reason || 'That address is taken. Try another.') : '')} hint={avail?.available ? `✓ ${username}@${cfg.domain} is available` : 'You can use letters, numbers and periods'} />
            <span className="g-domain">@{cfg.domain}</span>
          </div>
        )}
      </Card>
    </Shell>
  );
  if (step === 'password-new') {
    const st = strength(f.pw);
    return (
      <Shell>
        <Card title="Create a strong password" subtitle="Use 10 or more characters. A few random words work great."
          onSubmit={(e) => { e.preventDefault(); if (f.pw.length < 10) return setError('Use 10 characters or more'); if (f.pw !== f.pw2) return setError('Those passwords didn\'t match'); go('recovery'); }}
          footer={<><button type="button" className="g-link" onClick={() => go('address')}>Back</button><button className="g-btn">Next</button></>}>
          <button type="button" className="g-chip" onClick={() => go('address')}><Icon name="mail" size={14} /> {username}@{cfg.domain}</button>
          <Field label="Password" type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus value={f.pw} onChange={set('pw')} />
          {f.pw && <div className={`g-meter s${st}`}><div /><small>{STRENGTH[st]}</small></div>}
          <Field label="Confirm" type={show ? 'text' : 'password'} autoComplete="new-password" value={f.pw2} onChange={set('pw2')} error={error} />
          <label className="g-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password</label>
        </Card>
      </Shell>
    );
  }
  if (step === 'recovery') return (
    <Shell>
      <Card title="Add a recovery email" subtitle="If you ever forget your password, we'll send a reset link here."
        onSubmit={(e) => { e.preventDefault(); if (f.recovery && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.recovery)) return setError('Enter a valid email address'); go(cfg.phoneRequired && !f.phoneToken ? 'phone' : 'review'); }}
        footer={<><button type="button" className="g-link" onClick={() => { setF({ ...f, recovery: '' }); go(cfg.phoneRequired && !f.phoneToken ? 'phone' : 'review'); }}>Skip</button><button className="g-btn">Next</button></>}>
        <Field label="Recovery email" type="email" autoFocus value={f.recovery} onChange={set('recovery')} error={error} />
      </Card>
    </Shell>
  );
  // 5b: free sign-ups confirm a mobile number by text message (one free account per number)
  if (step === 'phone') return (
    <Shell>
      <Card title="Verify your phone" subtitle="We'll text you a code. This keeps spammers out; your number isn't shown to anyone or used for marketing."
        onSubmit={(e) => { e.preventDefault(); run(async () => {
          if (!f.codeSent) { await api.post('/api/signup/phone/start', { phone: f.phone }); setF((x) => ({ ...x, codeSent: true })); return; }
          const r = await api.post('/api/signup/phone/check', { phone: f.phone, code: f.code });
          setF((x) => ({ ...x, phoneToken: r.token })); go('review');
        }); }}
        footer={<>{f.codeSent && <button type="button" className="g-link" onClick={() => setF({ ...f, codeSent: false, code: '' })}>Change number</button>}<button className="g-btn" disabled={busy}>{f.codeSent ? 'Verify' : 'Send code'}</button></>}>
        {!f.codeSent
          ? <Field label="Mobile number" type="tel" inputMode="tel" autoComplete="tel" autoFocus value={f.phone} onChange={set('phone')} error={error} hint="Include your country code, e.g. +1 555 123 4567" />
          : <Field label="6-digit code" inputMode="numeric" autoComplete="one-time-code" autoFocus value={f.code} onChange={set('code')} error={error} hint={`Sent to ${f.phone}`} />}
      </Card>
    </Shell>
  );
  if (step === 'review') return (
    <Shell>
      <Card title="Privacy and Terms" subtitle={`Almost done, ${f.first}.`}
        onSubmit={(e) => { e.preventDefault(); if (!f.terms) return setError('Please agree to continue'); run(async () => {
          const r = await api.signup({ name: `${f.first} ${f.last}`.trim(), username, password: f.pw, recoveryEmail: f.recovery, captcha, acceptTerms: true, phoneToken: f.phoneToken });
          // Own-domain sign-ups go straight on to connecting the domain (and choosing monthly/yearly)
          if (f.purpose === 'business') localStorage.setItem('startBusiness', '1');
          onLogin({ ...r, redirect: f.purpose === 'business' ? `${r.redirect}?setup=domain${billing ? `&billing=${billing}` : ''}` : r.redirect });
        }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('recovery')}>Back</button><button className="g-btn" disabled={busy}>{busy ? 'Creating your account…' : 'Create account'}</button></>}>
        <div className="g-review">
          <div><Icon name="mail" size={16} /> <b>{username}@{cfg.domain}</b></div>
          <ul>
            <li>We don't sell your data or show ads.</li>
            <li>Pictures in emails are blocked until you allow them, so senders can't track you.</li>
            <li>Free accounts have fair-use sending limits to keep spammers out.</li>
          </ul>
        </div>
        {cfg.turnstileSiteKey && <div ref={captchaRef} />}
        <label className="g-check top"><input type="checkbox" checked={f.terms} onChange={set('terms')} />
          <span>I agree to the <a href="/legal/terms" target="_blank">Terms</a>, <a href="/legal/acceptable-use" target="_blank">Acceptable Use Policy</a> and <a href="/legal/privacy" target="_blank">Privacy Policy</a>.</span></label>
        {error && <small className="g-err"><Icon name="alert" size={14} /> {error}</small>}
      </Card>
    </Shell>
  );
  return null;
}

function Shell({ children }) {
  return (
    <div className="g-page">
      {children}
      <div className="g-legal"><span>Roammail · Your business. Delivered. · Powered by Friendly Web Services</span><span><a href="/legal/privacy">Privacy</a><a href="/legal/terms">Terms</a><a href="/legal/security">Security</a></span></div>
    </div>
  );
}
