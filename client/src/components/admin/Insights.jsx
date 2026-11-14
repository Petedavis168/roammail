import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';

const money = (c, cur = 'usd') => (c === null || c === undefined ? '—' : new Intl.NumberFormat([], { style: 'currency', currency: cur }).format(c / 100));
function Tile({ label, value, prev, note }) {
  const d = typeof value === 'number' && typeof prev === 'number' ? value - prev : null;
  return (
    <div className="dl-tile">
      <small>{label}</small><b>{value ?? '—'}</b>
      {d !== null && <span className="small muted">{d === 0 ? 'same as last week' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs last week`}</span>}
      {note && <span className="small muted">{note}</span>}
    </div>
  );
}

/** How the business is doing this week, and where sign-ups drop off. */
export default function Insights() {
  const toast = useToast();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/api/super/insights').then(setD).catch((e) => toast(e.message, { error: true })); }, []);
  if (!d) return <div className="spinner" />;
  const c = d.cur; const p = d.prev;
  const steps = d.funnelSteps.map(([k, l]) => ({ k, l, n: c.funnel[k] || 0 }));
  const top = Math.max(1, ...steps.map((s) => s.n));
  const wmax = Math.max(1, ...d.weeks.map((w) => w.signups));
  return (
    <div className="settings-section deliverability">
      <p className="muted small">The last 7 days compared with the 7 before. This is also emailed to you every Monday.</p>
      <div className="dl-tiles">
        <Tile label="New free accounts" value={c.signups} prev={p.signups} />
        <Tile label="New businesses" value={c.businesses} prev={p.businesses} />
        <Tile label="People who signed in" value={c.active} prev={p.active} />
        <Tile label="Emails sent (web app)" value={c.sent} prev={p.sent} />
        <Tile label="Money in" value={c.money ? money(c.money.cents) : '—'} note={c.money ? `${c.money.invoices} payments · last week ${money(p.money?.cents)}` : 'Stripe not connected'} />
        <Tile label="Premium members" value={c.premiumActive} note={`${c.premiumNew} new`} />
        <Tile label="ID checks passed" value={c.idVerified} prev={p.idVerified} />
        <Tile label="At the free monthly limit" value={c.capHit} />
        <Tile label="Paused for spam" value={c.paused} prev={p.paused} />
        <Tile label="Support requests" value={c.tickets} prev={p.tickets} />
        <Tile label="Uptime (our checks)" value={c.uptime === null ? '—' : `${(c.uptime * 100).toFixed(2)}%`} />
        <Tile label="All accounts / businesses" value={`${d.totals.users} / ${d.totals.businesses}`} />
      </div>

      <h3>New accounts per week</h3>
      <figure className="dl-chart">
        <div className="dl-bars" role="img" aria-label="New accounts per week for the last 8 weeks; the table below has the numbers">
          {d.weeks.map((w) => <span key={w.from} className="dl-bar-hit" title={`Week of ${new Date(w.from).toLocaleDateString()}: ${w.signups}`}><span className="dl-bar" style={{ height: `${Math.max(1, (w.signups / wmax) * 100)}%` }} /></span>)}
        </div>
        <details className="small"><summary>Show as a table</summary>
          <table className="dl-table"><thead><tr><th>Week of</th><th>New accounts</th></tr></thead><tbody>{d.weeks.slice().reverse().map((w) => <tr key={w.from}><td>{new Date(w.from).toLocaleDateString()}</td><td>{w.signups}</td></tr>)}</tbody></table>
        </details>
      </figure>

      <h3>Where sign-ups drop off (last 7 days)</h3>
      <p className="muted small">How many people reached each step. A big drop between two steps is where to make things easier.</p>
      <table className="dl-table funnel">
        <tbody>{steps.map((s, i) => {
          const before = i ? steps[i - 1].n : null;
          const kept = before ? Math.round((s.n / before) * 100) : null;
          return (
            <tr key={s.k}>
              <td>{s.l}</td>
              <td style={{ width: '45%' }}><div className="funnel-bar" style={{ width: `${Math.max(1, (s.n / top) * 100)}%` }} /></td>
              <td><b>{s.n}</b></td>
              <td className="muted">{kept === null ? '' : `${kept}% carried on`}</td>
            </tr>
          );
        })}</tbody>
      </table>
      <button className="btn" onClick={() => api.get('/api/super/insights', { send: 1 }).then(() => toast('Report emailed')).catch((e) => toast(e.message, { error: true }))}>Email me this report now</button>
    </div>
  );
}
