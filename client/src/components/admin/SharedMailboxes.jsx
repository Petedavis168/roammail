import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';

// Shared mailboxes: one address (support@, info@, sales@) a team reads and answers from together. Free: no paid seat.
export default function SharedMailboxes({ org }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [people, setPeople] = useState([]);
  const [edit, setEdit] = useState(null); // { email?, localPart, domain, name, members: [{email, canSend}] }
  const domains = (org.domains || []).filter((x) => x.status === 'active').map((x) => x.domain);
  const load = () => api.get(`/api/admin/orgs/${org.id}/shared-mailboxes`).then(setD).catch((e) => toast(e.message, { error: true }));
  useEffect(() => {
    load();
    Promise.all(domains.map((dom) => api.get('/api/admin/users', { domain: dom }).catch(() => []))).then((l) => setPeople(l.flat().map((u) => ({ email: u.email, name: u.name }))));
  }, [org.id]);
  if (!d) return <div className="spinner" />;
  const toggle = (email) => setEdit((e) => ({ ...e, members: e.members.some((m) => m.email === email) ? e.members.filter((m) => m.email !== email) : [...e.members, { email, canSend: true }] }));
  const setSend = (email, canSend) => setEdit((e) => ({ ...e, members: e.members.map((m) => (m.email === email ? { ...m, canSend } : m)) }));
  const save = async () => {
    try {
      if (edit.email) await api.put(`/api/admin/orgs/${org.id}/shared-mailboxes/${encodeURIComponent(edit.email)}`, { name: edit.name, members: edit.members });
      else await api.post(`/api/admin/orgs/${org.id}/shared-mailboxes`, edit);
      toast('Saved'); setEdit(null); load();
    } catch (e) { toast(e.message, { error: true }); }
  };
  const remove = async (b) => {
    const typed = prompt(`Delete ${b.email} and ALL of its mail? This can't be undone.\n\nType the address to confirm:`);
    if (typed !== b.email) return;
    try { await api.delWith(`/api/admin/orgs/${org.id}/shared-mailboxes/${encodeURIComponent(b.email)}`, { confirm: typed }); toast('Deleted'); load(); } catch (e) { toast(e.message, { error: true }); }
  };
  return (
    <div className="settings-section">
      <p className="muted small">A shared mailbox is one address, like support@ or info@, that several people read and answer from.
        Members pick it at the top of their folder list. Replies go out from the shared address. Shared mailboxes are free (up to {d.limit}).</p>
      <div className="admin-toolbar"><div className="spacer" />
        <button className="btn primary" disabled={!domains.length} onClick={() => setEdit({ localPart: '', domain: domains[0], name: '', members: [] })}><Icon name="plus" size={16} /> New shared mailbox</button>
      </div>
      {d.boxes.length === 0 && !edit && <p className="muted">No shared mailboxes yet.</p>}
      {d.boxes.map((b) => (
        <div key={b.email} className="card" style={{ marginBottom: 8 }}>
          <b>{b.name || b.email}</b> <span className="muted small">{b.email}</span>
          <div className="small">{b.members.length ? b.members.map((m) => `${m.email}${m.canSend ? '' : ' (read only)'}`).join(', ') : 'No members yet'}</div>
          <div className="actions" style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn sm" onClick={() => setEdit({ ...b })}>Members</button>
            <button className="icon-btn" title="Delete" onClick={() => remove(b)}><Icon name="trash" size={16} /></button>
          </div>
        </div>
      ))}
      {edit && (
        <div className="card">
          <h3>{edit.email ? `Members of ${edit.email}` : 'New shared mailbox'}</h3>
          <div className="form">
            {!edit.email && (
              <div className="pick-time">
                <input placeholder="support" value={edit.localPart} onChange={(e) => setEdit({ ...edit, localPart: e.target.value.toLowerCase() })} />
                <span>@</span>
                <select value={edit.domain} onChange={(e) => setEdit({ ...edit, domain: e.target.value })}>{domains.map((x) => <option key={x}>{x}</option>)}</select>
              </div>
            )}
            <input placeholder="Display name (e.g. Customer Support)" value={edit.name || ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <p className="small"><b>Who can use it?</b></p>
            {people.map((p) => {
              const m = edit.members.find((x) => x.email === p.email);
              return (
                <div key={p.email} className="small" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <label className="check"><input type="checkbox" checked={!!m} onChange={() => toggle(p.email)} /> {p.name || p.email} <span className="muted">{p.name ? p.email : ''}</span></label>
                  {m && <label className="check"><input type="checkbox" checked={m.canSend} onChange={(e) => setSend(p.email, e.target.checked)} /> can send</label>}
                </div>
              );
            })}
            <div className="actions"><button className="btn primary" onClick={save}>Save</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
