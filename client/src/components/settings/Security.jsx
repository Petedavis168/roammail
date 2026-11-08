import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { fmtDate } from '../../util.js';
import TwoFactorSetup from '../TwoFactorSetup.jsx';
import { passkeysSupported, addPasskey } from '../../passkeys.js';

function Passkeys() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/passkeys').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const add = async () => {
    const pw = prompt('Enter your password to add a passkey for this device');
    if (!pw) return;
    setBusy(true);
    try { const r = await addPasskey(pw); toast(`Passkey added for ${r.name}`); load(); } catch (e) { toast(e.message, { error: true }); } finally { setBusy(false); }
  };
  const remove = async (k) => {
    if (!confirm(`Remove the passkey "${k.name}"? You can add it again later.`)) return;
    try { await api.del('/api/passkeys', { id: k.id }); load(); } catch (e) { toast(e.message, { error: true }); }
  };
  return (
    <>
      <h3>Passkeys</h3>
      <p className="muted small">Sign in with Face ID, your fingerprint or your device's screen lock instead of a password and code. Passkeys can't be phished or stolen in a data breach.</p>
      {list?.length > 0 && (
        <ul className="plain-list">
          {list.map((k) => (
            <li key={k.id}><Icon name="lock" size={14} /> <b>{k.name}</b> <span className="muted small">added {fmtDate(k.created)}{k.lastUsed ? `, last used ${fmtDate(k.lastUsed)}` : ''}</span>
              <button className="link" onClick={() => remove(k)}>Remove</button></li>
          ))}
        </ul>
      )}
      {passkeysSupported()
        ? <button className="btn" disabled={busy} onClick={add}>{busy ? 'Waiting for your device…' : 'Add a passkey for this device'}</button>
        : <p className="muted small">This browser doesn't support passkeys.</p>}
      <p className="muted small">Changing your password or signing out everywhere removes your passkeys; add them again afterwards.</p>
    </>
  );
}

function device(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua.split('/')[0] || 'Unknown';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ` on ${os}` : ''}`;
}

export default function Security({ me }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [recovery, setRecovery] = useState('');
  const [vcode, setVcode] = useState('');
  const [det, setDet] = useState({ phone: '', birthday: '' });
  const [devices, setDevices] = useState([]);
  const load = () => {
    api.get('/api/security/sessions').then(setDevices).catch(() => {});
    return api.get('/api/security').then((d) => { setS(d); setRecovery(d.recoveryEmail); setDet({ phone: d.phone || '', birthday: d.birthday || '' }); });
  };
  useEffect(() => { load(); }, []);
  if (!s) return <div className="spinner" />;

  const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, { error: true }); } };
  const score = [s.twoFactor, !!s.recoveryEmail && s.recoveryVerified].filter(Boolean).length;

  return (
    <div className="settings-section">
      <div className={`sec-score s${score}`}>
        <Icon name={score === 2 ? 'check' : 'shield'} size={22} />
        <div><b>{score === 2 ? 'Your account is well protected' : score === 1 ? 'Almost there' : 'Protect your account'}</b>
          <small>{score === 2 ? '2-step verification and a recovery email are set up.' : 'Turn on 2-step verification and add a recovery email.'}</small></div>
      </div>

      <h3>2-step verification</h3>
      <p className="muted small">After your password, you'll enter a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…). Someone who steals your password still can't get in.</p>
      {s.twoFactor ? (
        <div className="card">
          <p><span className="pill ok">On</span> {s.backupCodesLeft} backup codes left.</p>
          <div className="step-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn" onClick={async () => { const pw = prompt('Enter your password to make new backup codes'); if (!pw) return; const r = await run(() => api.post('/api/security/backup-codes', { password: pw })); if (r) setCodes(r.backupCodes); load(); }}>New backup codes</button>
            <button className="btn" onClick={async () => { const p = prompt('Enter your password to turn off 2-step verification'); if (p && await run(() => api.post('/api/security/2fa/disable', { password: p }), '2-step verification turned off')) load(); }}>Turn off</button>
          </div>
        </div>
      ) : <TwoFactorSetup email={me.email} onDone={load} />}
      {codes && (
        <div className="card backup">
          <b>Save your backup codes</b>
          <p className="muted small">Each code works once if you lose your phone. Store them somewhere safe. They won't be shown again.</p>
          <div className="codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
          <div className="step-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(codes.join('\n')); toast('Copied'); }}><Icon name="copy" size={14} /> Copy</button>
            <button className="btn" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`Backup codes for ${me.email}\n\n${codes.join('\n')}\n`])); a.download = 'backup-codes.txt'; a.click(); }}>Download</button>
            <button className="btn primary" onClick={() => setCodes(null)}>I've saved them</button>
          </div>
        </div>
      )}

      <h3>Recovery email</h3>
      <p className="muted small">If you forget your password, we'll send a reset link here.{!s.resetAvailable && ' (Password reset emails are not enabled on this server yet. Ask your administrator.)'}</p>
      <div className="pick-time">
        <input type="email" placeholder="you@another-provider.com" value={recovery} onChange={(e) => setRecovery(e.target.value)} />
        <button className="btn" onClick={() => { const pw = prompt('Enter your password to change your recovery email'); if (pw) run(() => api.put('/api/security/recovery-email', { email: recovery, password: pw })).then((r) => { if (r) toast(r.message); load(); }); }}>Save</button>
      </div>
      {s.recoveryEmail && !s.recoveryPending && <p className="small">{s.recoveryVerified ? <><Icon name="check" size={14} /> {s.recoveryEmail} is verified.</> : <>{s.recoveryEmail} is not verified yet, so it can't be used to recover your account. <button className="link" onClick={() => run(() => api.post('/api/security/recovery-email/resend'), 'Code sent').then(load)}>Send a code</button></>}</p>}
      {(s.recoveryPending || (s.recoveryEmail && !s.recoveryVerified)) && (
        <div className="pick-time">
          <span className="small">Enter the 6-digit code we sent to {s.recoveryPending || s.recoveryEmail}:</span>
          <input inputMode="numeric" maxLength={6} placeholder="123456" value={vcode} onChange={(e) => setVcode(e.target.value)} style={{ width: 110 }} />
          <button className="btn primary" onClick={() => run(() => api.post('/api/security/recovery-email/verify', { code: vcode }), 'Recovery email verified').then(() => { setVcode(''); load(); })}>Verify</button>
          <button className="link" onClick={() => run(() => api.post('/api/security/recovery-email/resend'), 'New code sent')}>Resend</button>
        </div>
      )}

      <h3>Mobile number and date of birth</h3>
      <p className="muted small">Used only to protect and recover your account. Never shown to anyone.</p>
      <div className="pick-time">
        <input type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 555 123 4567" value={det.phone} onChange={(e) => setDet({ ...det, phone: e.target.value })} />
        <input type="date" autoComplete="bday" value={det.birthday} onChange={(e) => setDet({ ...det, birthday: e.target.value })} />
        <button className="btn" onClick={() => { const pw = prompt('Enter your password to change these details'); if (pw) run(() => api.put('/api/security/details', { ...det, password: pw }), 'Details saved').then(load); }}>Save</button>
      </div>

      <Passkeys />

      <h3>Change password</h3>
      <form className="form narrow" onSubmit={async (e) => {
        e.preventDefault();
        if (pw.next !== pw.confirm) return toast('New passwords don\'t match', { error: true });
        if (await run(() => api.post('/api/security/password', { current: pw.current, next: pw.next }), 'Password changed. Other devices were signed out.')) setPw({ current: '', next: '', confirm: '' });
      }}>
        <input type="password" placeholder="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
        <input type="password" placeholder="New password (10+ characters, letters and numbers)" autoComplete="new-password" minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
        <input type="password" placeholder="Confirm new password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
        <button className="btn">Change password</button>
        <small className="muted">Update the password in your phone and desktop mail apps afterwards.</small>
      </form>

      <h3>Signed-in devices</h3>
      <div className="table">
        {devices.map((d) => (
          <div className="tr two" key={d.id}>
            <span><Icon name={/iPhone|Android|Mobile/.test(d.ua || '') ? 'phone' : 'mail'} size={14} /> {device(d.ua)} {d.current && <span className="badge">This device</span>}</span>
            <span className="muted small">{d.ip} · active {fmtDate(new Date(d.lastSeen).toISOString())}</span>
            <span className="actions">{!d.current && <button className="btn sm" onClick={() => run(() => api.del('/api/security/sessions', { id: d.id }), 'Signed out').then(load)}>Sign out</button>}</span>
          </div>
        ))}
      </div>
      <p className="muted small">You're signed out automatically after a few days without activity.</p>

      <h3>Recent sign-in activity</h3>
      <div className="table">
        {s.events.map((e, i) => (
          <div className="tr two" key={i}>
            <span>{e.ok ? <Icon name="check" size={14} style={{ color: 'var(--ok)' }} /> : <Icon name="alert" size={14} style={{ color: 'var(--danger)' }} />} {device(e.ua)}
              {!e.ok && <small className="bad"> failed ({e.reason === '2fa' ? 'wrong code' : e.reason === 'locked' ? 'locked' : 'wrong password'})</small>}</span>
            <span className="muted small">{e.ip} · {fmtDate(e.at.replace(' ', 'T') + 'Z', true)}</span><span />
          </div>
        ))}
      </div>
      <p className="muted small">Don't recognize something? Change your password and sign out everywhere.</p>
      <button className="btn" onClick={() => run(() => api.post('/api/security/signout-all'), 'Signed out of all other devices').then(load)}><Icon name="logout" size={16} /> Sign out of all other devices</button>
    </div>
  );
}
