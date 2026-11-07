import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';

export function SenderList({ title, help, items, onAdd, onRemove, placeholder }) {
  const [v, setV] = useState('');
  return (
    <div className="card sender-list">
      <h3>{title}</h3>
      <p className="muted small">{help}</p>
      <form className="pick-time" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onAdd(v.trim()).then((ok) => ok && setV('')); }}>
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} />
        <button className="btn">Add</button>
      </form>
      <div className="chips-wrap">
        {items.length === 0 && <span className="muted small">None yet.</span>}
        {items.map((x) => (
          <span key={x.id} className={`rchip ${x.byAdmin ? 'locked' : ''}`} title={x.byAdmin ? 'Set by your administrator for everyone' : ''}>
            {x.value.replace(/^\*@/, '@')}{x.byAdmin ? <Icon name="lock" size={11} /> : <button onClick={() => onRemove(x)} aria-label={`Remove ${x.value}`}>×</button>}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function SpamSettings() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [custom, setCustom] = useState({ low: 5, high: 15 });
  const load = () => api.get('/api/spam').then((r) => { setD(r); if (r.score) setCustom(r.score); }).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []);
  if (!d) return <div className="spinner" />;
  const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); load(); return true; } catch (e) { toast(e.message, { error: true }); return false; } };

  return (
    <div className="settings-section">
      <div className="how-spam">
        <div><Icon name="inbox" /><b>Inbox</b><small>Normal mail</small></div>
        <span>→</span>
        <div><Icon name="junk" /><b>Junk Email</b><small>Probably spam. Delivered to your Junk folder so you can check it</small></div>
        <span>→</span>
        <div><Icon name="shield" /><b>Spam quarantine</b><small>Definitely spam. Held back by the server</small></div>
      </div>
      <p className="muted small">Marking mail as <b>Junk</b>, or moving it out with <b>Not junk</b>, teaches the filter what you consider spam. It works the same from your phone or Outlook.</p>

      <h3>How strict should the filter be?</h3>
      <div className="preset-row">
        {Object.entries(d.presets).map(([k, p]) => (
          <label key={k} className={`radio-card ${d.preset === k ? 'on' : ''}`}>
            <input type="radio" checked={d.preset === k} onChange={() => run(() => api.put('/api/spam/sensitivity', { preset: k }), `Spam filter set to ${p.label}`)} />
            <div><b>{p.label}</b><small className="muted">{p.help}</small></div>
          </label>
        ))}
        <label className={`radio-card ${d.preset === 'custom' ? 'on' : ''}`}>
          <input type="radio" checked={d.preset === 'custom'} onChange={() => setD({ ...d, preset: 'custom' })} />
          <div><b>Custom</b><small className="muted">Set the exact spam scores.</small></div>
        </label>
      </div>
      {d.preset === 'custom' && (
        <div className="card">
          <div className="two-col">
            <label>Send to Junk at score<input type="number" min="1" max="50" step="0.5" value={custom.low} onChange={(e) => setCustom({ ...custom, low: e.target.value })} /></label>
            <label>Block (quarantine) at score<input type="number" min="2" max="100" step="0.5" value={custom.high} onChange={(e) => setCustom({ ...custom, high: e.target.value })} /></label>
          </div>
          <small className="muted">Lower numbers are stricter. Most real mail scores below 3; obvious spam scores above 15.</small>
          <div><button className="btn primary" onClick={() => run(() => api.put('/api/spam/sensitivity', custom), 'Custom spam levels saved')}>Save</button></div>
        </div>
      )}
      {d.score && <p className="muted small">Current levels: Junk at {d.score.low}, blocked at {d.score.high}.</p>}

      <SenderList title="Safe senders" placeholder="name@example.com or example.com"
        help="Mail from these senders and domains never goes to Junk."
        items={d.safe} onAdd={(v) => run(() => api.post('/api/spam/senders', { list: 'safe', value: v }), `${v} is now a safe sender`)}
        onRemove={(x) => run(() => api.del('/api/spam/senders', { id: x.id }), 'Removed')} />
      <SenderList title="Blocked senders" placeholder="name@example.com or example.com"
        help="The server rejects mail from these senders before it reaches you, in every app."
        items={d.blocked} onAdd={(v) => run(() => api.post('/api/spam/senders', { list: 'blocked', value: v }), `${v} is blocked`)}
        onRemove={(x) => run(() => api.del('/api/spam/senders', { id: x.id }), 'Unblocked')} />

      <h3>Quarantine summary email</h3>
      <p className="muted small">Get an email listing messages the server held back, so you never miss a real one.</p>
      <select value={d.notifications} onChange={(e) => run(() => api.put('/api/spam/notifications', { frequency: e.target.value }), 'Saved')}>
        <option value="hourly">Every hour</option><option value="daily">Once a day</option><option value="weekly">Once a week</option><option value="never">Never</option>
      </select>
    </div>
  );
}
