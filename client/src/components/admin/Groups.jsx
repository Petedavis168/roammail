import { useEffect, useState } from 'react';
import { useDialog } from '../../a11y.js';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import RecipientInput from '../RecipientInput.jsx';

function GroupEditor({ org, data, group, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !group;
  const [f, setF] = useState(() => ({
    name: group?.name || '', localPart: group?.address?.split('@')[0] || '', domain: group?.address?.split('@')[1] || data.domains[0],
    description: group?.description || '', kind: group?.kind || 'static', department: group?.department || data.departments[0] || '',
    members: (group?.kind === 'static' ? group.members : []).map((a) => ({ address: a, name: data.people.find((p) => p.email === a)?.name || '' })),
    internal: group ? group.internal : true, sendAs: group ? group.sendAs : true,
  }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    const body = { ...f, members: f.members.map((m) => m.address) };
    try {
      if (isNew) await api.post(`/api/admin/orgs/${org.id}/groups`, body); else await api.put(`/api/admin/orgs/${org.id}/groups/${group.id}`, body);
      toast(isNew ? `Group ${f.localPart}@${f.domain} created` : 'Group saved'); onSaved();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  };
  const inDept = data.people.filter((p) => p.department.toLowerCase() === f.department.toLowerCase());
  const dlg = useDialog(onClose);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <form ref={dlg} data-dialog tabIndex={-1} role="dialog" aria-modal="true" className="modal group-editor" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="modal-head"><h2>{isNew ? 'New group' : `Edit ${group.address}`}</h2><button type="button" className="icon-btn" onClick={onClose}><Icon name="close" /></button></div>
        <div className="form">
          <label>Group name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, localPart: isNew && (!f.localPart || f.localPart === slug(f.name)) ? slug(e.target.value) : f.localPart })} placeholder="Sales team" autoFocus required /></label>
          {isNew && (
            <label>Group email address
              <div className="addr-input"><input value={f.localPart} onChange={(e) => setF({ ...f, localPart: e.target.value.toLowerCase() })} placeholder="sales" required />
                {data.domains.length > 1 ? <select value={f.domain} onChange={set('domain')}>{data.domains.map((d) => <option key={d} value={d}>@{d}</option>)}</select> : <span>@{f.domain}</span>}</div>
              <small className="muted">One address. Everyone in the group gets mail sent to it. Groups don't use up mailboxes, so you can have as many as you like.</small>
            </label>
          )}
          <b className="small">Who's in this group?</b>
          <div className="preset-row">
            {[['static', 'People I choose', 'Pick coworkers (and outside people if allowed).'], ['department', 'A department', 'Automatically everyone in it, including new hires.'], ['everyone', 'Everyone', `Every person at ${org.name}, kept up to date.`]].map(([v, l, d]) => (
              <label key={v} className={`radio-card ${f.kind === v ? 'on' : ''}`}><input type="radio" checked={f.kind === v} onChange={() => setF({ ...f, kind: v })} /><div><b>{l}</b><small className="muted">{d}</small></div></label>
            ))}
          </div>
          {f.kind === 'static' && (
            <>
              <div className="ev-people"><RecipientInput label="Members" value={f.members} onChange={(v) => setF({ ...f, members: v })} /></div>
              <div className="chips-wrap">{data.people.filter((p) => !f.members.some((m) => m.address === p.email)).slice(0, 30).map((p) => (
                <button type="button" key={p.email} className="chip" onClick={() => setF({ ...f, members: [...f.members, { address: p.email, name: p.name }] })}>+ {p.name || p.email}</button>
              ))}</div>
            </>
          )}
          {f.kind === 'department' && (
            <label>Department
              <input list="dept-list" value={f.department} onChange={set('department')} placeholder="Sales" required />
              <datalist id="dept-list">{data.departments.map((d) => <option key={d} value={d} />)}</datalist>
              <small className="muted">{inDept.length ? `${inDept.length} people right now: ${inDept.slice(0, 5).map((p) => p.name || p.email).join(', ')}${inDept.length > 5 ? '…' : ''}` : 'Nobody is in this department yet. Set people\'s department in Admin → Users → Edit.'}</small>
            </label>
          )}
          <label>Description (optional)<input value={f.description} onChange={set('description')} placeholder="Questions from customers about orders" /></label>
          <b className="small">Options</b>
          <label className="check"><input type="checkbox" checked={f.internal} onChange={set('internal')} /> Only people at {org.name} can email this group <small className="muted">(recommended: stops spam to your lists)</small></label>
          <label className="check"><input type="checkbox" checked={f.sendAs} onChange={set('sendAs')} /> Members can send email as {f.localPart || 'the group'}@{f.domain}</label>
        </div>
        <div className="step-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Create group' : 'Save'}</button></div>
      </form>
    </div>
  );
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export default function Groups({ org }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [dept, setDept] = useState('');
  const load = () => api.get(`/api/admin/orgs/${org.id}/groups`).then(setData).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, [org.id]);
  if (!data) return <div className="spinner" />;
  if (!data.domains.length) return <div className="empty-card"><p>Finish setting up a domain first.</p></div>;
  const del = async (g) => {
    if (!confirm(`Delete the group ${g.address}? Mail sent to it will bounce.`)) return;
    try { await api.del(`/api/admin/orgs/${org.id}/groups/${g.id}`); toast('Group deleted'); load(); } catch (e) { toast(e.message, { error: true }); }
  };
  const kindLabel = (g) => (g.kind === 'everyone' ? 'Everyone' : g.kind === 'department' ? `Department: ${g.department}` : 'Chosen people');
  return (
    <div className="org-sig-admin">
      <div className="admin-toolbar">
        <p className="muted" style={{ margin: 0, flex: 1 }}>Groups are shared addresses like <b>sales@</b> or <b>support@</b>. Mail to a group goes to every member, and members can reply as the group. Unlimited and free: they don't use mailboxes.</p>
        <button className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New group</button>
      </div>
      <div className="table">
        <div className="tr th groups-row"><span>Group</span><span>Members</span><span>Who can email</span><span /></div>
        {data.groups.length === 0 && <div className="list-msg muted">No groups yet. Try one for each team, like sales@ or support@.</div>}
        {data.groups.map((g) => (
          <div className="tr groups-row" key={g.id}>
            <span className="user-cell"><span className="avatar" style={{ background: '#244960' }}><Icon name="users" size={16} /></span>
              <span><b>{g.name}</b><small>{g.address}{g.sendAs ? ' · members can send as' : ''}</small></span></span>
            <span className="small">{kindLabel(g)} · {g.members.length} {g.members.length === 1 ? 'person' : 'people'}</span>
            <span>{g.internal ? <span className="pill ok">Company only</span> : <span className="pill warn">Anyone</span>}</span>
            <span className="actions"><button className="btn sm" onClick={() => setEditing(g)}>Edit</button><button className="icon-btn" onClick={() => del(g)}><Icon name="trash" size={16} /></button></span>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Departments</h3>
        <p className="muted small">Put people in departments (Admin → Users → Edit), then make a group for a whole department. It updates itself as people join or leave.</p>
        <div className="chips-wrap">{data.departments.map((d) => <span key={d} className="rchip locked">{d} · {data.people.filter((p) => p.department.toLowerCase() === d.toLowerCase()).length}</span>)}{!data.departments.length && <span className="muted small">No departments yet.</span>}</div>
        <form className="pick-time" onSubmit={async (e) => { e.preventDefault(); try { await api.post(`/api/admin/orgs/${org.id}/departments`, { name: dept }); setDept(''); load(); } catch (err) { toast(err.message, { error: true }); } }}>
          <input placeholder="New department, e.g. Sales" value={dept} onChange={(e) => setDept(e.target.value)} /><button className="btn">Add</button>
        </form>
      </div>
      {editing && <GroupEditor org={org} data={data} group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}
