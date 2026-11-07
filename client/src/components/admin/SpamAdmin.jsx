import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';
import { SenderList } from '../settings/Spam.jsx';
import QuarantineList from '../QuarantineList.jsx';

export default function SpamAdmin({ org }) {
  const toast = useToast();
  const active = org.domains.filter((d) => d.status === 'active');
  const [domain, setDomain] = useState(active[0]?.domain || '');
  const [d, setD] = useState(null);
  const [preset, setPreset] = useState('standard');
  const [notify, setNotify] = useState('daily');
  const [view, setView] = useState('policy');
  const load = () => domain && api.get('/api/admin/spam', { domain }).then((r) => { setD(r); setPreset(r.preset); }).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, [domain]);
  if (!active.length) return <div className="empty-card"><p>Finish setting up a domain first.</p></div>;
  if (!d) return <div className="spinner" />;
  const run = async (fn, msg) => { try { await fn(); toast(msg); load(); return true; } catch (e) { toast(e.message, { error: true }); return false; } };

  return (
    <div className="org-sig-admin">
      <div className="admin-toolbar">
        {active.length > 1 && <select value={domain} onChange={(e) => setDomain(e.target.value)}>{active.map((x) => <option key={x.domain}>{x.domain}</option>)}</select>}
        <div className="seg small-seg">
          <button className={view === 'policy' ? 'on' : ''} onClick={() => setView('policy')}>Spam policy</button>
          <button className={view === 'quarantine' ? 'on' : ''} onClick={() => setView('quarantine')}>Team quarantine</button>
        </div>
      </div>
      {view === 'quarantine' ? (
        <div className="admin-quarantine"><QuarantineList domain={domain} title={`Quarantine for @${domain}`} /></div>
      ) : <>
        <div className="card">
          <h3>Filter strictness for everyone at @{domain}</h3>
          <div className="preset-row">
            {Object.entries(d.presets).map(([k, p]) => (
              <label key={k} className={`radio-card ${preset === k ? 'on' : ''}`}><input type="radio" checked={preset === k} onChange={() => setPreset(k)} />
                <div><b>{p.label}</b><small className="muted">{p.help}</small></div></label>
            ))}
          </div>
          <label className="row-field">Quarantine summary email for everyone
            <select value={notify} onChange={(e) => setNotify(e.target.value)}>
              <option value="hourly">Every hour</option><option value="daily">Once a day</option><option value="weekly">Once a week</option><option value="never">Never</option>
            </select></label>
          <div className="step-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="btn primary" onClick={() => confirm(`Apply to every user at @${domain}? This replaces their own setting.`) && run(async () => { const r = await api.post('/api/admin/spam/apply', { domain, preset, notifications: notify }); toast(`Applied to ${r.users} users`); }, 'New users will get these settings too')}>Apply to all users</button>
          </div>
        </div>
        <SenderList title="Company safe senders" placeholder="partner.com or name@partner.com"
          help="Mail from these senders never goes to Junk for anyone at your company. Good for partners, suppliers and your own systems."
          items={d.safe} onAdd={(v) => run(() => api.post('/api/admin/spam/senders', { domain, list: 'safe', value: v }), `${v} trusted company-wide`)}
          onRemove={(x) => run(() => api.del('/api/admin/spam/senders', { domain, id: x.id }), 'Removed')} />
        <SenderList title="Company blocked senders" placeholder="spammer.com or name@spammer.com"
          help="Rejected by the server for everyone at your company."
          items={d.blocked} onAdd={(v) => run(() => api.post('/api/admin/spam/senders', { domain, list: 'blocked', value: v }), `${v} blocked company-wide`)}
          onRemove={(x) => run(() => api.del('/api/admin/spam/senders', { domain, id: x.id }), 'Unblocked')} />
      </>}
    </div>
  );
}
