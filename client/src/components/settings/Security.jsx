import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { fmtDate } from '../../util.js';

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
  const load = () => api.get('/api/security').then((d) => { setS(d); setRecovery(d.recoveryEmail); });
  useEffect(() => { load(); }, []);
  if (!s) return <div className="spinner" />;

  const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, { error: true }); } };
  const score = [s.twoFactor, !!s.recoveryEmail].filter(Boolean).length;

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
            <button className="btn" onClick={async () => { const r = await run(() => api.post('/api/security/backup-codes')); if (r) setCodes(r.backupCodes); load(); }}>New backup codes</button>
            <button className="btn" onClick={async () => { const p = prompt('Enter your password to turn off 2-step verification'); if (p && await run(() => api.post('/api/security/2fa/disable', { password: p }), '2-step verification turned off')) load(); }}>Turn off</button>
          </div>
        </div>
      ) : !setup ? (
        <button className="btn primary" onClick={async () => setSetup(await run(() => api.post('/api/security/2fa/setup')))}><Icon name="lock" size={16} /> Turn on 2-step verification</button>
      ) : (
        <div className="card twofa">
          <img src={setup.qr} alt="QR code" width="180" height="180" />
          <div>
            <ol><li>Open your authenticator app and scan this code.</li><li>Can't scan? Enter this key: <code className="mono">{setup.secret.match(/.{1,4}/g).join(' ')}</code></li><li>Type the 6-digit code it shows:</li></ol>
            <div className="pick-time">
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" className="code-input" />
              <button className="btn primary" onClick={async () => { const r = await run(() => api.post('/api/security/2fa/enable', { code }), '2-step verification is on'); if (r) { setCodes(r.backupCodes); setSetup(null); setCode(''); load(); } }}>Verify &amp; turn on</button>
            </div>
          </div>
        </div>
      )}
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
        <button className="btn" onClick={() => run(() => api.put('/api/security/recovery-email', { email: recovery }), 'Recovery email saved').then(load)}>Save</button>
      </div>

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
      <button className="btn" onClick={() => run(() => api.post('/api/security/signout-all'), 'Signed out of all other devices')}><Icon name="logout" size={16} /> Sign out of all other devices</button>
    </div>
  );
}
