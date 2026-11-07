import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';
import { fmtDate } from '../../util.js';

const when = (t) => (t ? fmtDate(new Date(t).toISOString()) : '');

export default function Abuse() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/super/abuse').then(setD).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []);
  const act = async (fn, msg) => { try { await fn(); toast(msg); load(); } catch (e) { toast(e.message, { error: true }); } };
  if (!d) return <div className="spinner" />;
  const listed = (d.blocklists?.results || []).filter((r) => r.status === 'listed');
  return (
    <div className="settings-section">
      <p className="muted small">
        Every 5 minutes the watchdog checks mailcow's logs. Free accounts are paused automatically when {d.limits.spamPerHour}+ of their outgoing
        messages in an hour look like spam, or when they hit the sending limit {d.limits.rateLimitHitsPerHour}+ times.
        Business accounts are {d.limits.holdBusiness ? 'paused too' : 'flagged for review (and their admin is told)'}.
        Paused accounts can still read mail. Public reports come in at <a href="/abuse" target="_blank" rel="noreferrer">/abuse</a>.
      </p>
      <div className="actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); await act(() => api.post('/api/super/abuse/scan'), 'Checked'); setBusy(false); }}>Check now</button>
        <span className="muted small">Last check: {d.lastScan ? `${when(d.lastScan.at)} (${d.lastScan.checked} log lines)` : 'not yet'}</span>
      </div>

      <h3>Mail server blocklists</h3>
      {!d.blocklists ? <p className="muted small">Set MAIL_SERVER_IPS to your mail server's public IP to check it every hour.</p>
        : listed.length ? <p className="bad"><b>Listed:</b> {listed.map((r) => `${r.ip} on ${r.zone}`).join(', ')}. Follow the delisting steps in docs/DELIVERABILITY.md.</p>
          : <p className="small">✓ Not listed anywhere we check ({when(d.blocklists.at)}).</p>}

      <h3>Paused and flagged accounts ({d.holds.length})</h3>
      {d.holds.length === 0 && <p className="muted small">None.</p>}
      {d.holds.map((h) => (
        <div key={h.email} className="card" style={{ marginBottom: 8 }}>
          <b>{h.email}</b> <span className={h.status === 'held' ? 'bad' : 'muted'}>{h.status === 'held' ? 'sending paused' : 'flagged'}</span>
          <div className="small">{h.reason} · {when(h.at)}</div>
          <div className="actions" style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {h.status === 'flagged' && <button className="btn sm" onClick={() => { const reason = prompt(`Pause sending for ${h.email}? Why?`); if (reason) act(() => api.post('/api/super/abuse/hold', { email: h.email, reason }), 'Sending paused'); }}>Pause sending</button>}
            <button className="btn sm" onClick={() => { if (confirm(`Turn sending back on for ${h.email}? Make sure they changed their password first.`)) act(() => api.post('/api/super/abuse/lift', { email: h.email }), 'Sending restored'); }}>{h.status === 'held' ? 'Restore sending' : 'Dismiss'}</button>
          </div>
        </div>
      ))}

      <h3>Open reports ({d.reports.length})</h3>
      {d.reports.length === 0 && <p className="muted small">None.</p>}
      {d.reports.map((r) => (
        <div key={r.id} className="card" style={{ marginBottom: 8 }}>
          <b>{r.offender}</b> <span className="muted small">reported {when(r.at)}{r.reporter ? ` by ${r.reporter}` : ''}</span>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.details}</div>
          <div className="actions" style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn sm" onClick={() => { const reason = prompt(`Pause sending for ${r.offender}? Why?`, 'Confirmed abuse report'); if (reason) act(() => api.post('/api/super/abuse/hold', { email: r.offender, reason }), 'Sending paused'); }}>Pause sending</button>
            <button className="btn sm" onClick={() => act(() => api.post(`/api/super/abuse/reports/${r.id}/close`), 'Closed')}>Close</button>
          </div>
        </div>
      ))}
    </div>
  );
}
