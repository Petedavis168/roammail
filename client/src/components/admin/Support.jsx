import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { fmtDate } from '../../util.js';

const ACTIONS = [
  ['signout', 'Sign out everywhere'], ['reset2fa', 'Turn off 2-step verification'],
  ['cancel-recovery', 'Cancel pending recovery'], ['suspend', 'Suspend account'], ['unsuspend', 'Unsuspend account'],
];
const when = (t) => (t ? fmtDate(new Date(t).toISOString()) : '');

function Tickets() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const load = () => api.get('/api/super/tickets').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list) return null;
  return (
    <>
      <h3>Support requests ({list.length} open)</h3>
      {list.length === 0 && <p className="muted small">None. New requests from the help centre also arrive in your support inbox.</p>}
      {list.map((t) => (
        <div key={t.id} className="card" style={{ marginBottom: 8 }}>
          <b>#{t.id} {t.topic}</b> <span className="muted small">{t.email}{t.account ? ` · account ${t.account}` : ''} · {when(t.at)}</span>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{t.message}</div>
          <div className="actions" style={{ display: 'flex', gap: 6 }}>
            <a className="btn sm" href={`mailto:${t.email}?subject=${encodeURIComponent(`Re: Support #${t.id}`)}`}>Reply</a>
            <button className="btn sm" onClick={async () => { try { await api.post(`/api/super/tickets/${t.id}/close`); load(); } catch (e) { toast(e.message, { error: true }); } }}>Close</button>
          </div>
        </div>
      ))}
    </>
  );
}

export default function Support() {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const lookup = async (e) => {
    e?.preventDefault(); setBusy(true);
    try { setD(await api.get('/api/super/support/lookup', { email: email.trim() })); } catch (err) { toast(err.message, { error: true }); setD(null); } finally { setBusy(false); }
  };
  const act = async (action, label) => {
    const reason = prompt(`${label} for ${d.email}\n\nWhy? (saved in the audit log, e.g. "verified ID on support call #123")`);
    if (!reason) return;
    try { await api.post('/api/super/support/action', { email: d.email, action, reason }); toast('Done'); lookup(); } catch (err) { toast(err.message, { error: true }); }
  };
  return (
    <div className="settings-section">
      <Tickets />
      <h3>Look up an account</h3>
      <p className="muted small">Look up any account to help someone. Every lookup and action is recorded in the audit log, and the person is emailed when their security settings change. Always confirm who you're talking to before changing anything.</p>
      <form className="pick-time" onSubmit={lookup}>
        <input type="email" placeholder="name@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn primary" disabled={busy}><Icon name="search" size={14} /> Look up</button>
      </form>
      {d && (
        <>
          {!d.exists ? <p>No mailbox exists for {d.email}.</p> : (
            <table className="kv">
              <tbody>
                <tr><th>Name</th><td>{d.name || '—'}</td></tr>
                <tr><th>Status</th><td>{d.active ? 'Active' : <b>Suspended</b>}</td></tr>
                <tr><th>Storage</th><td>{d.usedMb} MB of {d.quotaMb || '∞'} MB</td></tr>
                <tr><th>Business</th><td>{d.org ? `${d.org.name} (${d.org.plan || 'standard'}, ${d.org.billing_status || 'no billing'})` : 'Free account'}</td></tr>
                <tr><th>Signed up</th><td>{d.signup ? when(d.signup.created_at) : '—'}</td></tr>
                <tr><th>2-step</th><td>{d.twoFactor ? 'On' : 'Off'}{d.pendingRecovery && <> · <b>recovery pending until {when(d.pendingRecovery.execute_after)}</b></>}</td></tr>
                <tr><th>Recovery email</th><td>{d.recovery ? `${d.recovery} ${d.recoveryVerified ? '(verified)' : '(not verified)'}` : 'None'}</td></tr>
                <tr><th>Signed-in devices</th><td>{d.sessions}</td></tr>
              </tbody>
            </table>
          )}
          {d.exists && <div className="actions" style={{ flexWrap: 'wrap', gap: 6, display: 'flex', margin: '12px 0' }}>
            {ACTIONS.map(([k, l]) => <button key={k} className="btn sm" onClick={() => act(k, l)}>{l}</button>)}
          </div>}
          <h3>Recent sign-ins</h3>
          {d.events.length ? d.events.map((e, i) => <div key={i} className="small">{e.ok ? '✓' : '✗'} {when(e.at)} · {e.ip} {e.reason ? `· ${e.reason}` : ''}</div>) : <p className="muted small">None</p>}
          <h3>Activity</h3>
          {d.audit.length ? d.audit.map((a, i) => <div key={i} className="small">{when(a.at)} · {a.actor} · {a.action}</div>) : <p className="muted small">None</p>}
        </>
      )}
    </div>
  );
}
