// Hide-my-email: a new address for every site you sign up to. Mail to it lands in your inbox; switch it off when it
// starts getting spam, and you'll know who leaked it.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtDate } from '../util.js';
import { useToast } from './Toast.jsx';

export default function AliasesList({ onShowAlias }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/aliases').then(setData).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []);
  const copy = (a) => navigator.clipboard?.writeText(a).then(() => toast('Copied'), () => {});

  const create = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      const a = await api.post('/api/aliases', { note });
      setData((d) => ({ ...d, aliases: [a, ...d.aliases] }));
      setNote(''); copy(a.address); toast(`Created and copied: ${a.address}`);
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  };
  const patch = async (a, body) => {
    try { const r = await api.patch(`/api/aliases/${a.id}`, body); setData((d) => ({ ...d, aliases: d.aliases.map((x) => (x.id === a.id ? r : x)) })); }
    catch (err) { toast(err.message, { error: true }); }
  };
  const remove = async (a) => {
    if (!confirm(`Delete ${a.address}? Mail sent to it will bounce, and it can't be brought back.`)) return;
    try { await api.del(`/api/aliases/${a.id}`); setData((d) => ({ ...d, aliases: d.aliases.filter((x) => x.id !== a.id) })); }
    catch (err) { toast(err.message, { error: true }); }
  };
  const shown = useMemo(() => (data?.aliases || []).filter((a) => (filter === 'all' || (filter === 'on') === a.active)
    && (!q.trim() || a.address.includes(q.trim().toLowerCase()) || a.note.toLowerCase().includes(q.trim().toLowerCase()))), [data, q, filter]);

  return (
    <section className="list wide-list aliases">
      <div className="list-head"><h2>Aliases</h2></div>
      <p className="muted small alias-intro">Use a different address for every website and newsletter. Mail to an alias arrives in your inbox. If one starts getting spam, switch it off, and you'll know who shared it.</p>
      <form className="alias-new" onSubmit={create}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's it for? e.g. Amazon, newsletter, job boards" maxLength={100} aria-label="What it's for" />
        <button className="btn primary" disabled={busy || (data && data.aliases.length >= data.limit)}><Icon name="plus" size={15} /> {busy ? 'Creating…' : 'New alias'}</button>
      </form>
      {data && <p className="muted small alias-count">{data.aliases.length} of {data.limit} aliases used</p>}
      {data?.aliases.length > 0 && (
        <div className="subs-tools">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search aliases" aria-label="Search aliases" />
          <div className="chips">{[['all', 'All'], ['on', 'On'], ['off', 'Off']].map(([v, l]) => <button key={v} className={`chip ${filter === v ? 'on' : ''}`} onClick={() => setFilter(v)}>{l}</button>)}</div>
        </div>
      )}
      <div className="rows">
        {!data && <div className="list-msg"><div className="spinner" /></div>}
        {data && !data.aliases.length && <div className="empty"><Icon name="shield" size={48} /><p>No aliases yet.</p><small>Make one for the next site that asks for your email.</small></div>}
        {shown.map((a) => (
          <div key={a.id} className={`row alias-row ${a.active ? '' : 'off'}`}>
            <div className="row-main">
              <div className="row-top"><span className="from alias-addr">{a.address}</span><span className="date">{fmtDate(new Date(a.created).toISOString())}</span></div>
              <input className="alias-note" defaultValue={a.note} placeholder="Add a note" maxLength={100} aria-label={`Note for ${a.address}`}
                onBlur={(e) => e.target.value !== a.note && patch(a, { note: e.target.value })} />
            </div>
            <div className="sub-actions">
              <button className="btn sm" onClick={() => copy(a.address)} title="Copy"><Icon name="copy" size={14} /></button>
              <button className="btn sm" onClick={() => onShowAlias(a.address)}>Show emails</button>
              <label className="switch" title={a.active ? 'Receiving mail' : 'Switched off: mail to it bounces'}>
                <input type="checkbox" checked={a.active} onChange={(e) => patch(a, { active: e.target.checked })} aria-label={`${a.address} on or off`} /> {a.active ? 'On' : 'Off'}
              </label>
              <button className="icon-btn" onClick={() => remove(a)} aria-label={`Delete ${a.address}`}><Icon name="trash" size={16} /></button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
