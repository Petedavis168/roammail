import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { useToast } from './Toast.jsx';
import { t } from '../i18n.js';

/** QR → code → backup codes. Calls onDone() once 2-step verification is on and codes are saved. */
export default function TwoFactorSetup({ email, onDone, startLabel = 'Turn on 2-step verification', autoStart = false }) {
  const toast = useToast();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (autoStart && !setup) run(() => api.post('/api/security/2fa/setup')).then((r) => r && setSetup(r)); }, []);
  const run = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, { error: true }); return null; } };

  if (codes) {
    return (
      <div className="card backup">
        <b>{t("Save your backup codes")}</b>
        <p className="muted small">{t("Each code works once if you lose your phone. Store them somewhere safe. They won't be shown again.")}</p>
        <div className="codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
        <div className="step-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn" onClick={() => { navigator.clipboard?.writeText(codes.join('\n')); toast(t("Copied")); }}><Icon name="copy" size={14} />{' '}{t("Copy")}</button>
          <button className="btn" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`Backup codes for ${email}\n\n${codes.join('\n')}\n`])); a.download = 'backup-codes.txt'; a.click(); }}>{t("Download")}</button>
        </div>
        <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />{' '}{t("I saved my backup codes somewhere safe")}</label>
        <div className="step-actions">
          <button className="btn primary" disabled={!saved} onClick={() => { setCodes(null); onDone?.(); }}>{t("Continue")}</button>
        </div>
      </div>
    );
  }
  if (!setup) return <button className="btn primary" onClick={async () => setSetup(await run(() => api.post('/api/security/2fa/setup')))}><Icon name="lock" size={16} /> {startLabel}</button>;
  return (
    <div className="card twofa">
      <img src={setup.qr} alt={t("QR code")} width="180" height="180" />
      <div>
        <ol><li>{t("Install an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and scan this code.")}</li>
          <li>{t("Can't scan? Enter this key:")}{' '}<code className="mono">{setup.secret.match(/.{1,4}/g).join(' ')}</code></li><li>{t("Type the 6-digit code it shows:")}</li></ol>
        <form className="pick-time" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post('/api/security/2fa/enable', { code })); if (r) { toast(t("2-step verification is on")); setCodes(r.backupCodes); setSetup(null); setCode(''); } }}>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" className="code-input" autoFocus />
          <button className="btn primary">{t("Verify & turn on")}</button>
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
        <h1>{t("Secure your account")}</h1>
        <p>{reason}</p>
        <p className="muted small">{t("It takes about a minute. After your password you'll also enter a code from your phone, so a stolen password alone can't get in.")}</p>
        <TwoFactorSetup email={me.email} onDone={onDone} startLabel="Set it up now" />
        {onLogout && <button className="link" onClick={onLogout}>{t("Sign out")}</button>}
      </div>
    </div>
  );
}
