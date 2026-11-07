import { useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { useToast } from './Toast.jsx';

/** QR → code → backup codes. Calls onDone() once 2-step verification is on and codes are saved. */
export default function TwoFactorSetup({ email, onDone, startLabel = 'Turn on 2-step verification' }) {
  const toast = useToast();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const run = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, { error: true }); return null; } };

  if (codes) {
    return (
      <div className="card backup">
        <b>Save your backup codes</b>
        <p className="muted small">Each code works once if you lose your phone. Store them somewhere safe. They won't be shown again.</p>
        <div className="codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
        <div className="step-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn" onClick={() => { navigator.clipboard?.writeText(codes.join('\n')); toast('Copied'); }}><Icon name="copy" size={14} /> Copy</button>
          <button className="btn" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`Backup codes for ${email}\n\n${codes.join('\n')}\n`])); a.download = 'backup-codes.txt'; a.click(); }}>Download</button>
          <button className="btn primary" onClick={() => { setCodes(null); onDone?.(); }}>I've saved them</button>
        </div>
      </div>
    );
  }
  if (!setup) return <button className="btn primary" onClick={async () => setSetup(await run(() => api.post('/api/security/2fa/setup')))}><Icon name="lock" size={16} /> {startLabel}</button>;
  return (
    <div className="card twofa">
      <img src={setup.qr} alt="QR code" width="180" height="180" />
      <div>
        <ol><li>Install an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and scan this code.</li>
          <li>Can't scan? Enter this key: <code className="mono">{setup.secret.match(/.{1,4}/g).join(' ')}</code></li><li>Type the 6-digit code it shows:</li></ol>
        <form className="pick-time" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post('/api/security/2fa/enable', { code })); if (r) { toast('2-step verification is on'); setCodes(r.backupCodes); setSetup(null); setCode(''); } }}>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" className="code-input" autoFocus />
          <button className="btn primary">Verify &amp; turn on</button>
        </form>
      </div>
    </div>
  );
}

/** Full-screen gate shown when a policy requires 2-step verification. */
export function TwoFactorGate({ me, reason, onDone, onLogout }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-icon"><Icon name="shield" size={34} /></div>
        <h1>Secure your account</h1>
        <p>{reason}</p>
        <p className="muted small">It takes about a minute. After your password you'll also enter a code from your phone, so a stolen password alone can't get in.</p>
        <TwoFactorSetup email={me.email} onDone={onDone} startLabel="Set it up now" />
        {onLogout && <button className="link" onClick={onLogout}>Sign out</button>}
      </div>
    </div>
  );
}
