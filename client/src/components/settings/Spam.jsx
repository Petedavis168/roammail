import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { t } from '../../i18n.js';

export function SenderList({ title, help, items, onAdd, onRemove, placeholder }) {
  const [v, setV] = useState('');
  return (
    <div className="card sender-list">
      <h3>{title}</h3>
      <p className="muted small">{help}</p>
      <form className="pick-time" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onAdd(v.trim()).then((ok) => ok && setV('')); }}>
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} />
        <button className="btn">{t("Add")}</button>
      </form>
      <div className="chips-wrap">
        {items.length === 0 && <span className="muted small">{t("None yet.")}</span>}
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
        <div><Icon name="inbox" /><b>{t("Inbox")}</b><small>{t("Normal mail")}</small></div>
        <span>→</span>
        <div><Icon name="junk" /><b>{t("Junk Email")}</b><small>{t("Probably spam. Delivered to your Junk folder so you can check it")}</small></div>
        <span>→</span>
        <div><Icon name="shield" /><b>{t("Spam quarantine")}</b><small>{t("Definitely spam. Held back by the server")}</small></div>
      </div>
      <p className="muted small">{t("Marking mail as")}{' '}<b>{t("Junk")}</b>{t(", or moving it out with")}{' '}<b>{t("Not junk")}</b>{t(", teaches the filter what you consider spam. It works the same from your phone or Outlook.")}</p>

      <h3>{t("How strict should the filter be?")}</h3>
      <div className="preset-row">
        {Object.entries(d.presets).map(([k, p]) => (
          <label key={k} className={`radio-card ${d.preset === k ? 'on' : ''}`}>
            <input type="radio" checked={d.preset === k} onChange={() => run(() => api.put('/api/spam/sensitivity', { preset: k }), `Spam filter set to ${p.label}`)} />
            <div><b>{p.label}</b><small className="muted">{p.help}</small></div>
          </label>
        ))}
        <label className={`radio-card ${d.preset === 'custom' ? 'on' : ''}`}>
          <input type="radio" checked={d.preset === 'custom'} onChange={() => setD({ ...d, preset: 'custom' })} />
          <div><b>{t("Custom")}</b><small className="muted">{t("Set the exact spam scores.")}</small></div>
        </label>
      </div>
      {d.preset === 'custom' && (
        <div className="card">
          <div className="two-col">
            <label>{t("Send to Junk at score")}<input type="number" min="1" max="50" step="0.5" value={custom.low} onChange={(e) => setCustom({ ...custom, low: e.target.value })} /></label>
            <label>{t("Block (quarantine) at score")}<input type="number" min="2" max="100" step="0.5" value={custom.high} onChange={(e) => setCustom({ ...custom, high: e.target.value })} /></label>
          </div>
          <small className="muted">{t("Lower numbers are stricter. Most real mail scores below 3; obvious spam scores above 15.")}</small>
          <div><button className="btn primary" onClick={() => run(() => api.put('/api/spam/sensitivity', custom), 'Custom spam levels saved')}>{t("Save")}</button></div>
        </div>
      )}
      {d.score && <p className="muted small">{t("Current levels: Junk at")}{' '}{d.score.low}{t(", blocked at")}{' '}{d.score.high}.</p>}

      <SenderList title={t("Safe senders")} placeholder="name@example.com or example.com"
        help="Mail from these senders and domains never goes to Junk."
        items={d.safe} onAdd={(v) => run(() => api.post('/api/spam/senders', { list: 'safe', value: v }), `${v} is now a safe sender`)}
        onRemove={(x) => run(() => api.del('/api/spam/senders', { id: x.id }), 'Removed')} />
      <SenderList title={t("Blocked senders")} placeholder="name@example.com or example.com"
        help="The server rejects mail from these senders before it reaches you, in every app."
        items={d.blocked} onAdd={(v) => run(() => api.post('/api/spam/senders', { list: 'blocked', value: v }), `${v} is blocked`)}
        onRemove={(x) => run(() => api.del('/api/spam/senders', { id: x.id }), 'Unblocked')} />

      <h3>{t("Quarantine summary email")}</h3>
      <p className="muted small">{t("Get an email listing messages the server held back, so you never miss a real one.")}</p>
      <select value={d.notifications} onChange={(e) => run(() => api.put('/api/spam/notifications', { frequency: e.target.value }), 'Saved')}>
        <option value="hourly">{t("Every hour")}</option><option value="daily">{t("Once a day")}</option><option value="weekly">{t("Once a week")}</option><option value="never">{t("Never")}</option>
      </select>
    </div>
  );
}
