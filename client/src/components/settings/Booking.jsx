// Settings → Booking: your public booking page, weekly hours, as many meeting types as you like, and upcoming bookings.
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';

const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
const LOCS = [['video', 'Video call (link created for each booking)'], ['phone', 'Phone call (you call them)'], ['in_person', 'In person'], ['custom', 'Other (describe it)']];
const COLORS = ['#1d4ed8', '#0f766e', '#15803d', '#b45309', '#b91c1c', '#7c3aed', '#be185d', '#0e7490'];
const toHm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHm = (s) => { const [h, m] = String(s).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const zones = (() => { let z = []; try { z = Intl.supportedValuesOf('timeZone'); } catch { /* old browser */ } return ['UTC', ...z.filter((x) => x !== 'UTC')]; })();
const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function copy(text, toast) {
  navigator.clipboard?.writeText(text).then(() => toast('Link copied'), () => toast('Copy failed. Select the link and copy it.', { error: true }));
}

function Hours({ hours, onChange }) {
  const set = (d, ranges) => onChange({ ...hours, [d]: ranges });
  return (
    <div className="bkh">
      {DAYS.map(([d, label]) => {
        const ranges = hours[d] || [];
        return (
          <div key={d} className="bkh-row">
            <label className="bkh-day"><input type="checkbox" checked={ranges.length > 0} onChange={(e) => set(d, e.target.checked ? [[540, 1020]] : [])} /> {label}</label>
            <div className="bkh-ranges">
              {ranges.length === 0 && <span className="muted small">Unavailable</span>}
              {ranges.map(([a, b], i) => (
                <span key={i} className="bkh-range">
                  <input type="time" value={toHm(a)} step={900} aria-label={`${label} from`} onChange={(e) => set(d, ranges.map((r, j) => (j === i ? [fromHm(e.target.value), r[1]] : r)))} />
                  –
                  <input type="time" value={toHm(b)} step={900} aria-label={`${label} until`} onChange={(e) => set(d, ranges.map((r, j) => (j === i ? [r[0], fromHm(e.target.value)] : r)))} />
                  <button type="button" className="icon-btn" aria-label="Remove these hours" onClick={() => set(d, ranges.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
                </span>
              ))}
              {ranges.length > 0 && ranges.length < 4 && <button type="button" className="link" onClick={() => set(d, [...ranges, [Math.min(1380, (ranges.at(-1)?.[1] || 720) + 60), Math.min(1440, (ranges.at(-1)?.[1] || 720) + 180)]])}>+ Add hours</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TypeEditor({ initial, onSave, onCancel }) {
  const [t, setT] = useState(() => ({ name: '', description: '', duration: 30, location: 'video', locationDetail: '', bufferBefore: 0, bufferAfter: 10, minNotice: 240, maxDays: 60, dailyLimit: 0, interval: 0, color: '#1d4ed8', active: true, ...initial }));
  const set = (patch) => setT((x) => ({ ...x, ...patch }));
  return (
    <form className="card bkt-edit" onSubmit={(e) => { e.preventDefault(); onSave(t); }}>
      <div className="bkt-grid">
        <label>Name<input value={t.name} onChange={(e) => set({ name: e.target.value })} required maxLength={80} placeholder="e.g. 30-minute consultation" /></label>
        <label>Length<select value={[15, 20, 30, 45, 60, 90, 120].includes(t.duration) ? t.duration : 'custom'} onChange={(e) => set({ duration: e.target.value === 'custom' ? t.duration : Number(e.target.value) })}>
          {[15, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{dur(m)}</option>)}<option value="custom">Custom…</option></select></label>
        {![15, 20, 30, 45, 60, 90, 120].includes(t.duration) && <label>Minutes<input type="number" min={5} max={480} value={t.duration} onChange={(e) => set({ duration: Number(e.target.value) })} /></label>}
        <label className="wide">Description (shown on your page)<textarea rows={2} value={t.description} onChange={(e) => set({ description: e.target.value })} maxLength={1000} /></label>
        <label>Where<select value={t.location} onChange={(e) => set({ location: e.target.value })}>{LOCS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {(t.location === 'in_person' || t.location === 'custom') && <label>{t.location === 'in_person' ? 'Address' : 'Details'}<input value={t.locationDetail} onChange={(e) => set({ locationDetail: e.target.value })} maxLength={300} /></label>}
        <label>Minimum notice<select value={t.minNotice} onChange={(e) => set({ minNotice: Number(e.target.value) })}>
          {[[0, 'None'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [720, '12 hours'], [1440, '1 day'], [2880, '2 days'], [10080, '1 week']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label>Book up to<select value={t.maxDays} onChange={(e) => set({ maxDays: Number(e.target.value) })}>
          {[7, 14, 30, 60, 90, 180, 365].map((v) => <option key={v} value={v}>{v} days ahead</option>)}</select></label>
        <label>Break before<select value={t.bufferBefore} onChange={(e) => set({ bufferBefore: Number(e.target.value) })}>{[0, 5, 10, 15, 30, 60].map((v) => <option key={v} value={v}>{v ? `${v} min` : 'None'}</option>)}</select></label>
        <label>Break after<select value={t.bufferAfter} onChange={(e) => set({ bufferAfter: Number(e.target.value) })}>{[0, 5, 10, 15, 30, 60].map((v) => <option key={v} value={v}>{v ? `${v} min` : 'None'}</option>)}</select></label>
        <label>Most per day<select value={t.dailyLimit} onChange={(e) => set({ dailyLimit: Number(e.target.value) })}>{[0, 1, 2, 3, 4, 5, 6, 8, 10].map((v) => <option key={v} value={v}>{v || 'No limit'}</option>)}</select></label>
        <label>Start times every<select value={t.interval} onChange={(e) => set({ interval: Number(e.target.value) })}>{[[0, 'Meeting length'], [15, '15 min'], [30, '30 min'], [60, '1 hour']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <div className="wide sb-swatches">Colour {COLORS.map((c) => <button key={c} type="button" className={t.color === c ? 'on' : ''} style={{ background: c }} aria-label={c} onClick={() => set({ color: c })} />)}</div>
      </div>
      <div className="btn-row"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary">Save meeting type</button></div>
    </form>
  );
}

export default function Booking() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [page, setPage] = useState(null);
  const [editing, setEditing] = useState(null); // type id, 'new' or null
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/booking/me').then((r) => { setS(r); setPage(r.page); }).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []);
  const run = async (fn, ok) => { setBusy(true); try { const r = await fn(); if (r?.types) { setS(r); setPage(r.page); } if (ok) toast(ok); } catch (e) { toast(e.message, { error: true }); } finally { setBusy(false); } };

  if (!s) return <div className="spinner" />;
  if (!s.page) {
    return (
      <div className="settings-section">
        <h3>Your booking page</h3>
        <p>Let people book time with you from a link: in your email signature, on your website, anywhere.</p>
        <ul className="muted small"><li>As many meeting types as you like (15-minute call, 1-hour consultation, site visit…)</li><li>Only times that are free in your calendar are offered</li><li>Bookings go straight into your calendar, with a confirmation and cancel link for your guest</li></ul>
        <button className="btn primary" disabled={busy} onClick={() => run(() => api.put('/api/booking/page', { timezone: myTz }), 'Your booking page is ready')}><Icon name="calendar" size={16} /> Create my booking page</button>
      </div>
    );
  }
  const savePage = (patch, ok = 'Saved') => run(() => api.put('/api/booking/page', { ...page, ...patch }), ok);

  return (
    <div className="settings-section">
      <h3>Your booking page</h3>
      <div className="card bk-link">
        <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>
        <div className="btn-row">
          <button className="btn sm" onClick={() => copy(s.url, toast)}><Icon name="copy" size={14} /> Copy link</button>
          <a className="btn sm" href={s.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> Open</a>
          <label className="check"><input type="checkbox" checked={!!page.enabled} onChange={(e) => savePage({ enabled: e.target.checked }, e.target.checked ? 'Taking bookings' : 'Bookings paused')} /> Taking bookings</label>
        </div>
        {!page.connected && <p className="muted small">Bookings are paused until your calendar reconnects. Opening this page again reconnects it.</p>}
      </div>
      <div className="bk-fields">
        <label>Page address<span className="bk-slug"><span className="muted">{s.url.replace(/[^/]+$/, '')}</span><input value={page.slug} onChange={(e) => setPage({ ...page, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} maxLength={40} /></span></label>
        <label>Name shown<input value={page.title} onChange={(e) => setPage({ ...page, title: e.target.value })} maxLength={100} /></label>
        <label>Welcome note<textarea rows={2} value={page.intro} onChange={(e) => setPage({ ...page, intro: e.target.value })} maxLength={1000} placeholder="Pick a time that suits you. I look forward to speaking with you." /></label>
        <label>Your time zone<select value={page.timezone} onChange={(e) => setPage({ ...page, timezone: e.target.value })}>{zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</select></label>
      </div>
      <h4>When you're available</h4>
      <Hours hours={page.hours} onChange={(hours) => setPage({ ...page, hours })} />
      <div className="btn-row"><button className="btn primary" disabled={busy} onClick={() => savePage({})}>Save page and hours</button></div>

      <h3>Meeting types</h3>
      <div className="bkt-list">
        {s.types.map((t) => (editing === t.id
          ? <TypeEditor key={t.id} initial={t} onCancel={() => setEditing(null)} onSave={(v) => run(() => api.put(`/api/booking/types/${t.id}`, v), 'Saved').then(() => setEditing(null))} />
          : (
            <div key={t.id} className={`card bkt ${t.active ? '' : 'off'}`} style={{ borderLeftColor: t.color }}>
              <div className="bkt-main"><b>{t.name}</b><span className="muted small">{dur(t.duration)} · {LOCS.find(([v]) => v === t.location)?.[1].split(' (')[0]}{t.active ? '' : ' · hidden'}</span></div>
              <div className="btn-row">
                <button className="btn sm" onClick={() => copy(t.url, toast)} title="Copy a link straight to this meeting type"><Icon name="copy" size={14} /> Link</button>
                <button className="btn sm" onClick={() => run(() => api.put(`/api/booking/types/${t.id}`, { active: !t.active }))}>{t.active ? 'Hide' : 'Show'}</button>
                <button className="btn sm" onClick={() => setEditing(t.id)}>Edit</button>
                <button className="icon-btn" aria-label={`Delete ${t.name}`} onClick={() => confirm(`Delete "${t.name}"? Existing bookings stay in your calendar.`) && run(() => api.del(`/api/booking/types/${t.id}`), 'Deleted')}><Icon name="trash" size={16} /></button>
              </div>
            </div>
          )))}
        {editing === 'new'
          ? <TypeEditor onCancel={() => setEditing(null)} onSave={(v) => run(() => api.post('/api/booking/types', v), 'Meeting type added').then(() => setEditing(null))} />
          : s.types.length < 20 && <button className="btn" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add a meeting type</button>}
      </div>

      <h3>Upcoming bookings</h3>
      {!s.bookings.length && <p className="muted small">None yet. Share your link to get started.</p>}
      {s.bookings.map((b) => (
        <div key={b.id} className={`card bkb ${b.status !== 'confirmed' ? 'off' : ''}`}>
          <div><b>{new Date(b.start).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</b> · {b.type}</div>
          <div className="small">{b.name} · <a href={`mailto:${b.email}`}>{b.email}</a>{b.phone ? ` · ${b.phone}` : ''}{b.status !== 'confirmed' ? ' · cancelled' : ''}</div>
          {b.notes && <div className="muted small">“{b.notes}”</div>}
          {b.status === 'confirmed' && <button className="link" onClick={() => { const reason = prompt('Cancel this booking? We’ll email them. Reason (optional):'); if (reason !== null) run(() => api.post(`/api/booking/bookings/${b.id}/cancel`, { reason }), 'Cancelled and emailed'); }}>Cancel booking</button>}
        </div>
      ))}
    </div>
  );
}
