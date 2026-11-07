import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { DomainWizard, DomainStatus, Copy, setSuper } from './DomainSetup.jsx';
import { avatarColor, initials, fmtDate } from '../../util.js';
import OrgSignature from './Signature.jsx';
import SpamAdmin from './SpamAdmin.jsx';

const genPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = crypto.getRandomValues(new Uint32Array(14));
  let p = [...a].map((n) => chars[n % chars.length]).join('');
  return `${p.slice(0, 5)}-${p.slice(5, 10)}-${p.slice(10)}${a[0] % 10}`;
};

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose}><Icon name="close" /></button></div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ users
function Users({ org, domains }) {
  const toast = useToast();
  const active = domains.filter((d) => d.status === 'active');
  const [domain, setDomain] = useState(active[0]?.domain || '');
  const [users, setUsers] = useState(null);
  const [adding, setAdding] = useState(false);
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
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add user</button>
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
            <span>{u.active ? <span className="pill ok">Active</span> : <span className="pill bad">Suspended</span>}</span>
            <span className="muted small">{u.lastLogin ? fmtDate(new Date(u.lastLogin).toISOString()) : 'Never'}</span>
            <span className="actions">
              <button className="btn sm" onClick={() => setEdit(u)}>Edit</button>
              <button className="btn sm" onClick={() => { const p = genPassword(); if (confirm(`Reset password for ${u.email}?`)) update(u.email, { password: p }, 'Password reset').then(() => setCreated({ email: u.email, password: p, reset: true })); }}>
                <Icon name="key" size={14} /> Reset</button>
              <button className="icon-btn" title="Delete user" onClick={() => del(u)}><Icon name="trash" size={16} /></button>
            </span>
          </div>
        ))}
      </div>
      {adding && <AddUser domain={domain} onClose={() => setAdding(false)} onCreated={(c) => { setAdding(false); setCreated(c); load(); }} />}
      {edit && <EditUser u={edit} onClose={() => setEdit(null)} onSave={async (patch) => { await update(edit.email, patch, 'User updated'); setEdit(null); }} />}
      {created && (
        <Modal title={created.reset ? 'New password' : 'User created'} onClose={() => setCreated(null)}>
          <p>Share these sign-in details with the user. They won't be shown again.</p>
          <div className="creds">
            <div><span>Email</span><b className="mono">{created.email}</b><Copy text={created.email} /></div>
            <div><span>Password</span><b className="mono">{created.password}</b><Copy text={created.password} /></div>
            <div><span>Sign in at</span><b className="mono">{location.origin}</b><Copy text={location.origin} /></div>
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
  return <div className="new-sig"><small className="muted">Their company signature is ready:</small><div className="sig-preview" dangerouslySetInnerHTML={{ __html: html }} /></div>;
}

function ProfileFields({ f, setF }) {
  return (
    <div className="two-col">
      <label>Job title<input value={f.title || ''} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Sales Manager" /></label>
      <label>Department<input value={f.department || ''} onChange={(e) => setF({ ...f, department: e.target.value })} placeholder="Sales" /></label>
      <label>Phone<input value={f.phone || ''} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label>Mobile<input value={f.mobile || ''} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></label>
    </div>
  );
}

function AddUser({ domain, onClose, onCreated }) {
  const [f, setF] = useState({ name: '', localPart: '', password: genPassword(), quotaMb: 5120, admin: false, title: '', department: '', phone: '', mobile: '', welcome: true });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api.post('/api/admin/users', { ...f, domain }); onCreated({ email: r.email, password: f.password, setup: r.setup }); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add a user" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Full name<input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, localPart: f.localPart || '' })}
          onBlur={() => !f.localPart && f.name && setF((x) => ({ ...x, localPart: x.name.toLowerCase().trim().split(/\s+/)[0].replace(/[^a-z0-9._-]/g, '') }))} /></label>
        <label>Email address<div className="addr-input"><input required value={f.localPart} onChange={(e) => setF({ ...f, localPart: e.target.value.toLowerCase() })} /><span>@{domain}</span></div></label>
        <ProfileFields f={f} setF={setF} />
        <label>Temporary password<div className="addr-input"><input required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="mono" />
          <button type="button" className="btn sm" onClick={() => setF({ ...f, password: genPassword() })}>Generate</button></div></label>
        <label>Mailbox size<select value={f.quotaMb} onChange={(e) => setF({ ...f, quotaMb: Number(e.target.value) })}>
          {[1024, 2048, 5120, 10240, 20480].map((m) => <option key={m} value={m}>{m / 1024} GB</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={f.admin} onChange={(e) => setF({ ...f, admin: e.target.checked })} /> Make this person an admin (can manage users &amp; domains)</label>
        <label className="check"><input type="checkbox" checked={f.welcome} onChange={(e) => setF({ ...f, welcome: e.target.checked })} /> Put a welcome &amp; getting-started email in their inbox</label>
        {err && <div className="form-error">{err}</div>}
        <div className="step-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button></div>
      </form>
    </Modal>
  );
}

function EditUser({ u, onClose, onSave }) {
  const [f, setF] = useState({ name: u.name, quotaMb: u.quotaMb, active: u.active, admin: u.admin, title: u.title, department: u.department, phone: u.phone, mobile: u.mobile });
  return (
    <Modal title={`Edit ${u.email}`} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
        <label>Full name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <ProfileFields f={f} setF={setF} />
        <label>Mailbox size<select value={f.quotaMb} onChange={(e) => setF({ ...f, quotaMb: Number(e.target.value) })}>
          {[...new Set([1024, 2048, 5120, 10240, 20480, u.quotaMb])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{(m / 1024).toFixed(m % 1024 ? 1 : 0)} GB</option>)}</select></label>
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
      <div className="card">
        <h3>Platform settings</h3>
        <label className="check"><input type="checkbox" checked={d.settings.signupEnabled} onChange={async (e) => { await api.patch('/api/super/settings', { signupEnabled: e.target.checked }); load(); }} />
          Allow anyone to create a free account {d.settings.signupDomain ? <>on <b>@{d.settings.signupDomain}</b></> : <span className="bad"> (SIGNUP_DOMAIN not configured)</span>}</label>
        <p className="muted small">Mail server: <b>{d.settings.mailHostname}</b> · Route 53 auto-DNS: <b>{d.settings.route53 ? 'on' : 'off'}</b></p>
      </div>
      <h3>Businesses</h3>
      <div className="table">
        <div className="tr th"><span>Business</span><span>Domains</span><span>User limit</span><span>Status</span><span /></div>
        {orgs.map((o) => (
          <div className="tr" key={o.id}>
            <span><b>{o.name}</b><small className="muted"> {o.owner_email}</small></span>
            <span className="small">{o.domains.map((x) => `${x.domain}${x.status === 'pending' ? ' (pending)' : ''}`).join(', ') || '—'}</span>
            <span><input type="number" min="1" defaultValue={o.max_mailboxes} className="num" onBlur={(e) => Number(e.target.value) !== o.max_mailboxes && patchOrg(o, { maxMailboxes: Number(e.target.value) })} /></span>
            <span>{o.suspended ? <span className="pill bad">Suspended</span> : <span className="pill ok">Active</span>}</span>
            <span className="actions"><button className="btn sm" onClick={() => confirm(`${o.suspended ? 'Reactivate' : 'Suspend'} ${o.name}?`) && patchOrg(o, { suspended: !o.suspended })}>{o.suspended ? 'Reactivate' : 'Suspend'}</button></span>
          </div>
        ))}
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
  useEffect(() => { load(); }, []);

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
    ...(org ? [['users', 'Users', 'users'], ['signature', 'Signature', 'pen'], ['spam', 'Spam filter', 'junk'], ['aliases', 'Aliases', 'mail'], ['domains', 'Domains', 'globe'], ['activity', 'Activity', 'refresh']] : []),
    ...(me.superAdmin ? [['platform', 'Platform (super-admin)', 'shield'], ['new', 'New business', 'plus']] : []),
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
        <h1>{current === 'platform' ? 'Platform' : current === 'new' ? 'Add a business' : org?.name} <small className="muted">{tabs.find((t) => t[0] === current)?.[1]}</small></h1>
        {current === 'users' && org && <Users key={org.id} org={org} domains={org.domains} />}
        {current === 'signature' && org && <SignatureTab key={org.id} org={org} />}
        {current === 'spam' && org && <SpamAdmin key={org.id} org={org} />}
        {current === 'aliases' && org && <Aliases key={org.id} domains={org.domains} />}
        {current === 'domains' && org && <Domains key={org.id} org={org} reload={load} refreshMe={refreshMe} goUsers={() => setTab('users')} />}
        {current === 'activity' && org && <Activity org={org} />}
        {current === 'platform' && <Platform />}
        {current === 'new' && <DomainWizard refreshMe={refreshMe} onCreated={load} onDone={() => { load(); setTab('domains'); }} />}
      </section>
    </div>
  );
}
