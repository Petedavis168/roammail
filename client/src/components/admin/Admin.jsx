import { safeHtml } from '../../safehtml.js';
import { useDialog } from '../../a11y.js';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { DomainWizard, DomainStatus, Copy, setSuper } from './DomainSetup.jsx';
import { avatarColor, initials, fmtDate } from '../../util.js';
import { loginHref } from '../../nav.js';
import OrgSignature from './Signature.jsx';
import SpamAdmin from './SpamAdmin.jsx';
import Groups from './Groups.jsx';
import Billing, { PlanPicker } from './Billing.jsx';
import TwoFactorSetup from '../TwoFactorSetup.jsx';
import Support from './Support.jsx';
import Abuse from './Abuse.jsx';
import Deliverability from './Deliverability.jsx';
import SharedMailboxes from './SharedMailboxes.jsx';
import Archive from './Archive.jsx';
import { TemplatesEditor } from '../settings/Templates.jsx';
import CompanyFooter from './CompanyFooter.jsx';

import { tempPassword as genPassword } from '../../temppass.js'; // two words + 4 digits, no look-alike characters (4a)

function Modal({ title, onClose, children }) {
  const dlg = useDialog(onClose);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div ref={dlg} data-dialog tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button></div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ users
// Mailbox size choices from the server's configured default and maximum (FREE/BUSINESS_MAILBOX_QUOTA_GB)
let quotaCfg = null;
const loadQuota = () => (quotaCfg ||= api.signupConfig().then((c) => c.quota || { business: 10240, businessMax: 10240 }).catch(() => ({ business: 10240, businessMax: 10240 })));
const sizeOptions = (q, current) => [...new Set([1024, 2048, 5120, 10240, 20480, 51200, 102400].filter((m) => m <= q.businessMax).concat([q.business, current].filter(Boolean)))].sort((a, b) => a - b);
function useQuota() { const [q, setQ] = useState({ business: 10240, businessMax: 10240 }); useEffect(() => { loadQuota().then(setQ); }, []); return q; }

// Item 6: copy many people's old mailboxes at once (one row per person; app passwords from their old provider)
// Staff-only addresses: a bare first name on the free domain (e.g. pete@roammail.net). Customers can't take these.
function StaffAddresses({ domain }) {
  const [f, setF] = useState({ localPart: '', name: '' });
  const [older, setOlder] = useState(null);
  useEffect(() => { api.get('/api/super/first-name-accounts').then(setOlder).catch(() => setOlder([])); }, []);
  const [made, setMade] = useState(null);
  const [err, setErr] = useState('');
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Staff addresses</h3>
      <p className="muted small">Addresses that are only a first name (like <b>pete@{domain}</b>) are kept for Roammail staff so nobody can pose as us. Create them here; the person sets their own password at first sign-in.</p>
      <form className="pick-time" onSubmit={async (e) => {
        e.preventDefault(); setErr(''); setMade(null);
        try { setMade(await api.post('/api/super/staff-mailboxes', f)); setF({ localPart: '', name: '' }); } catch (x) { setErr(x.message); }
      }}>
        <input placeholder="first name (address)" value={f.localPart} onChange={(e) => setF({ ...f, localPart: e.target.value })} required />
        <input placeholder="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <button className="btn primary">Create</button>
      </form>
      {err && <div className="form-error">{err}</div>}
      {made && <div className="callout ok"><small>Created <b>{made.email}</b>. Temporary password: <code>{made.password}</code> (shown once; they must change it at first sign-in).</small></div>}
      {older?.length > 0 && (
        <>
          <p className="small" style={{ marginTop: 12 }}><b>{older.length}</b> customer account{older.length === 1 ? '' : 's'} took a first-name address before this rule. Review them in Abuse if any look like impersonation:</p>
          <p className="small mono">{older.map((o) => o.email).join(', ')}</p>
        </>
      )}
    </div>
  );
}

// Daily sending report (plan 5h): what goes out by email each morning, on demand
function ReputationCard() {
  const [r, setR] = useState(null); const [busy, setBusy] = useState(false);
  const load = (send) => { setBusy(true); api.get('/api/super/reputation', send ? { send: 1 } : {}).then(setR).catch((e) => alert(e.message)).finally(() => setBusy(false)); };
  const color = { advance: 'ok', hold: 'warn', 'roll back': 'bad' };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Sending report</h3>
      <p className="muted small">Emailed to super-admins and abuse@ every morning. Delivery, bounces, pauses, complaints and blocklists for the last 24 hours, with a warm-up recommendation.</p>
      {r && (
        <div className="small">
          <p><span className={`pill ${color[r.advice]}`}>{r.advice}</span> {r.why.join('; ')}</p>
          <p>Delivered {r.delivery ? r.delivery.sent : 'n/a'} · bounced {r.delivery ? `${r.delivery.bounced} (${(r.bounceRate * 100).toFixed(1)}%)` : 'n/a'} · paused {r.holds.length} · complaints {r.complaints} · listings {r.listed} · new sign-ups {r.signups}</p>
        </div>
      )}
      <div className="actions"><button className="btn sm" disabled={busy} onClick={() => load(false)}>{r ? 'Refresh' : 'Show now'}</button><button className="btn sm" disabled={busy} onClick={() => load(true)}>Email it now</button></div>
    </div>
  );
}

// Item 2: complimentary plan (fee waiver) for a business: forever, until a date, or N months. Super-admins only.
function CompControl({ o, onChange }) {
  const COMP_FOREVER = 32503680000000;
  const until = Number(o.comp_until || 0);
  const active = until > Date.now();
  const set = async (mode) => {
    let body = { mode };
    if (mode === 'until') { const d = prompt('Complimentary until (YYYY-MM-DD)'); if (!d) return; body.until = d; }
    if (mode === 'months') { const n = prompt('How many months?', '12'); if (!n) return; body.months = Number(n); }
    if (mode !== 'off') { const note = prompt('Note for the audit log (why is this complimentary?)', o.comp_note || ''); if (!note) return; body.note = note; }
    else if (!confirm(`End the complimentary plan for ${o.name}? Admins get the normal 7-day grace before unpaid mailboxes pause.`)) return;
    try { await api.put(`/api/super/orgs/${o.id}/comp`, body); onChange(); } catch (e) { alert(e.message); }
  };
  return (
    <span className="comp">
      {active && <span className="pill ok" title={o.comp_note || ''}>Complimentary {until >= COMP_FOREVER ? '(forever)' : `until ${new Date(until).toLocaleDateString()}`}</span>}
      <select value="" onChange={(e) => e.target.value && set(e.target.value)} aria-label="Complimentary plan">
        <option value="">{active ? 'Change comp…' : 'Comp…'}</option>
        <option value="forever">Forever</option><option value="months">For N months</option><option value="until">Until a date</option>
        {active && <option value="off">End comp</option>}
      </select>
    </span>
  );
}

function ImportMailBulk({ domain, onClose }) {
  const toast = useToast();
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const template = () => {
    const blob = new Blob([`Mailbox,Provider,Old email,App password,IMAP server\r\njane@${domain},gmail,jane.smith@gmail.com,abcd efgh ijkl mnop,\r\nbob@${domain},other,bob@oldhost.com,secret,imap.oldhost.com\r\n`], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'roammail-mail-import-template.csv'; a.click();
  };
  const run = async (file) => {
    setBusy(true);
    try { setResults(await api.post('/api/admin/imports/bulk', { csv: await file.text() })); } catch (e) { toast(e.message, { error: true }); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Import old mail for @${domain}`} onClose={onClose}>
      {!results ? (
        <>
          <p className="small">One row per person: <b>Mailbox</b> (their new address here), <b>Provider</b> (gmail, yahoo, aol, icloud or other), <b>Old email</b>, <b>App password</b>, and <b>IMAP server</b> for "other".
            Each login is tested first; mail keeps syncing for 7 days. Delete the file afterwards: it contains passwords. <button className="link" onClick={template}>Download a template</button></p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files[0] && run(e.target.files[0])} />
          {busy && <div className="spinner" />}
        </>
      ) : (
        <>
          <p><b>{results.started}</b> of {results.results.length} imports started.</p>
          {results.results.filter((r) => !r.ok).map((r, i) => <div key={i} className="bad small">{r.mailbox}: {r.error}</div>)}
          <div className="actions"><button className="btn" onClick={onClose}>Done</button></div>
        </>
      )}
    </Modal>
  );
}

function ImportUsers({ domain, onClose }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState(null);
  const [results, setResults] = useState(null);
  const [welcome, setWelcome] = useState(true);
  const [busy, setBusy] = useState(false);
  const read = (file) => { const r = new FileReader(); r.onload = async () => { setCsv(String(r.result)); await check(String(r.result)); }; r.readAsText(file); };
  const check = async (text) => {
    setBusy(true);
    try { setPreview((await api.post('/api/admin/users/import', { domain, csv: text, dryRun: true })).preview); } catch (e) { toast(e.message, { error: true }); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true);
    try { setResults((await api.post('/api/admin/users/import', { domain, csv, welcome, confirmSeats: true })).results); } catch (e) { toast(e.message, { error: true }); } finally { setBusy(false); }
  };
  const download = () => {
    const rows = [['Name', 'Email', 'Temporary password'], ...results.filter((r) => r.ok).map((r) => [r.name, r.email, r.password])];
    const blob = new Blob([rows.map((r) => r.map((x) => `"${String(x || '').replace(/"/g, '""')}"`).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `new-users-${domain}.csv`; a.click();
  };
  const template = () => {
    const blob = new Blob(['Name,Email,Job title,Department,Phone,Mobile,Admin\r\nJane Smith,jane,Office manager,Operations,,,yes\r\n'], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'roammail-users-template.csv'; a.click();
  };
  return (
    <Modal title={`Import people to @${domain}`} onClose={onClose}>
      {!results && (
        <>
          <p className="small">Upload a spreadsheet saved as <b>CSV</b>, one person per row. Columns: <b>Name, Email</b> (or just the part before the @), and optionally Job title, Department, Phone, Mobile, Admin (yes/no), Password.
            Leave Password out and we'll make a strong one for each person. <button className="link" onClick={template}>Download a template</button></p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files[0] && read(e.target.files[0])} />
          {busy && <div className="spinner" />}
          {preview && (
            <div className="card" style={{ marginTop: 12 }}>
              <p><b>{preview.valid}</b> of {preview.total} people are ready to add.</p>
              {preview.problems.length > 0 && <><p className="bad small">These rows will be skipped:</p><ul className="small">{preview.problems.map((p) => <li key={p.row}>Row {p.row}{p.email ? ` (${p.email})` : ''}: {p.error}</li>)}</ul></>}
              {preview.extraSeats > 0 && (preview.hasSubscription
                ? <p className="small">This adds <b>{preview.extraSeats}</b> paid user(s) at ${preview.perUser}/{preview.interval} each. You'll be charged the prorated amount today.</p>
                : <p className="bad small">Choose a plan in Admin → Billing before importing more than your free users.</p>)}
              <label className="check"><input type="checkbox" checked={welcome} onChange={(e) => setWelcome(e.target.checked)} /> Put a welcome email with setup steps in each new inbox</label>
              <div className="actions"><button className="btn primary" disabled={busy || !preview.valid || (preview.extraSeats > 0 && !preview.hasSubscription)} onClick={run}>Add {preview.valid} people</button></div>
            </div>
          )}
        </>
      )}
      {results && (
        <>
          <p><b>{results.filter((r) => r.ok).length}</b> people added.{results.some((r) => !r.ok) && ` ${results.filter((r) => !r.ok).length} failed.`}</p>
          <p className="small">Download their temporary passwords now: this is the only time they're shown. Share each one privately; people can change it in Settings → Security.</p>
          <div className="actions"><button className="btn primary" onClick={download}>Download passwords (CSV)</button><button className="btn" onClick={onClose}>Done</button></div>
          {results.filter((r) => !r.ok).map((r) => <div key={r.email} className="bad small">{r.email}: {r.error}</div>)}
        </>
      )}
    </Modal>
  );
}

// Sign in with Microsoft 365 or Google Workspace: the admin connects the company once, then each person links their account
const SSO_ADMIN_MSG = { connected: 'Connected. People can now link their work accounts in Settings → Security.', 'personal-account': 'That’s a personal account. Sign in with an admin account from your company’s Microsoft 365 or Google Workspace.', cancelled: 'Cancelled.', failed: 'Something went wrong. Please try again.', expired: 'That took too long. Please try again.' };
const SSO_NAMES = { microsoft: 'Microsoft 365', google: 'Google Workspace' };
function WorkSignInAdmin({ org }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const load = () => api.get(`/api/sso/org/${org.id}`).then(setS).catch(() => setS(null));
  useEffect(() => {
    load();
    const m = new URLSearchParams(location.search).get('sso');
    if (m && SSO_ADMIN_MSG[m]) { toast(SSO_ADMIN_MSG[m], { error: m !== 'connected' }); history.replaceState(null, '', location.pathname); }
  }, [org.id]);
  if (!s || (!s.available.microsoft && !s.available.google)) return null;
  const connect = async (provider) => { try { location.href = (await api.post(`/api/sso/org/${org.id}/connect`, { provider })).url; } catch (e) { toast(e.message, { error: true }); } };
  const disconnect = async () => {
    if (!confirm(`Turn off ${SSO_NAMES[s.provider]} sign-in for ${org.name}? Everyone's linked accounts are removed; they sign in with their password.`)) return;
    try { await api.del(`/api/sso/org/${org.id}`); toast('Turned off'); load(); } catch (e) { toast(e.message, { error: true }); }
  };
  return (
    <div className="card">
      <h3>Sign in with Microsoft or Google</h3>
      {s.provider ? (
        <>
          <p><Icon name="check" size={14} /> Connected to your company's <b>{SSO_NAMES[s.provider]}</b> ({s.tenant}). {s.linked} {s.linked === 1 ? 'person has' : 'people have'} linked their account.</p>
          <small className="muted">Each person links their work account once in Settings → Security, then signs in with one click. Only accounts from your company can be used, and your company's own sign-in rules apply. Removing someone in {SSO_NAMES[s.provider]} stops them signing in here.</small>
          <div className="btn-row"><button className="btn" onClick={disconnect}>Turn off</button></div>
        </>
      ) : (
        <>
          <small className="muted">Let people sign in with their Microsoft 365 or Google Workspace work account. Sign in with an admin account from your company to connect it.</small>
          <div className="btn-row">
            {s.available.microsoft && <button className="btn" onClick={() => connect('microsoft')}>Connect Microsoft 365</button>}
            {s.available.google && <button className="btn" onClick={() => connect('google')}>Connect Google Workspace</button>}
          </div>
        </>
      )}
    </div>
  );
}

function Users({ org, domains }) {
  const toast = useToast();
  const active = domains.filter((d) => d.status === 'active');
  const [domain, setDomain] = useState(active[0]?.domain || '');
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingMail, setImportingMail] = useState(false);
  const [created, setCreated] = useState(null);
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState('');

  const load = () => domain && api.get('/api/admin/users', { domain }).then(setUsers).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { setUsers(null); load(); }, [domain]);

  if (!active.length) return <div className="empty-card"><Icon name="globe" size={40} /><p>Finish setting up a domain before adding users.</p></div>;

  const update = async (email, patch, okMsg) => {
    try { await api.patch('/api/admin/users', { email, ...patch }); toast(okMsg); load(); } catch (e) { toast(e.message, { error: true }); }
  };
  const del = async (u) => {
    if (prompt(`This permanently deletes ${u.email} and ALL of its email.\nType the address to confirm:`) !== u.email) return;
    try { await api.del('/api/admin/users', { email: u.email }); toast('User deleted'); load(); } catch (e) { toast(e.message, { error: true }); }
  };
  const list = (users || []).filter((u) => !q || u.email.includes(q.toLowerCase()) || u.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <div className="admin-toolbar">
        {active.length > 1 && <select value={domain} onChange={(e) => setDomain(e.target.value)}>{active.map((d) => <option key={d.domain}>{d.domain}</option>)}</select>}
        <input className="filter-input" placeholder="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <span className="muted small">{users?.length ?? '…'} of {org.max_mailboxes} users</span>
        <button className="btn" onClick={() => setImporting(true)}><Icon name="users" size={16} /> Import from spreadsheet</button>
        <button className="btn" onClick={() => setImportingMail(true)}><Icon name="import" size={16} /> Import old mail</button>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Invite people</button>
      </div>
      <div className="table">
        <div className="tr th"><span>User</span><span>Storage</span><span>Status</span><span>Last sign-in</span><span /></div>
        {!users && <div className="list-msg"><div className="spinner" /></div>}
        {users && !list.length && <div className="list-msg muted">No users yet. Add your first one.</div>}
        {list.map((u) => (
          <div className="tr" key={u.email}>
            <span className="user-cell">
              <span className="avatar" style={{ background: avatarColor(u.email) }}>{initials({ name: u.name, address: u.email })}</span>
              <span><span><b>{u.name || u.email.split('@')[0]}</b>{u.admin && <span className="badge">Admin</span>}</span><small>{u.email}{u.title ? ` · ${u.title}` : ''}</small></span>
            </span>
            <span><div className="meter"><div style={{ width: `${Math.min(100, (u.usedMb / Math.max(1, u.quotaMb)) * 100)}%` }} /></div>
              <small className="muted">{u.usedMb >= 1024 ? `${(u.usedMb / 1024).toFixed(1)} GB` : `${u.usedMb} MB`} of {u.quotaMb >= 1024 ? `${(u.quotaMb / 1024).toFixed(0)} GB` : `${u.quotaMb} MB`}</small></span>
            <span>{u.active ? <span className="pill ok">Active</span> : <span className="pill bad">Suspended</span>}
              <small className={u.twoFactor ? 'ok' : 'muted'} title="2-step verification">{u.twoFactor ? ' 🔒 2FA' : ' no 2FA'}</small></span>
            <span className="muted small">{u.lastLogin ? fmtDate(new Date(u.lastLogin).toISOString()) : 'Never'}</span>
            <span className="actions">
              <button className="btn sm" onClick={() => setEdit(u)}>Edit</button>
              <button className="btn sm" title="Email a new set-password link" onClick={async () => { const to = prompt(`Send ${u.email} a new invite link. Their current email:`); if (!to) return; try { await api.post('/api/admin/users/invite', { email: u.email, name: u.name, inviteEmail: to }); alert(`Invite sent to ${to}`); } catch (e) { alert(e.message); } }}>Resend invite</button>
              <button className="btn sm" title="Make a new temporary password and email it to their own (recovery) address" onClick={async () => {
                if (!confirm(`Send ${u.email} a temporary password? They'll be signed out everywhere and must choose a new password when they sign in.`)) return;
                try {
                  const r = await api.post('/api/admin/users/temp-password', { email: u.email });
                  if (r.sent) alert(`Temporary password sent to ${r.to}`);
                  else setCreated({ email: u.email, password: r.password, reset: true });
                } catch (e) { alert(e.message); }
              }}><Icon name="key" size={14} /> Send temporary password</button>
              {u.twoFactor && <button className="btn sm" title="Turn off 2-step verification (lost phone)" onClick={() => { if (confirm(`Turn off 2-step verification for ${u.email}? They'll be signed out and asked to set it up again.`)) update(u.email, { reset2fa: true }, '2-step verification reset'); }}>
                <Icon name="shield" size={14} /> Reset 2-step</button>}
              <button className="icon-btn" title="Delete user" onClick={() => del(u)}><Icon name="trash" size={16} /></button>
            </span>
          </div>
        ))}
      </div>
      <datalist id="org-departments">{[...new Set((users || []).map((u) => u.department).filter(Boolean))].map((d) => <option key={d} value={d} />)}</datalist>
      {importing && <ImportUsers domain={domain} onClose={() => { setImporting(false); load(); }} />}
      {importingMail && <ImportMailBulk domain={domain} onClose={() => setImportingMail(false)} />}
      {adding && <AddUser domain={domain} orgId={org.id} onClose={() => setAdding(false)} onCreated={(c) => { setAdding(false); setCreated(c); load(); }} />}
      {edit && <EditUser u={edit} onClose={() => setEdit(null)} onSave={async (patch) => { await update(edit.email, patch, 'User updated'); setEdit(null); }} />}
      {created && (
        created.invited ? (
        <Modal title="Invite sent" onClose={() => setCreated(null)}>
          <p><b>{created.email}</b> is ready. We emailed an invite to <b>{created.invited}</b> with a link to choose a password and open the inbox.</p>
          <p className="muted small">The link works once, for 7 days. Need to send it again? Use Resend invite next to their name.</p>
          <div className="step-actions"><button className="btn primary" onClick={() => setCreated(null)}>Done</button></div>
        </Modal>
        ) : (
        <Modal title={created.reset ? 'New password' : 'User created'} onClose={() => setCreated(null)}>
          <p>Share these sign-in details with the user. They won't be shown again.</p>
          <div className="creds">
            <div><span>Email</span><b className="mono">{created.email}</b><Copy text={created.email} /></div>
            <div><span>Password</span><b className="mono">{created.password}</b><Copy text={created.password} /></div>
            <div><span>Sign in at</span><b className="mono">{loginHref()}</b><Copy text={loginHref()} /></div>
          </div>
          {created.setup && (
            <div className="hire-qr">
              <img src={created.setup.qr} alt="Phone setup QR code" width="150" height="150" />
              <div><b>Set up their phone now</b><p className="muted small">Have them scan this with their phone camera. On iPhone it installs mail, calendar and contacts with no typing. Works once, for the next 2 hours.</p></div>
            </div>
          )}
          {!created.reset && <SigPreview orgId={org.id} email={created.email} />}
          <Copy text={`Your email is ready!\nSign in at: ${location.origin}\nEmail: ${created.email}\nPassword: ${created.password}\nSet up your phone: ${location.origin}/setup?email=${created.email}\nIt also works in Outlook, Apple Mail and other mail apps.`} />
          <span className="muted small"> ← copy everything as a message</span>
        </Modal>
        )
      )}
    </div>
  );
}

function SigPreview({ orgId, email }) {
  const [html, setHtml] = useState(null);
  useEffect(() => {
    api.get(`/api/admin/orgs/${orgId}/signature`).then((s) => (s.mode !== 'off' && s.html
      ? api.post(`/api/admin/orgs/${orgId}/signature/preview`, { html: s.html, email }).then((r) => setHtml(r.html)) : null)).catch(() => {});
  }, [orgId, email]);
  if (!html) return null;
  return <div className="new-sig"><small className="muted">Their company signature is ready:</small><div className="sig-preview" dangerouslySetInnerHTML={{ __html: safeHtml(html) }} /></div>;
}

function ProfileFields({ f, setF }) {
  return (
    <div className="two-col">
      <label>Job title<input value={f.title || ''} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Sales Manager" /></label>
      <label>Department<input list="org-departments" value={f.department || ''} onChange={(e) => setF({ ...f, department: e.target.value })} placeholder="Sales" /></label>
      <label>Phone<input value={f.phone || ''} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label>Mobile<input value={f.mobile || ''} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></label>
    </div>
  );
}

function AddUser({ domain, orgId, onClose, onCreated, invite = true }) {
  const [needPlan, setNeedPlan] = useState(false);
  const quota = useQuota();
  const [mode, setMode] = useState(invite ? 'invite' : 'password'); // invite = they choose their own password from an emailed link
  const [f, setF] = useState({ name: '', localPart: '', password: genPassword(), inviteEmail: '', quotaMb: 0, admin: false, title: '', department: '', phone: '', mobile: '', welcome: true });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    const body = mode === 'invite' ? { ...f, password: undefined, domain } : { ...f, inviteEmail: undefined, domain };
    const create = async () => { const r = await api.post('/api/admin/users', body); onCreated(mode === 'invite' ? { email: r.email, invited: r.invited } : { email: r.email, password: f.password, setup: r.setup }); };
    try { await create(); }
    catch (e2) {
      if (e2.status === 402 && e2.code === 'seat_required') {
        const cost = e2.message;
        if (confirm(`${cost}\n\nThis adds one user to your plan. You'll be charged the prorated amount for the rest of this billing period now, then the normal price each period. Continue?`)) {
          try { await api.post(`/api/billing/${orgId}/seats`); await create(); } catch (e3) { setErr(e3.message); }
        }
      } else if (e2.status === 402) setNeedPlan(true);
      else setErr(e2.message);
    } finally { setBusy(false); }
  };
  return (
    <Modal title="Add a user" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Full name<input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, localPart: f.localPart || '' })}
          onBlur={() => !f.localPart && f.name && setF((x) => ({ ...x, localPart: x.name.toLowerCase().trim().split(/\s+/)[0].replace(/[^a-z0-9._-]/g, '') }))} /></label>
        <label>Email address<div className="addr-input"><input required value={f.localPart} onChange={(e) => setF({ ...f, localPart: e.target.value.toLowerCase() })} /><span>@{domain}</span></div></label>
        <ProfileFields f={f} setF={setF} />
        <div className="seg" role="radiogroup" style={{ display: 'flex', gap: 6 }}>
          <button type="button" className={`btn sm ${mode === 'invite' ? 'primary' : ''}`} onClick={() => setMode('invite')}>Email them an invite</button>
          <button type="button" className={`btn sm ${mode === 'password' ? 'primary' : ''}`} onClick={() => setMode('password')}>Set a password myself</button>
        </div>
        {mode === 'invite'
          ? <label>Their current email (personal or work)<input type="email" required value={f.inviteEmail} onChange={(e) => setF({ ...f, inviteEmail: e.target.value })} placeholder="name@gmail.com" />
            <small className="muted">We email a link where they choose their own password. It works once, for 7 days. No password is ever emailed.</small></label>
          : <label>Temporary password<div className="addr-input"><input required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="mono" />
            <button type="button" className="btn sm" onClick={() => setF({ ...f, password: genPassword() })}>Generate</button></div></label>}
        <label>Mailbox size<select value={f.quotaMb || quota.business} onChange={(e) => setF({ ...f, quotaMb: Number(e.target.value) })}>
          {sizeOptions(quota).map((m) => <option key={m} value={m}>{(m / 1024).toFixed(m % 1024 ? 1 : 0)} GB{m === quota.business ? ' (standard)' : ''}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={f.admin} onChange={(e) => setF({ ...f, admin: e.target.checked })} /> Make this person an admin (can manage users &amp; domains)</label>
        <label className="check"><input type="checkbox" checked={f.welcome} onChange={(e) => setF({ ...f, welcome: e.target.checked })} /> Put a welcome &amp; getting-started email in their inbox</label>
        {err && <div className="form-error">{err}</div>}
        {needPlan ? <PlanPicker orgId={orgId} adding={1} title="Choose a plan to add this person" note="You've used your free mailbox. After payment, come back and click Create user again." onCancel={() => setNeedPlan(false)} />
          : <div className="step-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Creating…' : mode === 'invite' ? 'Create and send invite' : 'Create user'}</button></div>}
      </form>
    </Modal>
  );
}

function EditUser({ u, onClose, onSave }) {
  const quota = useQuota();
  const [f, setF] = useState({ name: u.name, quotaMb: u.quotaMb, active: u.active, admin: u.admin, title: u.title, department: u.department, phone: u.phone, mobile: u.mobile });
  return (
    <Modal title={`Edit ${u.email}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
        <label>Full name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <ProfileFields f={f} setF={setF} />
        <label>Mailbox size<select value={f.quotaMb} onChange={(e) => setF({ ...f, quotaMb: Number(e.target.value) })}>
          {sizeOptions(quota, u.quotaMb).map((m) => <option key={m} value={m}>{(m / 1024).toFixed(m % 1024 ? 1 : 0)} GB</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={f.admin} onChange={(e) => setF({ ...f, admin: e.target.checked })} /> Admin</label>
        <label className="check"><input type="checkbox" checked={!f.active} onChange={(e) => setF({ ...f, active: !e.target.checked })} /> Suspended (can't sign in or receive mail)</label>
        <div className="step-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

function SignatureTab({ org }) {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    Promise.all(org.domains.filter((d) => d.status === 'active').map((d) => api.get('/api/admin/users', { domain: d.domain }).catch(() => [])))
      .then((r) => setUsers(r.flat()));
  }, [org.id]);
  return <OrgSignature org={org} users={users} />;
}

function OrgSecurity({ org, reload }) {
  const toast = useToast();
  const [users, setUsers] = useState(null);
  useEffect(() => {
    Promise.all(org.domains.filter((d) => d.status === 'active').map((d) => api.get('/api/admin/users', { domain: d.domain }).catch(() => [])))
      .then((r) => setUsers(r.flat()));
  }, [org.id]);
  const set = async (patch, msg) => { try { await api.patch(`/api/admin/orgs/${org.id}`, patch); toast(msg); reload(); } catch (e) { toast(e.message, { error: true }); } };
  const without = (users || []).filter((u) => !u.twoFactor);
  return (
    <div className="org-sig-admin">
      <div className="card">
        <h3>2-step verification</h3>
        <p className="muted small">{users ? `${users.length - without.length} of ${users.length} people have it on.` : 'Loading…'}</p>
        <label className="check big"><input type="checkbox" checked={!!org.require_2fa} onChange={(e) => set({ require2fa: e.target.checked }, e.target.checked ? 'Everyone must now set up 2-step verification at their next action' : 'No longer required')} />
          Require 2-step verification for everyone in {org.name}</label>
        <small className="muted">People without it are guided through setup the next time they use the app. Strongly recommended: it stops almost all account takeovers.</small>
        {without.length > 0 && <div className="chips-wrap">{without.map((u) => <span key={u.email} className="rchip locked">{u.email}</span>)}</div>}
      </div>
      <div className="card">
        <h3>AI help</h3>
        <label className="check big"><input type="checkbox" checked={!org.ai_blocked} onChange={async (e) => { try { await api.put(`/api/ai/org/${org.id}`, { blocked: !e.target.checked }); toast(e.target.checked ? 'AI help allowed' : 'AI help turned off for everyone'); reload(); } catch (x) { toast(x.message, { error: true }); } }} />
          Allow people in {org.name} to use AI help</label>
        <small className="muted">AI help (thread summaries, suggested replies, "what needs my reply") is off until each person turns it on, and it sends only the emails they choose to Anthropic (Claude). Turn this off if your company doesn't allow AI tools.</small>
      </div>
      <WorkSignInAdmin org={org} />
      <div className="card">
        <h3>Automatic forwarding</h3>
        <label className="check big"><input type="checkbox" checked={!!org.allow_external_forward} onChange={(e) => set({ allowExternalForward: e.target.checked }, 'Saved')} />
          Allow people to auto-forward mail to addresses outside {org.name}</label>
        <small className="muted">Off by default. Attackers who break into an account often set up a silent forward to copy all future mail. Forwarding inside the company is always allowed.</small>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ aliases
function Aliases({ domains }) {
  const toast = useToast();
  const active = domains.filter((d) => d.status === 'active');
  const [domain, setDomain] = useState(active[0]?.domain || '');
  const [list, setList] = useState(null);
  const [f, setF] = useState({ local: '', goto: '' });
  const load = () => domain && api.get('/api/admin/aliases', { domain }).then(setList).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, [domain]);
  if (!active.length) return <div className="empty-card"><p>Finish setting up a domain first.</p></div>;

  const add = async (e) => {
    e.preventDefault();
    try { await api.post('/api/admin/aliases', { address: `${f.local.toLowerCase()}@${domain}`, goto: f.goto }); setF({ local: '', goto: '' }); toast('Alias created'); load(); }
    catch (e2) { toast(e2.message, { error: true }); }
  };
  return (
    <div>
      <p className="muted">Aliases are extra addresses (like <b>sales@</b> or <b>info@</b>) that forward to one or more people. No extra user needed.</p>
      <form className="admin-toolbar" onSubmit={add}>
        <div className="addr-input"><input required placeholder="sales" value={f.local} onChange={(e) => setF({ ...f, local: e.target.value })} /><span>@{domain}</span></div>
        <span>→</span>
        <input required className="grow" placeholder="anna@…, bob@… (comma separated)" value={f.goto} onChange={(e) => setF({ ...f, goto: e.target.value })} />
        {active.length > 1 && <select value={domain} onChange={(e) => setDomain(e.target.value)}>{active.map((d) => <option key={d.domain}>{d.domain}</option>)}</select>}
        <button className="btn primary"><Icon name="plus" size={16} /> Add alias</button>
      </form>
      <div className="table">
        <div className="tr th two"><span>Alias</span><span>Delivers to</span><span /></div>
        {list?.length === 0 && <div className="list-msg muted">No aliases yet.</div>}
        {list?.map((a) => (
          <div className="tr two" key={a.id}><span className="mono">{a.address}</span><span className="small">{String(a.goto).split(',').join(', ')}</span>
            <span className="actions"><button className="icon-btn" onClick={async () => { if (!confirm(`Delete ${a.address}?`)) return; await api.del('/api/admin/aliases', { domain, id: a.id }); load(); }}><Icon name="trash" size={16} /></button></span></div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ domains
function Domains({ org, reload, refreshMe, goUsers }) {
  const [open, setOpen] = useState(org.domains.find((d) => d.status === 'pending')?.domain || null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const remove = async (d) => {
    if (!confirm(`Remove ${d.domain}? ${d.status === 'active' ? 'All users and aliases on it must be deleted first.' : ''}`)) return;
    try { await api.del(`/api/domains/${encodeURIComponent(d.domain)}`); toast('Domain removed'); reload(); } catch (e) { toast(e.message, { error: true }); }
  };
  return (
    <div>
      <div className="admin-toolbar"><div className="spacer" /><button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add another domain</button></div>
      {adding && <DomainWizard orgId={org.id} refreshMe={async () => { await refreshMe(); reload(); }} onDone={() => { setAdding(false); reload(); goUsers(); }} />}
      {org.domains.map((d) => (
        <div key={d.domain} className="domain-card">
          <div className="domain-card-head" onClick={() => setOpen(open === d.domain ? null : d.domain)}>
            <Icon name="globe" /> <b>{d.domain}</b>
            {d.status === 'active' ? <span className="pill ok">Active</span> : <span className="pill warn">Needs verification</span>}
            <div className="spacer" />
            <button className="btn sm" onClick={(e) => { e.stopPropagation(); remove(d); }}>Remove</button>
            <Icon name={open === d.domain ? 'down' : 'chevron'} />
          </div>
          {open === d.domain && <DomainStatus domain={d.domain} onActivated={reload} />}
        </div>
      ))}
    </div>
  );
}

function Activity({ org }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get(`/api/admin/orgs/${org.id}/audit`).then(setRows).catch(() => setRows([])); }, [org.id]);
  const label = { 'user.create': 'created user', 'user.update': 'updated user', 'user.delete': 'deleted user', 'alias.create': 'created alias', 'alias.delete': 'deleted alias',
    'signature.update': 'updated the company signature', 'spam.apply_all': 'applied spam settings to everyone at', 'spam.domain_block': 'blocked company-wide', 'spam.domain_trust': 'trusted company-wide', 'domain.add': 'added domain', 'domain.activate': 'activated domain', 'domain.delete': 'removed domain', 'domain.route53': 'set up DNS for', 'org.create': 'created organization', 'org.update': 'renamed organization' };
  return (
    <div className="table">
      {rows?.length === 0 && <div className="list-msg muted">No activity yet.</div>}
      {rows?.map((r, i) => (
        <div className="tr two" key={i}><span><b>{r.actor}</b> {label[r.action] || r.action} <span className="mono">{r.detail.email || r.detail.domain || r.detail.address || r.detail.name || ''}</span>{r.detail.passwordReset ? ' (password reset)' : ''}</span>
          <span className="muted small">{fmtDate(r.at.replace(' ', 'T') + 'Z', true)}</span><span /></div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ super admin
function FriendlyCodes() {
  const toast = useToast();
  const [codes, setCodes] = useState([]);
  const [note, setNote] = useState('');
  const [fresh, setFresh] = useState(null);
  const load = () => api.get('/api/super/friendly-codes').then(setCodes).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <div className="card">
      <h3>Friendly Web Services customer codes</h3>
      <p className="muted small">Give a code to a Friendly Web Services customer. When they enter it during business setup, their first mailbox is free. Each code works once.</p>
      <form className="pick-time" onSubmit={async (e) => { e.preventDefault(); try { const r = await api.post('/api/super/friendly-codes', { note }); setFresh(r.code); setNote(''); load(); } catch (err) { toast(err.message, { error: true }); } }}>
        <input placeholder="Who is it for? (e.g. Acme Plumbing, invoice 1043)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn primary">Create code</button>
      </form>
      {fresh && <div className="callout good"><Icon name="check" /><div>New code: <b className="mono">{fresh}</b><br /><small>Copy it now. For security only a fingerprint is stored, so it can't be shown again.</small></div><Copy text={fresh} /></div>}
      <div className="table">
        {codes.map((c, i) => <div className="tr two" key={i}><span className="mono">…{c.hint} <small className="muted">{c.note}</small></span><span className="small">{c.used_at ? `Used by ${c.org || 'a business'}` : 'Not used yet'}</span><span /></div>)}
      </div>
    </div>
  );
}

function StatusNotice() {
  const toast = useToast();
  const [n, setN] = useState({ title: '', body: '' });
  const [live, setLive] = useState(null);
  useEffect(() => { fetch('/api/status').then((r) => r.json()).then((s) => { setLive(s); if (s.notice) setN({ title: s.notice.title, body: s.notice.body }); }).catch(() => {}); }, []);
  const save = async (v) => { try { await api.put('/api/super/status-notice', v); toast(v.title ? 'Notice posted on the status page' : 'Notice removed'); setN(v); } catch (e) { toast(e.message, { error: true }); } };
  return (
    <div className="card">
      <h3>Status page <a className="small" href="/status" target="_blank" rel="noreferrer">open</a></h3>
      {live && <p className="small">{live.components.map((c) => <span key={c.name} style={{ marginRight: 14 }}>{c.ok ? '🟢' : '🔴'} {c.name}</span>)}</p>}
      <div className="form">
        <input placeholder="Notice title (e.g. Planned maintenance Sunday 02:00 UTC)" value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} />
        <textarea rows={2} placeholder="Details customers will see" value={n.body} onChange={(e) => setN({ ...n, body: e.target.value })} />
        <div className="actions"><button className="btn primary" onClick={() => save(n)} disabled={!n.title}>Post notice</button><button className="btn" onClick={() => save({ title: '', body: '' })}>Clear</button></div>
      </div>
    </div>
  );
}

function Platform() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const load = () => { api.get('/api/super/overview').then(setD); api.get('/api/admin/orgs').then(setOrgs); };
  useEffect(load, []);
  if (!d) return <div className="list-msg"><div className="spinner" /></div>;
  const patchOrg = async (o, body) => { try { await api.patch(`/api/super/orgs/${o.id}`, body); toast('Saved'); load(); } catch (e) { toast(e.message, { error: true }); } };
  return (
    <div>
      <div className="stats">
        {[['Free accounts', d.counts.signups], ['New today', d.counts.signupsToday], ['Businesses', d.counts.orgs], ['Active domains', d.counts.domains], ['Pending domains', d.counts.pendingDomains]].map(([l, n]) => (
          <div className="stat" key={l}><b>{n}</b><span>{l}</span></div>
        ))}
      </div>
      <StatusNotice />
      <div className="card">
        <h3>Platform settings</h3>
        <label className="check"><input type="checkbox" checked={d.settings.signupEnabled} onChange={async (e) => { await api.patch('/api/super/settings', { signupEnabled: e.target.checked }); load(); }} />
          Allow anyone to create a free account {d.settings.signupDomain ? <>on <b>@{d.settings.signupDomain}</b></> : <span className="bad"> (SIGNUP_DOMAIN not configured)</span>}</label>
        <p className="muted small">Mail server: <b>{d.settings.mailHostname}</b> · Route 53 auto-DNS: <b>{d.settings.route53 ? 'on' : 'off'}</b></p>
      </div>
      <FriendlyCodes />
      <StaffAddresses domain={d.settings.signupDomain} />
      <ReputationCard />
      <h3>Businesses</h3>
      <div className="table">
        <div className="tr th"><span>Business</span><span>Domains</span><span>User limit</span><span>Status</span><span /></div>
        {orgs.map((o) => (
          <div className="tr" key={o.id}>
            <span><b>{o.name}</b><small className="muted"> {o.owner_email}</small></span>
            <span className="small">{o.domains.map((x) => `${x.domain}${x.status === 'pending' ? ' (pending)' : ''}`).join(', ') || '—'}</span>
            <span><input type="number" min="1" defaultValue={o.max_mailboxes} className="num" onBlur={(e) => Number(e.target.value) !== o.max_mailboxes && patchOrg(o, { maxMailboxes: Number(e.target.value) })} /></span>
            <span>{o.suspended ? <span className="pill bad">Suspended</span> : <span className="pill ok">Active</span>}
              <label className="check small"><input type="checkbox" checked={o.plan === 'friendly'} onChange={async (e) => { await api.patch(`/api/super/orgs/${o.id}/plan`, { plan: e.target.checked ? 'friendly' : 'standard' }); load(); }} /> Friendly</label>
              <small className="muted">{o.billing_status !== 'none' ? `billing: ${o.billing_status}` : ''}</small>
              <CompControl o={o} onChange={load} /></span>
            <span className="actions"><button className="btn sm" onClick={() => confirm(`${o.suspended ? 'Reactivate' : 'Suspend'} ${o.name}?`) && patchOrg(o, { suspended: !o.suspended })}>{o.suspended ? 'Reactivate' : 'Suspend'}</button></span>
          </div>
        ))}
      </div>
      <h3>Most active senders today (webmail)</h3>
      <div className="table">
        {(d.topSenders || []).length === 0 && <div className="list-msg muted">No mail sent today.</div>}
        {(d.topSenders || []).map((t) => <div className="tr two" key={t.email}><span className="mono">{t.email}</span><span>{t.count} messages</span><span /></div>)}
      </div>
      <h3>Recent free sign-ups</h3>
      <div className="table">
        {d.recentSignups.map((s) => (
          <div className="tr two" key={s.email}><span className="mono">{s.email}</span><span className="muted small">{fmtDate(s.created_at.replace(' ', 'T') + 'Z', true)} · {s.ip}</span>
            <span className="actions"><button className="btn sm" onClick={async () => { if (!confirm(`Suspend ${s.email}?`)) return; await api.post('/api/super/signups/suspend', { email: s.email, active: false }); toast('Suspended'); }}>Suspend</button></span></div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shell
export default function Admin({ me, refreshMe, onExit }) {
  const [orgs, setOrgs] = useState(null);
  const [orgId, setOrgId] = useState(null);
  const [tab, setTab] = useState('users');
  setSuper(!!me.superAdmin);

  const load = () => api.get('/api/admin/orgs').then((o) => { setOrgs(o); setOrgId((cur) => cur && o.some((x) => x.id === cur) ? cur : o[0]?.id ?? null); }).catch(() => setOrgs([]));
  useEffect(() => { if (me.twoFactor?.enabled) load(); }, [me.twoFactor?.enabled]);
  useEffect(() => { load(); }, []);

  const isAdminUser = me.superAdmin || me.orgs?.some((o) => o.role === 'admin');
  if (isAdminUser && me.adminRequires2fa && !me.twoFactor?.enabled) {
    return (
      <div className="admin"><div className="gate-card inline">
        <div className="gate-icon"><Icon name="shield" size={34} /></div>
        <h1>Protect your admin account first</h1>
        <p>Admins can create and delete users and read company settings, so the admin portal requires 2-step verification.</p>
        <TwoFactorSetup email={me.email} onDone={refreshMe} startLabel="Set up 2-step verification" />
        <button className="link" onClick={onExit}>Back to mail</button>
      </div></div>
    );
  }
  if (!orgs) return <div className="admin"><div className="list-msg"><div className="spinner" /></div></div>;

  const org = orgs.find((o) => o.id === orgId);
  if (!org && !me.superAdmin) {
    return (
      <div className="admin">
        <div className="admin-hero">
          <h1>Set up email for your business</h1>
          <p className="muted">Get professional addresses on your own domain for your whole team, managed from one place. Takes about 5 minutes.</p>
        </div>
        <DomainWizard refreshMe={async () => { await refreshMe(); }} onDone={() => { load(); setTab('users'); }} />
      </div>
    );
  }

  const tabs = [
    ...(org ? [['users', 'Users', 'users'], ['groups', 'Groups', 'users'], ['shared', 'Shared mailboxes', 'mail'], ['archive', 'Archive & legal hold', 'lock'], ['signature', 'Signature', 'pen'], ['templates', 'Templates', 'mail'], ['spam', 'Spam filter', 'junk'], ['orgsecurity', 'Security', 'lock'], ['billing', 'Billing', 'tag'], ['aliases', 'Aliases', 'mail'], ['domains', 'Domains', 'globe'], ['activity', 'Activity', 'refresh']] : []),
    ...(me.superAdmin ? [['platform', 'Platform (super-admin)', 'shield'], ['support', 'Support', 'users'], ['abuse', 'Abuse & sending', 'junk'], ['deliverability', 'Deliverability', 'send'], ['new', 'New business', 'plus']] : []),
  ];
  const current = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];

  return (
    <div className="admin">
      <aside className="admin-nav">
        {(orgs.length > 1 || me.superAdmin) && orgs.length > 0 && (
          <select value={orgId ?? ''} onChange={(e) => setOrgId(Number(e.target.value))} className="org-select">
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        {org && orgs.length <= 1 && !me.superAdmin && <div className="org-name">{org.name}</div>}
        {tabs.map(([k, l, i]) => <button key={k} className={current === k ? 'on' : ''} onClick={() => setTab(k)}><Icon name={i} /> {l}</button>)}
        <div className="spacer" />
        <button onClick={onExit}><Icon name="back" /> Back to mail</button>
      </aside>
      <section className="admin-main">
        <h1>{current === 'platform' ? 'Platform' : current === 'support' ? 'Support' : current === 'abuse' ? 'Abuse & sending' : current === 'deliverability' ? 'Deliverability' : current === 'new' ? 'Add a business' : org?.name} <small className="muted">{tabs.find((t) => t[0] === current)?.[1]}</small></h1>
        {current === 'users' && org && <Users key={org.id} org={org} domains={org.domains} />}
        {current === 'signature' && org && <><SignatureTab key={org.id} org={org} /><CompanyFooter key={`f${org.id}`} org={org} /></>}
        {current === 'orgsecurity' && org && <OrgSecurity key={org.id} org={org} reload={load} />}
        {current === 'billing' && org && <Billing key={org.id} org={org} />}
        {current === 'groups' && org && <Groups key={org.id} org={org} />}
        {current === 'shared' && org && <SharedMailboxes key={org.id} org={org} />}
        {current === 'archive' && org && <Archive key={org.id} org={org} />}
        {current === 'templates' && org && <TemplatesEditor key={org.id} intro="Company templates appear for everyone in your business when they click 📄 in a new message. Good for standard replies, quotes and onboarding emails."
          load={() => api.get(`/api/admin/orgs/${org.id}/templates`)} save={(templates) => api.put(`/api/admin/orgs/${org.id}/templates`, { templates })} />}
        {current === 'spam' && org && <SpamAdmin key={org.id} org={org} />}
        {current === 'aliases' && org && <Aliases key={org.id} domains={org.domains} />}
        {current === 'domains' && org && <Domains key={org.id} org={org} reload={load} refreshMe={refreshMe} goUsers={() => setTab('users')} />}
        {current === 'activity' && org && <Activity org={org} />}
        {current === 'platform' && <Platform />}
        {current === 'support' && <Support />}
        {current === 'abuse' && <Abuse />}
        {current === 'deliverability' && <Deliverability />}
        {current === 'new' && <DomainWizard refreshMe={refreshMe} onCreated={load} onDone={() => { load(); setTab('domains'); }} />}
      </section>
    </div>
  );
}
