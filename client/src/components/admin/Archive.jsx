import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';
import { fmtDate } from '../../util.js';

export default function Archive({ org }) {
  const toast = useToast();
  const [cfg, setCfg] = useState(null);
  const [people, setPeople] = useState([]);
  const domains = (org.domains || []).filter((x) => x.status === 'active').map((x) => x.domain);
  useEffect(() => {
    api.get(`/api/admin/orgs/${org.id}/archive`).then(setCfg).catch((e) => toast(e.message, { error: true }));
    Promise.all(domains.map((dom) => api.get('/api/admin/users', { domain: dom }).catch(() => []))).then((l) => setPeople(l.flat()));
  }, [org.id]);
  if (!cfg) return <div className="spinner" />;
  const toggle = (key, email) => setCfg((c) => ({ ...c, [key]: c[key].includes(email) ? c[key].filter((x) => x !== email) : [...c[key], email] }));
  const save = async () => {
    if (cfg.enabled && !confirm('Turn on archiving? From now on a copy of every matching message is kept, even if people delete theirs. Make sure your staff know (your privacy notice should mention it).')) return;
    try { setCfg({ ...cfg, ...(await api.put(`/api/admin/orgs/${org.id}/archive`, cfg)) }); toast(cfg.enabled ? 'Archiving is on' : 'Archiving is off'); } catch (e) { toast(e.message, { error: true }); }
  };
  return (
    <div className="settings-section">
      <p className="muted small">Keep a copy of email for records, disputes or regulations (legal hold).
        Copies go to a separate archive mailbox that only the people you choose can read. Nobody can delete from it, not even admins.
        Archiving starts from the moment you turn it on. Older mail isn't copied.</p>
      <label className="check"><input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /> <b>Archive email</b>{cfg.since && cfg.enabled ? <span className="muted small"> (since {fmtDate(new Date(cfg.since).toISOString())})</span> : ''}</label>
      {cfg.enabled && (
        <>
          <p className="small"><b>Whose email?</b></p>
          <label className="check"><input type="radio" checked={cfg.scope === 'all'} onChange={() => setCfg({ ...cfg, scope: 'all' })} /> Everyone in the business ({domains.map((x) => `@${x}`).join(', ')})</label>
          <label className="check"><input type="radio" checked={cfg.scope === 'people'} onChange={() => setCfg({ ...cfg, scope: 'people' })} /> Only these people (legal hold)</label>
          {cfg.scope === 'people' && people.map((p) => <label key={p.email} className="check small" style={{ marginLeft: 22 }}><input type="checkbox" checked={cfg.people.includes(p.email)} onChange={() => toggle('people', p.email)} /> {p.name || p.email} <span className="muted">{p.email}</span></label>)}
        </>
      )}
      {cfg.enabled && (
        <div className="card" style={{ margin: '12px 0', display: 'grid', gap: 8 }}>
          <b>Retention</b>
          <label className="row-field">Keep archived email for <select value={cfg.keepYears || 0} onChange={(e) => setCfg({ ...cfg, keepYears: Number(e.target.value) })}>
            <option value={0}>Forever</option>{[1, 2, 3, 5, 7, 10].map((y) => <option key={y} value={y}>{y} {y === 1 ? 'year' : 'years'}</option>)}</select></label>
          <p className="muted small">Older archived email is deleted automatically once a day. Many businesses keep 7 years for tax and legal records; check what applies to you.</p>
          <label className="check"><input type="checkbox" checked={!!cfg.legalHold} onChange={(e) => setCfg({ ...cfg, legalHold: e.target.checked })} /> <b>Legal hold</b>: keep everything, delete nothing{cfg.legalHold && cfg.legalHoldSince ? <span className="muted small"> (since {fmtDate(new Date(cfg.legalHoldSince).toISOString())})</span> : ''}</label>
          <p className="muted small">Turn this on when you expect a lawsuit, audit or investigation. It pauses the retention period until you turn it off.</p>
        </div>
      )}
      <p className="small"><b>Who can read the archive?</b> It shows up in their folder list, read-only.</p>
      {people.map((p) => <label key={p.email} className="check small"><input type="checkbox" checked={cfg.viewers.includes(p.email)} onChange={() => toggle('viewers', p.email)} /> {p.name || p.email} <span className="muted">{p.email}</span></label>)}
      <div className="actions"><button className="btn primary" onClick={save}>Save</button></div>
    </div>
  );
}
