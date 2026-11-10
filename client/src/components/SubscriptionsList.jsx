// Subscriptions: every newsletter and mailing list in your inbox, by sender. Search, filter and sort them; see their
// emails; unsubscribe in one click; clear out everything they've sent; or block them.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { avatarColor, fmtDate } from '../util.js';
import { useToast } from './Toast.jsx';

const FILTERS = [['all', 'All'], ['unread', 'Mostly unread'], ['busy', 'Most emails'], ['active', 'Still subscribed'], ['unsubscribed', 'Unsubscribed'], ['kept', 'Kept']];
const SORTS = [['recent', 'Most recent'], ['count', 'Most emails'], ['unread', 'Most unread'], ['name', 'Name']];
const initial = (s) => (s.name || s.address)[0]?.toUpperCase() || '?';

export default function SubscriptionsList({ onShowSender, onBlock }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('recent');
  const [busy, setBusy] = useState('');
  const [picked, setPicked] = useState(new Set());
  const load = (refresh) => api.get('/api/subscriptions', refresh ? { refresh: '1' } : undefined).then(setData).catch((e) => { toast(e.message, { error: true }); setData({ senders: [] }); });
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    let l = data?.senders || [];
    const s = q.trim().toLowerCase();
    if (s) l = l.filter((x) => x.address.includes(s) || x.name.toLowerCase().includes(s) || x.subject.toLowerCase().includes(s));
    if (filter === 'unread') l = l.filter((x) => x.unread / x.count >= 0.7);
    if (filter === 'busy') l = l.filter((x) => x.count >= 5);
    if (['active', 'unsubscribed', 'kept'].includes(filter)) l = l.filter((x) => x.status === filter);
    const by = { recent: (a, b) => b.last - a.last, count: (a, b) => b.count - a.count, unread: (a, b) => b.unread - a.unread, name: (a, b) => (a.name || a.address).localeCompare(b.name || b.address) }[sort];
    return [...l].sort(by);
  }, [data, q, filter, sort]);

  const setStatus = (address, status) => setData((d) => ({ ...d, senders: d.senders.map((x) => (x.address === address ? { ...x, status } : x)) }));
  const unsubscribe = async (s, quiet) => {
    setBusy(s.address);
    try {
      const r = await api.post('/api/subscriptions/unsubscribe', { address: s.address });
      if (r.method === 'link') window.open(r.url, '_blank', 'noopener,noreferrer');
      setStatus(s.address, 'unsubscribed');
      if (!quiet) toast(r.method === 'link' ? `Finish unsubscribing on ${s.domain}'s page` : `Unsubscribed from ${s.name || s.address}`);
      return true;
    } catch (e) { if (!quiet) toast(e.message, { error: true }); return false; } finally { setBusy(''); }
  };
  const cleanup = async (s, action) => {
    if (!confirm(`${action === 'trash' ? 'Delete' : 'Archive'} all ${s.count} emails from ${s.name || s.address}?`)) return;
    setBusy(s.address);
    try {
      const r = await api.post('/api/subscriptions/cleanup', { address: s.address, action });
      toast(`${r.moved} ${r.moved === 1 ? 'email' : 'emails'} ${action === 'trash' ? 'moved to the bin' : 'archived'}`);
      load();
    } catch (e) { toast(e.message, { error: true }); } finally { setBusy(''); }
  };
  const keep = async (s) => {
    const k = s.status !== 'kept';
    await api.post('/api/subscriptions/keep', { address: s.address, keep: k }).catch(() => {});
    setStatus(s.address, k ? 'kept' : 'active');
  };
  const bulkUnsub = async () => {
    const list = shown.filter((s) => picked.has(s.address) && s.canUnsubscribe);
    let ok = 0;
    for (const s of list) if (await unsubscribe(s, true)) ok++;
    toast(`Unsubscribed from ${ok} of ${list.length}`);
    setPicked(new Set());
  };
  const togglePick = (a) => setPicked((p) => { const n = new Set(p); if (n.has(a)) n.delete(a); else n.add(a); return n; });
  const total = data?.senders?.length || 0;
  const emails = (data?.senders || []).reduce((n, s) => n + s.count, 0);

  return (
    <section className="list wide-list subs">
      <div className="list-head">
        <h2>Subscriptions</h2>
        <button className="icon-btn" title="Check again" aria-label="Check again" onClick={() => { setData(null); load(true); }}><Icon name="refresh" /></button>
      </div>
      {data && total > 0 && <p className="subs-sum muted small">{total} senders · {emails} emails in your inbox</p>}
      <div className="subs-tools">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search senders" aria-label="Search senders" />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </div>
      <div className="chips" role="tablist">
        {FILTERS.map(([v, l]) => <button key={v} role="tab" aria-selected={filter === v} className={`chip ${filter === v ? 'on' : ''}`} onClick={() => setFilter(v)}>{l}</button>)}
      </div>
      {picked.size > 0 && (
        <div className="subs-bulk"><b>{picked.size} selected</b><button className="btn sm primary" onClick={bulkUnsub}>Unsubscribe from all</button><button className="btn sm" onClick={() => setPicked(new Set())}>Clear</button></div>
      )}
      <div className="rows">
        {!data && <div className="list-msg"><div className="spinner" /><p className="muted small">Looking through your inbox…</p></div>}
        {data && !shown.length && <div className="empty"><Icon name="mail" size={48} /><p>{total ? 'Nothing matches.' : 'No newsletters or mailing lists in your inbox.'}</p></div>}
        {shown.map((s) => (
          <div key={s.address} className={`row sub-row ${s.status === 'unsubscribed' ? 'done' : ''}`}>
            <input type="checkbox" className="sub-pick" checked={picked.has(s.address)} onChange={() => togglePick(s.address)} aria-label={`Select ${s.name || s.address}`} disabled={!s.canUnsubscribe || s.status === 'unsubscribed'} />
            <span className="avatar" style={{ background: avatarColor(s.address) }}>{initial(s)}</span>
            <div className="row-main">
              <div className="row-top"><span className="from">{s.name || s.address}</span><span className="date">{fmtDate(new Date(s.last).toISOString())}</span></div>
              <div className="row-sub muted small">{s.address}</div>
              <div className="sub-stats small">
                <span><b>{s.count}</b> {s.count === 1 ? 'email' : 'emails'}</span>
                {s.unread > 0 && <span><b>{s.unread}</b> unread</span>}
                {s.status === 'unsubscribed' && <span className="tag ok">Unsubscribed</span>}
                {s.status === 'kept' && <span className="tag">Kept</span>}
                {s.oneClick && s.status !== 'unsubscribed' && <span className="tag">One-click</span>}
              </div>
            </div>
            <div className="sub-actions">
              <button className="btn sm" onClick={() => onShowSender(s.address)}>Show emails</button>
              {s.canUnsubscribe && s.status !== 'unsubscribed' && <button className="btn sm primary" disabled={busy === s.address} onClick={() => unsubscribe(s)}>{busy === s.address ? 'Working…' : 'Unsubscribe'}</button>}
              <details className="sub-more">
                <summary className="btn sm" aria-label="More actions">⋯</summary>
                <div className="menu">
                  <button onClick={() => cleanup(s, 'archive')}><Icon name="archive" size={14} /> Archive all</button>
                  <button onClick={() => cleanup(s, 'trash')}><Icon name="trash" size={14} /> Delete all</button>
                  <button onClick={() => keep(s)}><Icon name="star" size={14} /> {s.status === 'kept' ? 'Stop keeping' : 'Keep (I want these)'}</button>
                  <button onClick={async () => { await onBlock(s.address); setStatus(s.address, 'unsubscribed'); }}><Icon name="block" size={14} /> Block sender</button>
                </div>
              </details>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
