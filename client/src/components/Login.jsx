import { useEffect, useRef, useState } from 'react';
import { isNative } from '../native.js';
import { passkeysSupported, signInWithPasskey } from '../passkeys.js';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { t } from '../i18n.js';

function strength(pw) {
  let s = 0;
  if (pw.length >= 10) s++; if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; if (/\d/.test(pw)) s++; if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}
const SSO_LOGIN_MSG = {
  'not-linked': 'That work account isn’t linked to a Roammail mailbox. Sign in with your password, then link it in Settings → Security.',
  'password-changed': 'Your password has changed since you linked your work account. Sign in with your password, then link it again.',
  blocked: 'Too many failed attempts. Try again later.', cancelled: 'Sign-in was cancelled.', expired: 'That took too long. Please try again.',
  unavailable: 'That sign-in option isn’t available.', failed: 'Something went wrong. Please try again.',
};
const STRENGTH = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'];

function Card({ title, subtitle, children, onSubmit, footer }) {
  return (
    <main className="g-main"><form className="g-card" onSubmit={onSubmit} noValidate>
      <img className="g-mark" src="/assets/roammail-symbol.png" alt={t("Roammail")} />
      <h1>{title}</h1>
      {subtitle && <p className="g-sub">{subtitle}</p>}
      <div className="g-body">{children}</div>
      {footer && <div className="g-foot">{footer}</div>}
    </form></main>
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
  // Refer a friend: ?ref=CODE on the sign-up link (kept for this visit)
  const [refCode] = useState(() => { const r = new URLSearchParams(location.search).get('ref'); if (r && /^[A-Za-z2-9]{8}$/.test(r)) sessionStorage.setItem('ref', r.toUpperCase()); return sessionStorage.getItem('ref') || ''; });
  const startedAt = useRef(Date.now()); // bot check: real people take more than a couple of seconds
  const [hp, setHp] = useState(''); // hidden field only bots fill in
  const [f, setF] = useState({ email: '', password: '', code: '', first: '', last: '', purpose: signupType === 'domain' ? 'business' : 'personal', username: '', custom: false, pw: '', pw2: '', recovery: '', terms: false, phone: '', code: '', phoneToken: null, birthday: '', bizDomain: '', bizLocal: '', bizName: '', codeSent: false, remember: localStorage.getItem('remember') ? localStorage.getItem('remember') === '1' : isNative() }); // the phone apps keep you signed in by default
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  // Sign in with Microsoft / Google (for companies that turned it on); ?sso= says why we came back
  const [sso, setSso] = useState({});
  const [ssoErr] = useState(() => new URLSearchParams(location.search).get('sso'));
  useEffect(() => { api.get('/api/sso/options').then(setSso).catch(() => {}); }, []);
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
    timer.current = setTimeout(() => api.get('/api/signup/check', { username: f.username.toLowerCase(), first: f.first, last: f.last }).then(setAvail).catch(() => setAvail(null)), 350);
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
      <Card title={t("Sign in")} subtitle={t("to continue to Roammail")} onSubmit={(e) => { e.preventDefault(); if (!f.email.trim()) return setError(t("Enter an email address")); go('password'); }}
        footer={<>{cfg.enabled && <button type="button" className="g-link" onClick={() => go('name')}>{t("Create account")}</button>}<button className="g-btn">{t("Next")}</button></>}>
        <Field label={t("Email")} type="text" inputMode="email" autoComplete="username" autoFocus value={f.email} onChange={set('email')} error={error} hint={!f.email.includes('@') && f.email ? `Signing in as ${fullEmail}` : ''} />
        <button type="button" className="g-link left" onClick={() => go('forgot-address')}>{t("Forgot email?")}</button>
        {passkeysSupported() && (
          <button type="button" className="g-passkey" disabled={busy} onClick={() => run(async () => { const r = await signInWithPasskey(f.remember); await onLogin(r); })}>
            <Icon name="lock" size={16} />{' '}{t("Sign in with a passkey")}{' '}</button>
        )}
        {!isNative() && sso.microsoft && <a className="g-passkey" href={`/api/sso/login/microsoft?remember=${f.remember ? 1 : 0}`}>{t("Sign in with Microsoft")}</a>}
        {!isNative() && sso.google && <a className="g-passkey" href={`/api/sso/login/google?remember=${f.remember ? 1 : 0}`}>{t("Sign in with Google")}</a>}
        {ssoErr && <div className="g-info warn">{t(SSO_LOGIN_MSG[ssoErr] || SSO_LOGIN_MSG.failed)}</div>}
        {info && <div className="g-info">{info}</div>}
      </Card>
    </Shell>
  );
  if (step === 'password') return (
    <Shell>
      <Card title={t("Welcome")} onSubmit={(e) => { e.preventDefault(); run(async () => {
        localStorage.setItem('remember', f.remember ? '1' : '0');
        const r = await api.login(fullEmail, f.password, f.remember);
        if (r.twoFactor) { setTicket(r.ticket); go('code'); } else await onLogin(r);
      }); }} footer={<><button type="button" className="g-link" onClick={() => go('forgot')}>{t("Forgot password?")}</button><button className="g-btn" disabled={busy}>{busy ? 'Signing in…' : 'Next'}</button></>}>
        <button type="button" className="g-chip" onClick={() => go('email')}><Icon name="mail" size={14} /> {fullEmail} <Icon name="down" size={12} /></button>
        <input type="email" name="username" autoComplete="username" value={fullEmail} readOnly hidden />
        <Field label={t("Enter your password")} type={show ? 'text' : 'password'} autoComplete="current-password" autoFocus value={f.password} onChange={set('password')} error={error} />
        <label className="g-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />{' '}{t("Show password")}</label>
        <label className="g-check" title={t("Stay signed in on this device for 30 days, renewed each time you use it. Don't use on shared computers.")}><input type="checkbox" checked={f.remember} onChange={set('remember')} />{' '}{t("Keep me signed in")}</label>
      </Card>
    </Shell>
  );
  if (step === 'code') return (
    <Shell>
      <Card title={t("2-Step Verification")} subtitle={t("Open your authenticator app and enter the 6-digit code. You can also use a backup code.")}
        onSubmit={(e) => { e.preventDefault(); run(async () => { onLogin(await api.post('/api/login/2fa', { ticket, code: f.code })); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('password')}>{t("Back")}</button><button className="g-btn" disabled={busy}>{t("Next")}</button></>}>
        <button type="button" className="g-chip" onClick={() => go('email')}><Icon name="shield" size={14} /> {fullEmail}</button>
        <Field label={t("Enter code")} inputMode="numeric" autoComplete="one-time-code" autoFocus value={f.code} onChange={set('code')} error={error} />
        <button type="button" className="g-link left" onClick={() => go('lost')}>{t("Lost your phone and backup codes?")}</button>
      </Card>
    </Shell>
  );
  if (step === 'forgot') return (
    <Shell>
      <Card title={t("Account recovery")} subtitle={t("We'll email a reset link to the recovery address on your account. Business users can also ask their administrator.")}
        onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/api/password/forgot', { email: fullEmail }); setInfo(r.message); go('email'); setInfo(r.message); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('email')}>{t("Back")}</button><button className="g-btn" disabled={busy}>{t("Send link")}</button></>}>
        <Field label={t("Your email")} type="text" inputMode="email" autoFocus value={f.email} onChange={set('email')} error={error} />
      </Card>
    </Shell>
  );
  if (step === 'lost') return (
    <Shell>
      <Card title={t("Lost your phone?")} subtitle={t("We can turn off 2-step verification after a 72-hour safety wait. We'll email you and your recovery address, with a link to cancel if it wasn't you.")}
        onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/api/recovery/2fa', { ticket }); setInfo(r.message); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('code')}>{t("Back")}</button>{!info && <button className="g-btn" disabled={busy}>{t("Start recovery")}</button>}</>}>
        <button type="button" className="g-chip" onClick={() => go('email')}><Icon name="shield" size={14} /> {fullEmail}</button>
        {error && <div className="g-err"><Icon name="alert" size={14} /> {error}</div>}
        {info && <div className="g-info">{info}</div>}
      </Card>
    </Shell>
  );
  if (step === 'forgot-address') return (
    <Shell>
      <Card title={t("Find your email")} subtitle={t("Enter your recovery email. If it's linked to any accounts, we'll send it a list of them.")}
        onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api.post('/api/password/forgot-address', { recoveryEmail: f.recovery }); go('email'); setInfo(r.message); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('email')}>{t("Back")}</button><button className="g-btn" disabled={busy}>{t("Send")}</button></>}>
        <Field label={t("Recovery email")} type="email" autoFocus value={f.recovery} onChange={set('recovery')} error={error} />
      </Card>
    </Shell>
  );
  if (step === 'reset') return (
    <Shell>
      <Card title={t("Choose your password")} onSubmit={(e) => { e.preventDefault(); if (f.pw !== f.pw2) return setError(t("Those passwords didn't match")); run(async () => {
        const r = await api.post('/api/password/reset', { token: resetToken, password: f.pw });
        if (r.redirect) { onLogin(r); return; } // accepted an invite: straight into the new inbox
        history.replaceState(null, '', location.pathname); setF((x) => ({ ...x, email: r.email })); go('email'); setInfo(t("Password changed. Sign in with your new password."));
      }); }} footer={<button className="g-btn" disabled={busy}>{t("Change password")}</button>}>
        <Field label={t("New password")} type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus value={f.pw} onChange={set('pw')} />
        <Field label={t("Confirm")} type={show ? 'text' : 'password'} autoComplete="new-password" value={f.pw2} onChange={set('pw2')} error={error} />
        <label className="g-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />{' '}{t("Show password")}</label>
      </Card>
    </Shell>
  );

  // ---------------- sign up
  const username = f.custom ? f.username.toLowerCase().trim() : f.username;
  if (step === 'name') return (
    <Shell>
      <Card title={t("Create a Roammail account")} subtitle={t("Enter your name")} onSubmit={(e) => { e.preventDefault(); if (!f.first.trim()) return setError(t("Enter your first name"));
        run(async () => { const r = await api.get('/api/signup/suggest', { first: f.first, last: f.last }); setSugg(r.suggestions); setF((x) => ({ ...x, username: r.suggestions[0] || '', custom: !r.suggestions.length, bizLocal: x.bizLocal || (x.first || '').toLowerCase().replace(/[^a-z0-9]/g, '') }));
          // Business: their own domain first; the @roammail.net sign-in is picked for them
          go(f.purpose === 'business' && r.suggestions.length ? 'bizdomain' : 'address'); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('email')}>{t("Sign in instead")}</button><button className="g-btn" disabled={busy}>{t("Next")}</button></>}>
        {!cfg.enabled && <div className="g-info warn">{t("New sign-ups are closed right now.")}</div>}
        <Field label={t("First name")} autoComplete="given-name" autoFocus value={f.first} onChange={set('first')} error={error} />
        <Field label={t("Last name (optional)")} autoComplete="family-name" value={f.last} onChange={set('last')} />
        <div className="g-purpose">
          {[['personal', 'For myself', 'A free personal address'], ['business', 'For my business', 'Use your own domain for your team']].map(([v, l, d]) => (
            <label key={v} className={f.purpose === v ? 'on' : ''}><input type="radio" checked={f.purpose === v} onChange={() => setF({ ...f, purpose: v })} /><b>{l}</b><small>{d}</small></label>
          ))}
        </div>
      </Card>
    </Shell>
  );
  // Business sign-up: their own domain and the address they want on it
  if (step === 'bizdomain') return (
    <Shell>
      <Card title={t("Your business email")} subtitle={t("Enter the domain you own. We'll connect it in the next steps.")}
        onSubmit={(e) => { e.preventDefault(); run(async () => {
          if (!f.bizLocal.trim()) throw new Error('Choose your address at your domain');
          const r = await api.get('/api/signup/domain-check', { domain: f.bizDomain });
          if (!r.ok) throw new Error(r.reason);
          setF((x) => ({ ...x, bizDomain: r.domain })); go('password-new');
        }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('name')}>{t("Back")}</button><button className="g-btn" disabled={busy}>{t("Next")}</button></>}>
        <Field label={t("Business name")} autoComplete="organization" autoFocus value={f.bizName} onChange={set('bizName')} />
        <Field label={t("Your domain")} inputMode="url" autoCapitalize="off" spellCheck="false" value={f.bizDomain} onChange={set('bizDomain')} error={error} hint={t("Like marleymusic.com (without www)")} />
        <div className="g-addr">
          <Field label={t("Your address")} autoCapitalize="off" spellCheck="false" value={f.bizLocal} onChange={set('bizLocal')} />
          <span className="g-domain">@{(f.bizDomain || 'yourdomain.com').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')}</span>
        </div>
        <p className="g-note">{t("Until your domain is connected you'll sign in as")}{' '}<b>{username}@{cfg.domain}</b>{t(". As soon as it's live we create")}{' '}<b>{f.bizLocal || 'you'}@{f.bizDomain || 'yourdomain.com'}</b>{' '}{t("with the same password.")}</p>
        <button type="button" className="g-link left" onClick={() => setF({ ...f, purpose: 'personal' }) || go('address')}>{t("I don't have a domain yet")}</button>
      </Card>
    </Shell>
  );
  if (step === 'address') return (
    <Shell>
      <Card title={t("Choose your address")} subtitle={f.purpose === 'business' ? `This is your sign-in. You'll set up your business domain next.` : 'Pick an address or create your own'}
        onSubmit={(e) => { e.preventDefault(); if (!username) return setError(t("Choose an address")); if (f.custom && avail && !avail.available) return setError(avail.reason || 'That address is taken'); run(async () => {
          const r = await api.get('/api/signup/check', { username }); if (!r.available) throw new Error(r.reason || 'That address is taken. Try another.'); go('password-new'); }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('name')}>{t("Back")}</button><button className="g-btn" disabled={busy}>{t("Next")}</button></>}>
        <div className="g-options">
          {sugg.map((s) => (
            <label key={s} className={!f.custom && f.username === s ? 'on' : ''}><input type="radio" checked={!f.custom && f.username === s} onChange={() => setF({ ...f, custom: false, username: s })} /><span><b>{s}</b>@{cfg.domain}</span><Icon name="check" size={16} /></label>
          ))}
          <label className={f.custom ? 'on' : ''}><input type="radio" checked={f.custom} onChange={() => setF({ ...f, custom: true, username: '' })} /><span>{t("Create your own address")}</span></label>
        </div>
        {f.custom && (
          <div className="g-addr">
            <Field label={t("Username")} autoFocus autoCapitalize="off" spellCheck="false" value={f.username} onChange={set('username')}
              error={error || (avail && !avail.available ? (avail.reason || 'That address is taken. Try another.') : '')} hint={avail?.available ? `✓ ${username}@${cfg.domain} is available` : 'You can use letters, numbers and periods'} />
            <span className="g-domain">@{cfg.domain}</span>
          </div>
        )}
        {f.custom && avail && !avail.available && avail.alternatives?.length > 0 && (
          <div className="g-alts" aria-live="polite">
            <small>{t("Try one of these instead:")}</small>
            {avail.alternatives.map((a) => <button type="button" key={a} className="g-chip" onClick={() => setF((x) => ({ ...x, username: a }))}>{a}@{cfg.domain}</button>)}
          </div>
        )}
        <button type="button" className="g-link left" disabled={busy} onClick={() => run(async () => {
          const r = await api.get('/api/signup/suggest', { first: f.first, last: f.last, shuffle: 1, count: 3 });
          if (!r.suggestions.length) throw new Error("Couldn't think of one. Try typing your own.");
          setSugg(r.suggestions); setF((x) => ({ ...x, custom: false, username: r.suggestions[0] }));
        })}>{t("Generate one for me")}</button>
      </Card>
    </Shell>
  );
  if (step === 'password-new') {
    const st = strength(f.pw);
    return (
      <Shell>
        <Card title={t("Create a strong password")} subtitle={t("Use 10 or more characters. A few random words work great.")}
          onSubmit={(e) => { e.preventDefault(); if (f.pw.length < 10) return setError(t("Use 10 characters or more")); if (f.pw !== f.pw2) return setError(t("Those passwords didn't match")); go('recovery'); }}
          footer={<><button type="button" className="g-link" onClick={() => go(f.purpose === 'business' && f.bizDomain ? 'bizdomain' : 'address')}>{t("Back")}</button><button className="g-btn">{t("Next")}</button></>}>
          <button type="button" className="g-chip" onClick={() => go(f.purpose === 'business' && f.bizDomain ? 'bizdomain' : 'address')}><Icon name="mail" size={14} /> {f.purpose === 'business' && f.bizDomain ? `${f.bizLocal}@${f.bizDomain}` : `${username}@${cfg.domain}`}</button>
          <Field label={t("Password")} type={show ? 'text' : 'password'} autoComplete="new-password" autoFocus value={f.pw} onChange={set('pw')} />
          {f.pw && <div className={`g-meter s${st}`}><div /><small>{STRENGTH[st]}</small></div>}
          <Field label={t("Confirm")} type={show ? 'text' : 'password'} autoComplete="new-password" value={f.pw2} onChange={set('pw2')} error={error} />
          <label className="g-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />{' '}{t("Show password")}</label>
        </Card>
      </Shell>
    );
  }
  // Account details (both sign-ups): date of birth, recovery email, mobile number
  if (step === 'recovery') return (
    <Shell>
      <Card title={t("Your details")} subtitle={t("These keep your account safe and let you get back in if you ever forget your password.")}
        onSubmit={(e) => { e.preventDefault(); setError('');
          const b = f.birthday ? new Date(`${f.birthday}T00:00:00`) : null; const now = new Date();
          const age = b ? now.getFullYear() - b.getFullYear() - (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0) : -1;
          if (!b || Number.isNaN(b.getTime()) || age > 120 || age < 0) return setError(t("Enter your date of birth"));
          if (age < (cfg.minAge || 13)) return setError(`You need to be at least ${cfg.minAge || 13} to create an account`);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.recovery)) return setError(t("Enter a recovery email address (a different account you can get into)"));
          if (f.recovery.trim().toLowerCase() === `${username}@${cfg.domain}`) return setError(t("Use a different address than your new one"));
          const ph = f.phone.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
          if (!/^\+[1-9]\d{7,14}$/.test(ph)) return setError(t("Enter your mobile number with the country code, like +1 555 123 4567"));
          setF((x) => ({ ...x, phone: ph }));
          go(cfg.phoneRequired && !f.phoneToken ? 'phone' : 'review'); }}
        footer={<><button type="button" className="g-link" onClick={() => go('password-new')}>{t("Back")}</button><button className="g-btn">{t("Next")}</button></>}>
        <Field label={t("Date of birth")} type="date" autoComplete="bday" autoFocus value={f.birthday} onChange={set('birthday')} max={new Date().toISOString().slice(0, 10)} />
        <Field label={t("Recovery email")} type="email" autoComplete="email" value={f.recovery} onChange={set('recovery')} hint={t("Another email you use. We'll send a code to confirm it.")} />
        <Field label={t("Mobile number")} type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} hint={t("With country code, like +1 555 123 4567")} error={error} />
        <p className="g-note">{t("We only use these to protect and recover your account. They're never shown to anyone or used for marketing.")}</p>
      </Card>
    </Shell>
  );
  // 5b: free sign-ups confirm a mobile number by text message (one free account per number)
  if (step === 'phone') return (
    <Shell>
      <Card title={t("Verify your phone")} subtitle={t("We'll text you a code. This keeps spammers out; your number isn't shown to anyone or used for marketing.")}
        onSubmit={(e) => { e.preventDefault(); run(async () => {
          if (!f.codeSent) { await api.post('/api/signup/phone/start', { phone: f.phone }); setF((x) => ({ ...x, codeSent: true })); return; }
          const r = await api.post('/api/signup/phone/check', { phone: f.phone, code: f.code });
          setF((x) => ({ ...x, phoneToken: r.token })); go('review');
        }); }}
        footer={<>{f.codeSent && <button type="button" className="g-link" onClick={() => setF({ ...f, codeSent: false, code: '' })}>{t("Change number")}</button>}<button className="g-btn" disabled={busy}>{f.codeSent ? 'Verify' : 'Send code'}</button></>}>
        {!f.codeSent
          ? <Field label={t("Mobile number")} type="tel" inputMode="tel" autoComplete="tel" autoFocus value={f.phone} onChange={set('phone')} error={error} hint={t("Include your country code, e.g. +1 555 123 4567")} />
          : <Field label={t("6-digit code")} inputMode="numeric" autoComplete="one-time-code" autoFocus value={f.code} onChange={set('code')} error={error} hint={`Sent to ${f.phone}`} />}
      </Card>
    </Shell>
  );
  if (step === 'review') return (
    <Shell>
      <Card title={t("Privacy and Terms")} subtitle={`Almost done, ${f.first}.`}
        onSubmit={(e) => { e.preventDefault(); if (!f.terms) return setError(t("Please agree to continue")); run(async () => {
          const r = await api.signup({ name: `${f.first} ${f.last}`.trim(), username, password: f.pw, recoveryEmail: f.recovery, captcha, acceptTerms: true, phoneToken: f.phoneToken, birthday: f.birthday, phone: f.phone, remember: isNative(), website: hp, formMs: Date.now() - startedAt.current, ...(refCode ? { ref: refCode } : {}),
            ...(f.purpose === 'business' && f.bizDomain ? { business: { domain: f.bizDomain, local: f.bizLocal, orgName: f.bizName } } : {}) });
          // Own-domain sign-ups go straight on to connecting the domain (and choosing monthly/yearly)
          if (f.purpose === 'business') localStorage.setItem('startBusiness', '1');
          onLogin({ ...r, redirect: f.purpose === 'business' ? `${r.redirect}?setup=domain${billing ? `&billing=${billing}` : ''}` : r.redirect });
        }); }}
        footer={<><button type="button" className="g-link" onClick={() => go('recovery')}>{t("Back")}</button><button className="g-btn" disabled={busy}>{busy ? 'Creating your account…' : 'Create account'}</button></>}>
        <input className="hp-field" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={hp} onChange={(e) => setHp(e.target.value)} />
        <div className="g-review">
          <div><Icon name="mail" size={16} /> <b>{username}@{cfg.domain}</b></div>
          <ul>
            <li>{t("We don't sell your data or show ads.")}</li>
            <li>{t("Pictures in emails are blocked until you allow them, so senders can't track you.")}</li>
            <li>{t("Free accounts have fair-use sending limits to keep spammers out.")}</li>
          </ul>
        </div>
        {cfg.turnstileSiteKey && <div ref={captchaRef} />}
        <label className="g-check top"><input type="checkbox" checked={f.terms} onChange={set('terms')} />
          <span>{t("I agree to the")}{' '}<a href="/legal/terms" target="_blank">{t("Terms")}</a>, <a href="/legal/acceptable-use" target="_blank">{t("Acceptable Use Policy")}</a> and <a href="/legal/privacy" target="_blank">{t("Privacy Policy")}</a>.</span></label>
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
      <footer className="g-legal"><span>{t("Roammail · Your business. Delivered. · Powered by Friendly Web Services")}</span><span><a href="/legal/privacy">{t("Privacy")}</a><a href="/legal/terms">{t("Terms")}</a><a href="/legal/security">{t("Security")}</a></span></footer>
    </div>
  );
}
