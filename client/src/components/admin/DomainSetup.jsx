import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { PlanPicker, FriendlyCode } from './Billing.jsx';

export function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="copy" onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }} title="Copy">
      <Icon name={done ? 'check' : 'copy'} size={14} /> {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function RecordTable({ records, showStatus = true }) {
  return (
    <div className="dns-table">
      <div className="dns-row head"><span>Type</span><span>Host / Name</span><span>Value</span><span>Status</span></div>
      {records.map((r) => (
        <div key={r.key || r.type + r.host} className={`dns-row ${r.ok ? 'ok' : ''}`}>
          <span className="dns-type">{r.type}{r.priority ? <small>priority {r.priority}</small> : null}</span>
          <span className="mono">{r.host} <Copy text={r.host} /></span>
          <span className="mono val"><span className="v">{r.value}</span> <Copy text={r.value} /><small className="muted">{r.purpose}</small></span>
          <span className="dns-status">
            {!showStatus ? null : r.ok ? <span className="ok"><Icon name="check" size={16} /> Found</span>
              : <span className={r.optional ? 'muted' : 'pending'}>{r.optional ? 'Optional' : 'Waiting…'}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

const HELP = [
  ['GoDaddy', 'My Products → your domain → DNS → Add New Record'],
  ['Namecheap', 'Domain List → Manage → Advanced DNS → Add New Record'],
  ['Cloudflare', 'Your site → DNS → Records → Add record (set proxy to "DNS only")'],
  ['Google / Squarespace', 'Domains → your domain → DNS → Custom records'],
  ['AWS Route 53', 'Hosted zones → your domain → Create record'],
];

/** Shows ownership verification (pending) or the full DNS checklist (active). Polls while incomplete. */
export function DomainStatus({ domain, onActivated, onDone }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => api.get(`/api/domains/${encodeURIComponent(domain)}`).then(setS).catch((e) => setMsg(e.message));
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [domain]);
  // The address they asked for at sign-up (bob@theirdomain.com): made as soon as the domain is live, same password
  const [ownerBox, setOwnerBox] = useState(null);
  useEffect(() => {
    if (s?.status !== 'active' || !s.ownerMailbox?.mine || ownerBox) return;
    setOwnerBox({ busy: true });
    api.post(`/api/domains/${encodeURIComponent(domain)}/owner-mailbox`).then((r) => {
      setOwnerBox(r);
      if (!s.ownerMailbox.created) toast(`${r.email} is ready`);
    }).catch((e) => setOwnerBox({ error: e.message }));
  }, [s?.status, s?.ownerMailbox?.created]);

  const verify = async (skip) => {
    setBusy('verify'); setMsg('');
    try {
      const r = await api.post(`/api/domains/${encodeURIComponent(domain)}/verify`, { skipVerification: !!skip });
      if (r.ok) { toast('Domain verified and created on the mail server'); await load(); onActivated?.(); } else setMsg(r.error);
    } catch (e) { setMsg(e.message); } finally { setBusy(''); }
  };
  const autoDns = async () => {
    setBusy('r53'); setMsg('');
    try { await api.post(`/api/domains/${encodeURIComponent(domain)}/auto-dns`); toast('DNS records added in Route 53. They usually appear within a minute.'); await load(); onActivated?.(); }
    catch (e) { setMsg(e.message); } finally { setBusy(''); }
  };

  if (!s) return <div className="list-msg">{msg || <div className="spinner" />}</div>;

  if (s.status === 'verified') {
    return (
      <div className="setup-step">
        <div className="step-head"><span className="step-n done"><Icon name="check" size={16} /></span>
          <div><h3>{s.domain} is verified. One last step</h3><p className="muted">Choose how you'd like to pay. Your email goes live as soon as payment is done.</p></div></div>
        <PlanPicker orgId={s.orgId} seats={1} title="Your plan" note="Start with 1 user. You can add more people any time and your bill adjusts automatically." />
        <details className="help"><summary>Friendly Web Services customer?</summary>
          <p className="muted small">Enter your customer code and your first mailbox is free.</p>
          <FriendlyCode orgId={s.orgId} onApplied={async () => { await api.post(`/api/domains/${encodeURIComponent(domain)}/verify`, {}); load(); onActivated?.(); }} />
        </details>
      </div>
    );
  }

  if (s.status === 'pending') {
    return (
      <div className="setup-step">
        <div className="step-head"><span className="step-n">2</span><div><h3>Prove you own {s.domain}</h3>
          <p className="muted">Sign in where you bought your domain and add this one record. It doesn't affect your website or existing email.</p></div></div>
        {s.route53 && (
          <div className="callout good">
            <Icon name="check" /> <div><b>This domain is in your AWS account.</b> We can add every record for you.</div>
            <button className="btn primary" disabled={!!busy} onClick={autoDns}>{busy === 'r53' ? 'Setting up…' : 'Set up automatically'}</button>
          </div>
        )}
        {!s.route53 && <CloudflareSetup domain={s.domain} onDone={async () => { await load(); }} />}
        <RecordTable records={[{ ...s.verify, key: 'verify', host: '@', ok: s.verify.ok }]} />
        <details className="help"><summary>Where do I add this?</summary>
          <ul>{HELP.map(([p, h]) => <li key={p}><b>{p}:</b> {h}</li>)}</ul>
          <p className="muted small">Use <b>@</b> (or leave the host blank) for the domain itself. If your provider asks for TTL, choose the lowest option.</p>
        </details>
        {msg && <div className="form-error">{msg}</div>}
        <div className="step-actions">
          <button className="btn primary" disabled={!!busy} onClick={() => verify(false)}>{busy === 'verify' ? 'Checking…' : 'I\'ve added it — verify'}</button>
          {s.route53 === false && null}
          <SuperSkip onSkip={() => verify(true)} />
        </div>
      </div>
    );
  }

  const required = s.records.filter((r) => !r.optional);
  const done = required.filter((r) => r.ok).length;
  return (
    <div className="setup-step">
      <div className="step-head"><span className={`step-n ${s.ready ? 'done' : ''}`}>{s.ready ? <Icon name="check" size={16} /> : 3}</span>
        <div><h3>{s.ready ? `${s.domain} is ready for email` : `Point ${s.domain}'s email to us`}
          {s.sending && <span className={`pill ${s.sending === 'relay' ? 'ok' : ''}`} style={{ marginLeft: 8, verticalAlign: 'middle' }} title={s.sending === 'relay' ? 'Outgoing mail is delivered through a trusted relay for better inbox placement' : 'Outgoing mail is delivered straight from our mail server'}>Sending: {s.sending === 'relay' ? 'Trusted relay' : 'Direct'}</span>}</h3>
          <p className="muted">{s.ready ? 'All required records are in place. Mail to your domain now arrives here.' : `Add these records at your DNS provider. ${done} of ${required.length} required records found. We check automatically.`}</p></div></div>
      <div className="progress"><div style={{ width: `${(done / required.length) * 100}%` }} /></div>
      {!s.route53 && !s.ready && <CloudflareSetup domain={s.domain} onDone={async () => { await load(); onActivated?.(); }} />}
      {s.route53 && !s.ready && (
        <div className="callout good"><Icon name="check" /> <div><b>This domain is in your AWS account.</b></div>
          <button className="btn primary" disabled={!!busy} onClick={autoDns}>{busy === 'r53' ? 'Setting up…' : 'Add records automatically'}</button></div>
      )}
      {ownerBox?.email && (
        <div className="callout good"><Icon name="check" /> <div><b>{ownerBox.email} is ready.</b> It uses the same password you chose at sign-up.</div>
          <button className="btn primary" onClick={() => location.assign(`/${ownerBox.mailboxId}/inbox`)}>Open {ownerBox.email}</button></div>
      )}
      {ownerBox?.error && <div className="form-error">Couldn't create {s.ownerMailbox.address} yet: {ownerBox.error}</div>}
      <RecordTable records={s.records} />
      <p className="muted small">If you already use another email provider on this domain, changing the MX record moves email delivery here. Only one provider can receive mail at a time.</p>
      {msg && <div className="form-error">{msg}</div>}
      <div className="step-actions">
        <button className="btn" onClick={load}><Icon name="refresh" size={16} /> Check records</button>
        {onDone && <button className="btn primary" onClick={onDone}>{s.ready ? 'Add your team' : 'Continue — add users now'}</button>}
      </div>
    </div>
  );
}

let isSuper = false;
export const setSuper = (v) => { isSuper = v; };
function SuperSkip({ onSkip }) {
  if (!isSuper) return null;
  return <button className="btn ghost" onClick={() => confirm('Activate without DNS verification? Only do this for domains you control.') && onSkip()}>Activate without verifying (super-admin)</button>;
}

export function DomainWizard({ orgId, onCreated, onDone, refreshMe }) {
  const [form, setForm] = useState({ orgName: '', domain: '', code: '' });
  const [pricing, setPricing] = useState(null);
  useEffect(() => { api.get('/api/billing/config').then(setPricing).catch(() => {}); }, []);
  const [created, setCreated] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api.post('/api/domains', { ...form, orgId });
      if (form.code.trim()) {
        try { await api.post(`/api/billing/${r.orgId}/friendly`, { code: form.code }); }
        catch (codeErr) { setErr(`Domain added, but the customer code didn't work: ${codeErr.message} You can enter it again later.`); }
      }
      setCreated(r.domain);
      await refreshMe?.();
      onCreated?.(r);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  return (
    <div className="wizard">
      <div className={`setup-step ${created ? 'collapsed-step' : ''}`}>
        <div className="step-head"><span className={`step-n ${created ? 'done' : ''}`}>{created ? <Icon name="check" size={16} /> : 1}</span>
          <div><h3>{created ? `Added ${created}` : 'Your business domain'}</h3>
            {!created && <p className="muted">Use the domain you own, like <b>yourbusiness.com</b>. Your team will get addresses like <b>you@yourbusiness.com</b>.</p>}</div></div>
        {!created && (
          <form onSubmit={submit} className="wizard-form">
            {!orgId && <label>Business name<input required value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} placeholder="Acme Plumbing" /></label>}
            <label>Domain<input required value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="acmeplumbing.com" autoCapitalize="off" /></label>
            {pricing?.enabled && !orgId && (
              <label className="wide-field">Friendly Web Services customer code <small className="muted">(optional, makes your first mailbox free)</small>
                <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="FWS-XXXX-XXXX-XXXX" /></label>
            )}
            {pricing?.enabled && !orgId && <p className="muted small wide-field">Pricing: {pricing.currency === 'USD' ? '$' : ''}{pricing.perUserMonthly} per user per month, or {pricing.currency === 'USD' ? '$' : ''}{pricing.perUserYearly} per year. Groups and aliases are free. You only pay at the end, after your domain is verified.</p>}
            {err && <div className="form-error">{err}</div>}
            <button className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Continue'}</button>
          </form>
        )}
      </div>
      {created && <DomainStatus domain={created} onActivated={refreshMe} onDone={() => onDone?.(created)} />}
    </div>
  );
}

/** Domains on Cloudflare: paste a one-time API token and every record is added for you. */
function CloudflareSetup({ domain, onDone }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api.post(`/api/domains/${encodeURIComponent(domain)}/cloudflare`, { token });
      toast(`Done: ${r.added} records added${r.replaced ? `, ${r.replaced} old mail records replaced` : ''}. Checking them now…`);
      setToken(''); setOpen(false); await onDone?.();
    } catch (x) { toast(x.message, { error: true }); }
    setBusy(false);
  };
  return (
    <div className="callout cf-setup">
      <div><b>☁️ Is {domain} on Cloudflare?</b> We can add everything for you in one step.</div>
      {!open ? <button className="btn" onClick={() => setOpen(true)}>Set up with Cloudflare</button> : (
        <form onSubmit={run} className="form">
          <ol className="small">
            <li>In Cloudflare, open <b>My Profile → API Tokens → Create Token</b> and use the <b>“Edit zone DNS”</b> template.</li>
            <li>Under <b>Zone Resources</b> choose <b>{domain}</b>, then create the token and copy it.</li>
            <li>Paste it here. We use it once to add your records and don’t keep it. You can delete the token afterwards.</li>
          </ol>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Cloudflare API token" autoComplete="off" required aria-label="Cloudflare API token" />
          <p className="muted small">This replaces your domain’s current mail (MX), SPF and DMARC records so email goes to Roammail. Your website is not touched.</p>
          <div className="actions"><button className="btn primary" disabled={busy}>{busy ? 'Adding records…' : 'Add records'}</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}
