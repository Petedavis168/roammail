import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { folderLabel, fmtDate } from '../../util.js';

export function AutoReply({ me }) {
  const toast = useToast();
  const [v, setV] = useState(null);
  useEffect(() => { api.get('/api/vacation').then(setV); }, []);
  if (!v) return <div className="spinner" />;
  const save = async (next) => {
    try { setV(await api.put('/api/vacation', next)); toast(next.enabled ? 'Automatic replies are on' : 'Automatic replies are off'); } catch (e) { toast(e.message, { error: true }); }
  };
  return (
    <div className="settings-section">
      <p className="muted small">Let people know you're away. Each sender gets one reply per day. Mailing lists don't get replies.</p>
      <label className="check big"><input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Send automatic replies</label>
      <div className={`form ${v.enabled ? '' : 'disabled'}`}>
        <div className="two-col">
          <label>Start (optional)<input type="date" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} /></label>
          <label>End (optional)<input type="date" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} /></label>
        </div>
        <label>Subject<input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} /></label>
        <label>Message<textarea rows={6} value={v.message} placeholder={'Thanks for your email. I\'m out of the office until Monday with limited access to email.\n\nFor urgent matters please contact ...'} onChange={(e) => setV({ ...v, message: e.target.value })} /></label>
        {me.orgDomains?.length > 0 && <label className="check"><input type="checkbox" checked={v.onlyOrg} onChange={(e) => setV({ ...v, onlyOrg: e.target.checked })} /> Only reply to people in my organization</label>}
      </div>
      <div><button className="btn primary" onClick={() => save(v)}>Save</button></div>
    </div>
  );
}

const FIELDS = [['from', 'From contains'], ['to', 'To / Cc contains'], ['subject', 'Subject contains']];
const ACTIONS = [['move', 'Move to folder'], ['read', 'Mark as read'], ['flag', 'Flag it'], ['category', 'Categorize'], ['forward', 'Forward to'], ['junk', 'Move to Junk'], ['trash', 'Delete']];

export function Rules({ folders, categories, me }) {
  const toast = useToast();
  const [rules, setRules] = useState(null);
  const [edit, setEdit] = useState(null);
  useEffect(() => { api.get('/api/rules').then(setRules); }, []);
  if (!rules) return <div className="spinner" />;
  const save = async (next) => { try { setRules(await api.put('/api/rules', { rules: next })); toast('Rules saved'); return true; } catch (e) { toast(e.message, { error: true }); } };
  const selectable = folders.filter((f) => !f.flags.includes('\\Noselect'));
  const describe = (r) => `If ${r.conditions.map((c) => `${FIELDS.find((f) => f[0] === c.field)?.[1].toLowerCase()} "${c.value}"`).join(r.match === 'all' ? ' and ' : ' or ')} → ${r.actions.map((a) => {
    const l = ACTIONS.find((x) => x[0] === a.type)?.[1]; return a.type === 'move' ? `move to ${a.folder}` : a.type === 'forward' ? `forward to ${a.value}` : a.type === 'category' ? `categorize ${a.value}` : l.toLowerCase();
  }).join(', ')}`;
  const blank = { id: `r${Date.now()}`, name: '', enabled: true, match: 'any', stop: true, conditions: [{ field: 'from', value: '' }], actions: [{ type: 'move', folder: selectable[0]?.path || 'INBOX' }] };

  return (
    <div className="settings-section">
      <p className="muted small">Rules run on the server as mail arrives, so they work in every app, even when this page is closed.</p>
      {rules.length === 0 && !edit && <div className="empty-card small">No rules yet.</div>}
      {rules.map((r, i) => edit?.id === r.id ? null : (
        <div key={r.id} className="rule-item">
          <label className="switch"><input type="checkbox" checked={r.enabled} onChange={(e) => save(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} /></label>
          <div className="rule-text"><b>{r.name || (r.blocked ? `Blocked: ${r.blocked}` : 'Rule')}</b><small className="muted">{describe(r)}</small></div>
          {!r.blocked && <button className="btn sm" onClick={() => setEdit(JSON.parse(JSON.stringify(r)))}>Edit</button>}
          <button className="icon-btn" onClick={() => save(rules.filter((x) => x.id !== r.id))} title={r.blocked ? 'Unblock' : 'Delete'}><Icon name="trash" size={16} /></button>
        </div>
      ))}
      {edit ? (
        <div className="card rule-edit">
          <label>Name<input value={edit.name} placeholder="e.g. Newsletters" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <div className="rule-row"><b>When a message arrives and</b>
            <select value={edit.match} onChange={(e) => setEdit({ ...edit, match: e.target.value })}><option value="any">any</option><option value="all">all</option></select> of these are true:</div>
          {edit.conditions.map((c, i) => (
            <div className="rule-row" key={i}>
              <select value={c.field} onChange={(e) => { const cs = [...edit.conditions]; cs[i] = { ...c, field: e.target.value }; setEdit({ ...edit, conditions: cs }); }}>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input value={c.value} placeholder="text or address" onChange={(e) => { const cs = [...edit.conditions]; cs[i] = { ...c, value: e.target.value }; setEdit({ ...edit, conditions: cs }); }} />
              {edit.conditions.length > 1 && <button className="icon-btn" onClick={() => setEdit({ ...edit, conditions: edit.conditions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>}
            </div>
          ))}
          <button className="link" onClick={() => setEdit({ ...edit, conditions: [...edit.conditions, { field: 'subject', value: '' }] })}>+ Add condition</button>
          <div className="rule-row"><b>Do this:</b></div>
          {edit.actions.map((a, i) => (
            <div className="rule-row" key={i}>
              <select value={a.type} onChange={(e) => { const as = [...edit.actions]; as[i] = { type: e.target.value, folder: a.folder, value: '' }; setEdit({ ...edit, actions: as }); }}>
                {ACTIONS.filter(([k]) => k !== 'forward' || me.orgDomains?.length).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              {a.type === 'move' && <select value={a.folder} onChange={(e) => { const as = [...edit.actions]; as[i] = { ...a, folder: e.target.value }; setEdit({ ...edit, actions: as }); }}>
                {selectable.map((f) => <option key={f.path} value={f.path}>{folderLabel(f)}</option>)}</select>}
              {a.type === 'forward' && <input type="email" placeholder="name@example.com" value={a.value} onChange={(e) => { const as = [...edit.actions]; as[i] = { ...a, value: e.target.value }; setEdit({ ...edit, actions: as }); }} />}
              {a.type === 'category' && <select value={a.value} onChange={(e) => { const as = [...edit.actions]; as[i] = { ...a, value: e.target.value }; setEdit({ ...edit, actions: as }); }}>
                <option value="">Choose…</option>{categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select>}
              {edit.actions.length > 1 && <button className="icon-btn" onClick={() => setEdit({ ...edit, actions: edit.actions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>}
            </div>
          ))}
          <button className="link" onClick={() => setEdit({ ...edit, actions: [...edit.actions, { type: 'read' }] })}>+ Add action</button>
          <label className="check"><input type="checkbox" checked={edit.stop} onChange={(e) => setEdit({ ...edit, stop: e.target.checked })} /> Stop processing more rules</label>
          <div className="step-actions">
            <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn primary" onClick={async () => {
              if (!edit.conditions.some((c) => c.value.trim())) return toast('Add at least one condition', { error: true });
              const exists = rules.some((r) => r.id === edit.id);
              if (await save(exists ? rules.map((r) => (r.id === edit.id ? edit : r)) : [...rules, edit])) setEdit(null);
            }}>Save rule</button>
          </div>
        </div>
      ) : <button className="btn" onClick={() => setEdit(blank)}><Icon name="plus" size={16} /> New rule</button>}
    </div>
  );
}

export function ImportMail() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [f, setF] = useState({ provider: 'gmail', user: '', password: '', host: '' });
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/imports').then(setD).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  if (!d) return <div className="spinner" />;
  const p = d.providers[f.provider];
  return (
    <div className="settings-section">
      <p className="muted small">Copy all your email and folders from your old account. It keeps checking for new mail every 20 minutes until you stop it, so you can switch over gradually.</p>
      {d.jobs.map((j) => (
        <div key={j.id} className="rule-item">
          <Icon name="import" />
          <div className="rule-text"><b>{j.user}</b><small className="muted">{j.host} · {j.running ? 'Importing now…' : j.lastRun ? `Last run ${fmtDate(new Date(j.lastRun.replace(' ', 'T')).toISOString())}${j.success === false ? ' · problem: check the password' : ''}` : 'Waiting to start (within 20 minutes)'}</small></div>
          <button className="btn sm" onClick={async () => { await api.patch('/api/imports', { id: j.id, active: !j.active }); load(); }}>{j.active ? 'Pause' : 'Resume'}</button>
          <button className="icon-btn" title="Stop & remove" onClick={async () => { if (confirm('Stop importing from this account? Mail already copied stays.')) { await api.del('/api/imports', { id: j.id }); load(); } }}><Icon name="trash" size={16} /></button>
        </div>
      ))}
      <form className="card form" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true);
        try { await api.post('/api/imports', f); toast('Import started. Your mail will start appearing within 20 minutes.'); setF({ ...f, user: '', password: '' }); load(); }
        catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
      }}>
        <div className="provider-pick">
          {Object.entries(d.providers).map(([k, v]) => <button type="button" key={k} className={`chip ${f.provider === k ? 'on' : ''}`} onClick={() => setF({ ...f, provider: k })}>{v.label}</button>)}
        </div>
        {f.provider === 'other' && <label>IMAP server<input value={f.host} placeholder="imap.example.com" onChange={(e) => setF({ ...f, host: e.target.value })} required /></label>}
        <label>Old email address<input type="email" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} required /></label>
        <label>{f.provider === 'other' ? 'Password' : 'App password'}<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete="off" /></label>
        <div className="callout info"><Icon name="lock" size={16} /><small>{p.help} An app password only allows mail access and can be revoked any time. Your main password is never needed.</small></div>
        <button className="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Start import'}</button>
      </form>
    </div>
  );
}
