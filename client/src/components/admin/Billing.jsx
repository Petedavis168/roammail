import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';

const money = (n, cur = 'USD') => new Intl.NumberFormat([], { style: 'currency', currency: cur, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

/** Monthly / yearly choice that sends the admin to Stripe's secure checkout. */
export function PlanPicker({ orgId, seats = 1, adding = 0, title = 'Choose your plan', note, onCancel }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [interval, setInterval] = useState('month');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/billing/config').then(setCfg).catch(() => {}); }, []);
  if (!cfg) return <div className="spinner" />;
  const per = interval === 'year' ? cfg.perUserYearly : cfg.perUserMonthly;
  const go = async () => {
    setBusy(true);
    try { const r = await api.post(`/api/billing/${orgId}/checkout`, { interval, seats, adding }); location.href = r.url; }
    catch (e) { toast(e.message, { error: true }); setBusy(false); }
  };
  return (
    <div className="plan-picker">
      <h3>{title}</h3>
      {note && <p className="muted small">{note}</p>}
      <div className="preset-row">
        {[['month', 'Monthly', `${money(cfg.perUserMonthly, cfg.currency)} per user / month`, 'Cancel anytime'],
          ['year', 'Yearly', `${money(cfg.perUserYearly, cfg.currency)} per user / year`, `Pay once a year`]].map(([v, l, p, d]) => (
          <label key={v} className={`radio-card ${interval === v ? 'on' : ''}`}><input type="radio" checked={interval === v} onChange={() => setInterval(v)} />
            <div><b>{l}</b><span>{p}</span><small className="muted">{d}</small></div></label>
        ))}
      </div>
      <div className="plan-total"><span>{seats} {seats === 1 ? 'user' : 'users'} × {money(per, cfg.currency)}</span><b>{money(per * seats, cfg.currency)} / {interval}</b></div>
      <p className="muted small"><Icon name="lock" size={12} /> You'll pay on Stripe's secure page. We never see or store your card. Adding or removing users later adjusts your bill automatically.</p>
      <div className="step-actions">{onCancel && <button className="btn" onClick={onCancel}>Not now</button>}<button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Opening secure checkout…' : 'Continue to secure payment'}</button></div>
    </div>
  );
}

export function FriendlyCode({ orgId, onApplied }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  return (
    <form className="pick-time" onSubmit={async (e) => { e.preventDefault(); try { await api.post(`/api/billing/${orgId}/friendly`, { code }); toast('Friendly Web Services customer confirmed. Your first mailbox is free!'); onApplied?.(); } catch (err) { toast(err.message, { error: true }); } }}>
      <input placeholder="FWS-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoCapitalize="characters" />
      <button className="btn">Apply code</button>
    </form>
  );
}

export default function Billing({ org }) {
  const toast = useToast();
  const [b, setB] = useState(null);
  const [choose, setChoose] = useState(false);
  const load = () => api.get(`/api/billing/${org.id}`).then(setB).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, [org.id]);
  if (!b) return <div className="spinner" />;
  if (!b.enabled) return <div className="empty-card"><p>Billing isn't turned on for this server. All mailboxes are included.</p></div>;
  const statusPill = { active: <span className="pill ok">Active</span>, past_due: <span className="pill warn">Payment failed</span>, canceled: <span className="pill bad">Canceled</span>, none: <span className="pill">No plan yet</span> }[b.status] || <span className="pill">{b.status}</span>;
  const portal = async () => { try { const r = await api.post(`/api/billing/${org.id}/portal`); location.href = r.url; } catch (e) { toast(e.message, { error: true }); } };
  return (
    <div className="org-sig-admin">
      <div className="stats">
        <div className="stat"><b>{b.used}</b><span>mailboxes in use</span></div>
        <div className="stat"><b>{b.free}</b><span>included free{b.friendly ? ' (Friendly customer)' : ''}</span></div>
        <div className="stat"><b>{b.paidSeats}</b><span>paid users</span></div>
        <div className="stat"><b>{new Intl.NumberFormat([], { style: 'currency', currency: b.currency }).format((b.status === 'active' || b.status === 'past_due' ? b.paidSeats : 0) * b.perUser)}</b><span>you pay per {b.interval || 'month'}</span></div>
      </div>
      {b.paidSeats > b.billable && (b.status === 'active' || b.status === 'past_due') && (
        <div className="banner">You're paying for {b.paidSeats - b.billable} more {b.paidSeats - b.billable === 1 ? 'user' : 'users'} than you have. Add people to use {b.paidSeats - b.billable === 1 ? 'it' : 'them'}, or lower the number of users in Manage billing.</div>
      )}
      <div className="card">
        <h3>Plan {statusPill} {b.friendly && <span className="pill ok">Friendly Web Services customer</span>}</h3>
        <p className="muted small">{b.friendly ? 'Your first mailbox is free.' : ''} Each {b.friendly ? 'additional ' : ''}user is {new Intl.NumberFormat([], { style: 'currency', currency: b.currency }).format(b.perUser)} per {b.interval || 'month'}. Groups and aliases are always free and unlimited.</p>
        {b.status === 'past_due' && <div className="banner warn">Your last payment didn't go through. Update your card in Manage billing to avoid interruption.</div>}
        {b.status === 'canceled' && <div className="banner warn">Your subscription was canceled. Mailboxes beyond the free allowance will be paused soon. Choose a plan to keep them running.</div>}
        <div className="step-actions" style={{ justifyContent: 'flex-start' }}>
          {(b.status === 'active' || b.status === 'past_due') && <button className="btn primary" onClick={portal}><Icon name="external" size={14} /> Manage billing (card, invoices, monthly/yearly)</button>}
          {(b.status === 'none' || b.status === 'canceled') && b.billable > 0 && <button className="btn primary" onClick={() => setChoose(true)}>Choose a plan</button>}
        </div>
        {choose && <PlanPicker orgId={org.id} seats={Math.max(1, b.billable)} onCancel={() => setChoose(false)} />}
      </div>
      {!b.friendly && (
        <div className="card">
          <h3>Friendly Web Services customer?</h3>
          <p className="muted small">Enter the customer code from Friendly Web Services and your first mailbox is free.</p>
          <FriendlyCode orgId={org.id} onApplied={load} />
        </div>
      )}
    </div>
  );
}
