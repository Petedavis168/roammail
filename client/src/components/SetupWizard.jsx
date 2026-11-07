import { useState } from 'react';
import { api } from '../api.js';
import TwoFactorSetup from './TwoFactorSetup.jsx';

const strength = (pw) => [pw.length >= 10, pw.length >= 14, /[a-z]/.test(pw) && /[A-Z]/.test(pw), /\d/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length;
const LABELS = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong', 'Strong'];

/** First sign-in: choose a password, turn on 2-step verification, confirm a recovery email, then optional extras. */
export default function SetupWizard({ me, onDone, onLogout }) {
  const st = me.setup;
  const steps = [...(st.setupRequired.includes('password') ? ['password'] : []), ...(st.setupRequired.includes('2fa') ? ['2fa'] : []),
    ...(!st.recoveryVerified ? ['recovery'] : []), 'extras'];
  const [i, setI] = useState(0);
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [rec, setRec] = useState(st.recoveryEmail || '');
  const [recPw, setRecPw] = useState('');
  const [code, setCode] = useState(''); const [sent, setSent] = useState(false);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const step = steps[i];
  const next = async () => { setErr(''); await api.post('/api/setup/step', { step }).catch(() => {}); if (i + 1 < steps.length) setI(i + 1); else { await api.post('/api/setup/step', { step: 'done' }).catch(() => {}); onDone(); } };
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };

  return (
    <div className="gate">
      <div className="gate-card wizard">
        <img src="/assets/roammail-symbol.png" alt="" width="40" />
        <div className="wiz-steps" aria-label={`Step ${i + 1} of ${steps.length}`}>{steps.map((s, n) => <span key={s} className={n <= i ? 'on' : ''} />)}</div>

        {step === 'password' && (
          <form onSubmit={(e) => { e.preventDefault(); if (pw !== pw2) return setErr("Those passwords don't match"); run(async () => { await api.post('/api/setup/password', { password: pw }); setNewPassword(pw); setRecPw(pw); await next(); }); }}>
            <h1>Welcome to RoamMail</h1>
            <p>You signed in with a temporary password. Choose your own to continue.</p>
            <label className="g-field"><input type="password" autoComplete="new-password" placeholder=" " value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /><span>New password</span></label>
            <div className={`meter s${strength(pw)}`}><div style={{ width: `${(strength(pw) / 5) * 100}%` }} /></div>
            <small className="muted">{pw ? LABELS[strength(pw)] : 'At least 10 characters with letters and numbers.'}</small>
            <label className="g-field"><input type="password" autoComplete="new-password" placeholder=" " value={pw2} onChange={(e) => setPw2(e.target.value)} /><span>Confirm password</span></label>
            {err && <div className="form-error">{err}</div>}
            <div className="step-actions"><button type="button" className="link" onClick={onLogout}>Sign out</button><button className="btn primary" disabled={busy || pw.length < 10}>{busy ? 'Saving…' : 'Save password'}</button></div>
          </form>
        )}

        {step === '2fa' && (
          <div>
            <h1>Turn on 2-step verification</h1>
            <p>After your password you'll also enter a code from your phone, so a stolen password alone can't get in.{st.twoFactorRequired ? ' Your account requires it.' : ''}</p>
            <TwoFactorSetup email={me.email} autoStart onDone={next} />
            {err && <div className="form-error">{err}</div>}
            {!st.twoFactorRequired && st.snoozesLeft > 0 && (
              <button className="link" onClick={() => run(async () => { await api.post('/api/setup/2fa/remind'); await next(); })}>Remind me tomorrow ({st.snoozesLeft} left)</button>
            )}
          </div>
        )}

        {step === 'recovery' && (
          <div>
            <h1>Add a recovery email</h1>
            <p>If you forget your password or lose your phone, we'll help you get back in through this address.</p>
            {!sent ? (
              <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api.put('/api/security/recovery-email', { email: rec, password: recPw || newPassword }); setSent(true); }); }}>
                <label className="g-field"><input type="email" autoComplete="email" placeholder=" " value={rec} onChange={(e) => setRec(e.target.value)} autoFocus /><span>Recovery email</span></label>
                {!newPassword && <label className="g-field"><input type="password" autoComplete="current-password" placeholder=" " value={recPw} onChange={(e) => setRecPw(e.target.value)} /><span>Your password (to confirm)</span></label>}
                {err && <div className="form-error">{err}</div>}
                <div className="step-actions"><button type="button" className="link" onClick={next}>Skip for now</button><button className="btn primary" disabled={busy || !rec}>Send code</button></div>
              </form>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/api/security/recovery-email/verify', { code }); await next(); }); }}>
                <p>We sent a 6-digit code to <b>{rec}</b>.</p>
                <label className="g-field"><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder=" " value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /><span>Code</span></label>
                {err && <div className="form-error">{err}</div>}
                <div className="step-actions"><button type="button" className="link" onClick={() => setSent(false)}>Change address</button><button className="btn primary" disabled={busy || code.length !== 6}>Verify</button></div>
              </form>
            )}
          </div>
        )}

        {step === 'extras' && (
          <div>
            <h1>You're all set</h1>
            <p>A few optional things to make it yours. You can do them any time in Settings.</p>
            <ul className="wiz-extras">
              <li><b>Bring your old email</b>: Settings → Import</li>
              <li><b>Email signature</b>: Settings → Signatures</li>
              <li><b>Set up your phone</b>: Settings → Phone &amp; apps (scan a QR code)</li>
            </ul>
            <div className="step-actions"><button className="btn primary" onClick={next}>Go to my inbox</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
