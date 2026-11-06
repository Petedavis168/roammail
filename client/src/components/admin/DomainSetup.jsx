import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';

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
        <div><h3>{s.ready ? `${s.domain} is ready for email` : `Point ${s.domain}'s email to us`}</h3>
          <p className="muted">{s.ready ? 'All required records are in place. Mail to your domain now arrives here.' : `Add these records at your DNS provider. ${done} of ${required.length} required records found. We check automatically.`}</p></div></div>
      <div className="progress"><div style={{ width: `${(done / required.length) * 100}%` }} /></div>
      {s.route53 && !s.ready && (
        <div className="callout good"><Icon name="check" /> <div><b>This domain is in your AWS account.</b></div>
          <button className="btn primary" disabled={!!busy} onClick={autoDns}>{busy === 'r53' ? 'Setting up…' : 'Add records automatically'}</button></div>
      )}
      <RecordTable records={s.records} />
      <p className="muted small">If you already use another email provider on this domain, changing the MX record moves email delivery here. Only one provider can receive mail at a time.</p>
      {msg && <div className="form-error">{msg}</div>}
      <div className="step-actions">
        <button className="btn" onClick={load}><Icon name="refresh" size={16} /> Check again</button>
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
  const [form, setForm] = useState({ orgName: '', domain: '' });
  const [created, setCreated] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api.post('/api/domains', { ...form, orgId });
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
            {err && <div className="form-error">{err}</div>}
            <button className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Continue'}</button>
          </form>
        )}
      </div>
      {created && <DomainStatus domain={created} onActivated={refreshMe} onDone={() => onDone?.(created)} />}
    </div>
  );
}
