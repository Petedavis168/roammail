import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';

const pct = (x, digits = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(digits)}%`);
const STATUS = { good: ['✓', 'Good'], warn: ['!', 'Could be better'], bad: ['✕', 'Needs fixing'] };
function Badge({ level, children }) {
  const [icon, label] = STATUS[level] || STATUS.warn;
  return <span className={`dl-badge dl-${level}`}><span aria-hidden="true">{icon}</span> {children || label}</span>;
}
const repLevel = (r) => ({ HIGH: 'good', MEDIUM: 'warn', LOW: 'bad', BAD: 'bad' }[r] || 'warn');
const spamLevel = (x) => (x === null ? 'warn' : x < 0.001 ? 'good' : x < 0.003 ? 'warn' : 'bad');

/** Daily bounce rate, one bar per day, with a tooltip and a table for screen readers. */
function BounceBars({ history }) {
  const days = history.filter((d) => d.sent !== null).slice(-30);
  if (!days.length) return <p className="muted small">The daily history starts with tomorrow's report.</p>;
  const rate = (d) => (d.sent + d.bounced ? d.bounced / (d.sent + d.bounced) : 0);
  const max = Math.max(0.03, ...days.map(rate));
  return (
    <figure className="dl-chart">
      <figcaption className="small">Bounce rate per day (keep under 2%)</figcaption>
      <div className="dl-bars" role="img" aria-label="Bounce rate per day; the table below has the numbers">
        <span className="dl-limit" style={{ bottom: `${(0.02 / max) * 100}%` }}><span>2%</span></span>
        {days.map((d) => (
          <span key={d.day} className="dl-bar-hit" title={`${d.day}: ${pct(rate(d))} bounced (${d.bounced} of ${d.sent + d.bounced}), ${d.deferred} delayed`}>
            <span className="dl-bar" style={{ height: `${Math.max(1, (rate(d) / max) * 100)}%` }} />
          </span>
        ))}
      </div>
      <details className="small"><summary>Show as a table</summary>
        <table className="dl-table"><thead><tr><th>Day</th><th>Delivered</th><th>Bounced</th><th>Delayed</th><th>Complaints</th><th>Paused</th></tr></thead>
          <tbody>{days.slice().reverse().map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.sent}</td><td>{d.bounced} ({pct(rate(d))})</td><td>{d.deferred}</td><td>{d.complaints}</td><td>{d.held}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

export default function Deliverability() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const load = (refresh) => { setBusy(true); api.get('/api/super/deliverability', { domain, ...(refresh ? { refresh: 1 } : {}) }).then((x) => { setD(x); setDomain(x.domain); }).catch((e) => toast(e.message, { error: true })).finally(() => setBusy(false)); };
  useEffect(() => { load(); }, [domain]);
  if (!d) return <div className="spinner" />;
  const t = d.today || {}; const del = t.delivery;
  const g = d.google || {}; const gLast = g.days?.[g.days.length - 1];
  const ms = d.microsoft || {};
  const listed = (t.blocklists || []).filter((b) => b.status === 'listed');
  return (
    <div className="settings-section deliverability">
      <p className="muted small">Are our emails reaching inboxes? Last 24 hours from the mail server, plus how Gmail and Outlook.com see us.</p>
      <div className="actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="small">Domain <select value={domain} onChange={(e) => setDomain(e.target.value)}>{d.domains.map((x) => <option key={x}>{x}</option>)}</select></label>
        <button className="btn" disabled={busy} onClick={() => load(true)}>{busy ? 'Checking…' : 'Check now'}</button>
      </div>

      <div className="dl-tiles">
        <div className="dl-tile"><small>Delivered</small><b>{del ? del.sent : '—'}</b></div>
        <div className="dl-tile"><small>Bounced</small><b>{pct(t.bounceRate)}</b><Badge level={!del ? 'warn' : t.bounceRate > 0.02 ? 'bad' : 'good'}>{!del ? 'No data' : t.bounceRate > 0.02 ? 'Over 2%' : 'Under 2%'}</Badge></div>
        <div className="dl-tile"><small>Delayed</small><b>{pct(t.deferRate)}</b><Badge level={!del ? 'warn' : t.deferRate > 0.05 ? 'bad' : 'good'}>{!del ? 'No data' : t.deferRate > 0.05 ? 'Over 5%' : 'Under 5%'}</Badge></div>
        <div className="dl-tile"><small>Spam complaints</small><b>{t.complaints ?? '—'}</b><Badge level={t.complaints ? 'bad' : 'good'}>{t.complaints ? 'Look into it' : 'None'}</Badge></div>
        <div className="dl-tile"><small>Blocklists</small><b>{listed.length}</b><Badge level={listed.length ? 'bad' : 'good'}>{listed.length ? `Listed on ${listed.map((b) => b.zone).join(', ')}` : 'Not listed'}</Badge></div>
      </div>
      {t.advice && <p className="small">Warm-up advice: <b>{t.advice}</b>. {(t.why || []).join('; ')}</p>}
      {!del && <p className="muted small">Delivery numbers need the provisioner to allow reading the Postfix log.</p>}

      <BounceBars history={d.history} />

      {del && Object.keys(del.byProvider || {}).length > 0 && <>
        <h3>By provider (24 hours)</h3>
        <table className="dl-table"><thead><tr><th>Provider</th><th>Delivered</th><th>Bounced</th><th>Delayed</th></tr></thead>
          <tbody>{Object.entries(del.byProvider).map(([k, v]) => <tr key={k}><td>{{ gmail: 'Gmail', microsoft: 'Outlook / Hotmail', yahoo: 'Yahoo / AOL', other: 'Everyone else' }[k] || k}</td><td>{v.sent}</td><td>{v.bounced}</td><td>{v.deferred}</td></tr>)}</tbody></table>
      </>}

      <h3>Gmail (Google Postmaster Tools)</h3>
      {!g.connected ? <p className="small muted">Not connected. Add the domain at postmaster.google.com, then set GOOGLE_POSTMASTER_CLIENT_ID, GOOGLE_POSTMASTER_CLIENT_SECRET and GOOGLE_POSTMASTER_REFRESH_TOKEN (see docs/DELIVERABILITY.md).</p>
        : g.error ? <p className="form-error small">{g.error}</p>
          : !gLast ? <p className="small muted">{g.note}</p>
            : <div className="dl-tiles">
              <div className="dl-tile"><small>Spam reported by Gmail users</small><b>{pct(gLast.spamRate, 2)}</b><Badge level={spamLevel(gLast.spamRate)}>{gLast.spamRate === null ? 'Too little mail' : gLast.spamRate < 0.001 ? 'Under 0.1%' : gLast.spamRate < 0.003 ? 'Keep under 0.3%' : 'Over 0.3%: Gmail will filter us'}</Badge></div>
              <div className="dl-tile"><small>Domain reputation</small><b>{gLast.domainReputation || '—'}</b><Badge level={repLevel(gLast.domainReputation)} /></div>
              <div className="dl-tile"><small>IP reputation</small><b>{gLast.ipReputation || '—'}</b><Badge level={repLevel(gLast.ipReputation)} /></div>
              <div className="dl-tile"><small>Signed (DKIM) / DMARC pass</small><b>{pct(gLast.dkim, 0)} / {pct(gLast.dmarc, 0)}</b></div>
              <small className="muted" style={{ gridColumn: '1/-1' }}>Latest day Google reported: {gLast.day}</small>
            </div>}

      <h3>Outlook.com (Microsoft SNDS)</h3>
      {!ms.connected ? <p className="small muted">Not connected. Register the mail server IPs at sendersupport.olc.protection.outlook.com/snds, turn on automated data access and set SNDS_KEY.</p>
        : ms.error ? <p className="form-error small">{ms.error}</p>
          : !ms.rows?.length ? <p className="small muted">{ms.note}</p>
            : <table className="dl-table"><thead><tr><th>IP</th><th>Period</th><th>Recipients</th><th>Microsoft's verdict</th><th>Complaints</th><th>Spam traps</th></tr></thead>
              <tbody>{ms.rows.map((r) => <tr key={r.ip + r.from}><td>{r.ip}</td><td>{r.from} – {r.to}</td><td>{r.recipients}</td><td><Badge level={{ GREEN: 'good', YELLOW: 'warn', RED: 'bad' }[r.filter] || 'warn'}>{r.filter || '—'}</Badge></td><td>{r.complaintRate || '—'}</td><td>{r.trapHits}</td></tr>)}</tbody></table>}

      <h3>DNS health for {d.domain}</h3>
      {d.health?.error ? <p className="form-error small">{d.health.error}</p> : (
        <ul className="dl-health">
          {(d.health || []).map((h) => (
            <li key={h.name}><Badge level={h.level}>{h.name}</Badge> <code className="small">{String(h.found).slice(0, 140)}</code>{h.fix && <div className="small muted">{h.fix}</div>}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
