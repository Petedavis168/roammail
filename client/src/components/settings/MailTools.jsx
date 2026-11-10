import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { folderLabel, fmtDate } from '../../util.js';
import { t } from '../../i18n.js';

const OOO_PRESETS = [
  ['Vacation', 'Out of office', 'Thanks for your email. I’m on vacation until {back} with limited access to email.{cover}\n\nI’ll reply when I’m back.'],
  ['Conference / travel', 'Travelling', 'Thanks for your email. I’m travelling until {back} and will be slow to reply.{cover}'],
  ['Sick day', 'Out sick', 'Thanks for your email. I’m out sick today and will reply as soon as I can.{cover}'],
  ['Parental leave', 'On leave', 'Thanks for your email. I’m on parental leave until {back}.{cover}'],
  ['Holiday closure', 'Our office is closed', 'Thanks for your email. Our office is closed for the holidays until {back}. We’ll reply as soon as we’re back.'],
];
const fmtDay = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : '');
const addDay = (d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

export function AutoReply({ me }) {
  const toast = useToast();
  const [v, setV] = useState(null);
  const [saving, setSaving] = useState(false);
  const isBiz = me.orgDomains?.length > 0;
  useEffect(() => { api.get('/api/vacation').then((x) => setV({ ...x, split: !!x.internalMessage })).catch((e) => toast(e.message, { error: true })); }, []);
  if (!v) return <div className="spinner" />;
  const set = (k, val) => setV((x) => ({ ...x, [k]: val }));
  const save = async (next) => {
    setSaving(true);
    try {
      const r = await api.put('/api/vacation', { ...next, internalMessage: next.split ? next.internalMessage : '' });
      setV({ ...r, split: !!r.internalMessage });
      window.dispatchEvent(new CustomEvent('roammail:ooo', { detail: r }));
      toast(r.enabled ? (r.activeNow ? t('Out of office is on') : t('Out of office is scheduled')) : t('Out of office is off'));
    } catch (e) { toast(e.message, { error: true }); }
    setSaving(false);
  };
  const usePreset = ([, subject, msg]) => {
    const cover = v.cover ? `\n\nFor anything urgent, please contact ${v.coverName || v.cover}${v.coverName ? ` (${v.cover})` : ''}.` : '';
    setV((x) => ({ ...x, subject, message: msg.replace('{back}', fmtDay(x.end) || 'I return').replace('{cover}', cover) }));
  };
  const addToCalendar = async () => {
    if (!v.start) return toast(t('Pick a start date first'), { error: true });
    try {
      const cal = (await api.get('/api/calendars'))[0]?.href;
      if (!cal) throw new Error(t('No calendar found'));
      await api.post('/api/calendar/events', { calendar: cal, title: t('Out of office'), allDay: true, start: v.start, end: addDay(v.end || v.start), sendInvites: false, busy: true });
      toast(t('Added to your calendar'));
    } catch (e) { toast(e.message, { error: true }); }
  };
  const status = !v.enabled ? null : v.activeNow ? <span className="pill ok">{t('On now')}{v.end ? ` · ${t('until')} ${fmtDay(v.end)}` : ''}</span>
    : <span className="pill warn">{t('Scheduled')} · {fmtDay(v.start)}{v.end ? ` – ${fmtDay(v.end)}` : ''}</span>;

  return (
    <div className="settings-section ooo">
      <div className="ooo-head">
        <label className="switch big"><input type="checkbox" checked={v.enabled} onChange={(e) => set('enabled', e.target.checked)} aria-label={t('Out of office')} /></label>
        <div><b>{t('Out of office')}</b> {status}<div className="muted small">{t('Automatic replies while you’re away. Each person gets one reply a day; newsletters and mailing lists never get one.')}</div></div>
      </div>

      <div className={`form ${v.enabled ? '' : 'disabled'}`}>
        <div className="card">
          <b>{t('When')}</b>
          <div className="two-col">
            <label>{t('First day away')}<input type="date" value={v.start} onChange={(e) => set('start', e.target.value)} /></label>
            <label>{t('Last day away')}<input type="date" value={v.end} min={v.start || undefined} onChange={(e) => set('end', e.target.value)} /></label>
          </div>
          <div className="muted small">{t('Leave both empty to turn it on now until you turn it off. It switches itself off after the last day.')}</div>
          {v.start && <button className="link" type="button" onClick={addToCalendar}><Icon name="calendar" size={14} /> {t('Block these days in my calendar')}</button>}
        </div>

        {isBiz && (
          <div className="card">
            <b>{t('Who covers for me')}</b>
            <div className="two-col">
              <label>{t('Name')}<input value={v.coverName} placeholder={t('e.g. Jordan Smith')} onChange={(e) => set('coverName', e.target.value)} /></label>
              <label>{t('Email')}<input type="email" value={v.cover} placeholder={`name@${me.email.split('@')[1]}`} onChange={(e) => set('cover', e.target.value)} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={v.forwardToCover} disabled={!v.cover} onChange={(e) => set('forwardToCover', e.target.checked)} /> {t('Send them a copy of my email while I’m away (not newsletters)')}</label>
            <label className="check"><input type="checkbox" checked={v.showColleagues} onChange={(e) => set('showColleagues', e.target.checked)} /> {t('Let colleagues see I’m away when they write to me')}</label>
          </div>
        )}

        <div className="card">
          <div className="ooo-msg-head"><b>{t('Message')}</b>
            <div className="chips">{OOO_PRESETS.map((p) => <button type="button" key={p[0]} className="chip" onClick={() => usePreset(p)}>{t(p[0])}</button>)}</div>
          </div>
          <label>{t('Subject')}<input value={v.subject} onChange={(e) => set('subject', e.target.value)} /></label>
          {isBiz && (
            <div className="seg ooo-seg">
              <button type="button" className={!v.split ? 'on' : ''} onClick={() => set('split', false)}>{t('Same reply for everyone')}</button>
              <button type="button" className={v.split ? 'on' : ''} onClick={() => set('split', true)}>{t('Different reply for my company')}</button>
            </div>
          )}
          {isBiz && v.split && <label>{t('Reply to people in my company')}<textarea rows={4} value={v.internalMessage} placeholder={t('Off until Monday — Jordan has my projects. Ping me on my phone if it’s on fire.')} onChange={(e) => set('internalMessage', e.target.value)} /></label>}
          {!(isBiz && v.onlyOrg && v.split) && <label>{isBiz && v.split ? t('Reply to everyone else') : t('Reply')}<textarea rows={6} value={v.message} placeholder={t('Thanks for your email. I’m out of the office until Monday with limited access to email.')} onChange={(e) => set('message', e.target.value)} /></label>}
          {isBiz && <label className="check"><input type="checkbox" checked={v.onlyOrg} onChange={(e) => set('onlyOrg', e.target.checked)} /> {t('Only reply to people in my company')}</label>}
        </div>
      </div>
      <div className="actions"><button className="btn primary" disabled={saving} onClick={() => save(v)}>{saving ? t('Saving…') : t('Save')}</button>
        {v.enabled && <button className="btn" disabled={saving} onClick={() => save({ ...v, enabled: false })}>{t('Turn off now')}</button>}</div>
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
  const save = async (next) => { try { setRules(await api.put('/api/rules', { rules: next })); toast(t("Rules saved")); return true; } catch (e) { toast(e.message, { error: true }); } };
  const selectable = folders.filter((f) => !f.flags.includes('\\Noselect'));
  const describe = (r) => `If ${r.conditions.map((c) => `${FIELDS.find((f) => f[0] === c.field)?.[1].toLowerCase()} "${c.value}"`).join(r.match === 'all' ? ' and ' : ' or ')} → ${r.actions.map((a) => {
    const l = ACTIONS.find((x) => x[0] === a.type)?.[1]; return a.type === 'move' ? `move to ${a.folder}` : a.type === 'forward' ? `forward to ${a.value}` : a.type === 'category' ? `categorize ${a.value}` : l.toLowerCase();
  }).join(', ')}`;
  const blank = { id: `r${Date.now()}`, name: '', enabled: true, match: 'any', stop: true, conditions: [{ field: 'from', value: '' }], actions: [{ type: 'move', folder: selectable[0]?.path || 'INBOX' }] };

  return (
    <div className="settings-section">
      <p className="muted small">{t("Rules run on the server as mail arrives, so they work in every app, even when this page is closed.")}</p>
      {rules.length === 0 && !edit && <div className="empty-card small">{t("No rules yet.")}</div>}
      {rules.map((r, i) => edit?.id === r.id ? null : (
        <div key={r.id} className="rule-item">
          <label className="switch"><input type="checkbox" checked={r.enabled} onChange={(e) => save(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} /></label>
          <div className="rule-text"><b>{r.name || (r.blocked ? `Blocked: ${r.blocked}` : 'Rule')}</b><small className="muted">{describe(r)}</small></div>
          {!r.blocked && <button className="btn sm" onClick={() => setEdit(JSON.parse(JSON.stringify(r)))}>{t("Edit")}</button>}
          <button className="icon-btn" onClick={() => save(rules.filter((x) => x.id !== r.id))} title={r.blocked ? 'Unblock' : 'Delete'}><Icon name="trash" size={16} /></button>
        </div>
      ))}
      {edit ? (
        <div className="card rule-edit">
          <label>{t("Name")}<input value={edit.name} placeholder={t("e.g. Newsletters")} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <div className="rule-row"><b>{t("When a message arrives and")}</b>
            <select value={edit.match} onChange={(e) => setEdit({ ...edit, match: e.target.value })}><option value="any">any</option><option value="all">all</option></select>{' '}{t("of these are true:")}</div>
          {edit.conditions.map((c, i) => (
            <div className="rule-row" key={i}>
              <select value={c.field} onChange={(e) => { const cs = [...edit.conditions]; cs[i] = { ...c, field: e.target.value }; setEdit({ ...edit, conditions: cs }); }}>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input value={c.value} placeholder={t("text or address")} onChange={(e) => { const cs = [...edit.conditions]; cs[i] = { ...c, value: e.target.value }; setEdit({ ...edit, conditions: cs }); }} />
              {edit.conditions.length > 1 && <button className="icon-btn" onClick={() => setEdit({ ...edit, conditions: edit.conditions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>}
            </div>
          ))}
          <button className="link" onClick={() => setEdit({ ...edit, conditions: [...edit.conditions, { field: 'subject', value: '' }] })}>{t("+ Add condition")}</button>
          <div className="rule-row"><b>{t("Do this:")}</b></div>
          {edit.actions.map((a, i) => (
            <div className="rule-row" key={i}>
              <select value={a.type} onChange={(e) => { const as = [...edit.actions]; as[i] = { type: e.target.value, folder: a.folder, value: '' }; setEdit({ ...edit, actions: as }); }}>
                {ACTIONS.filter(([k]) => k !== 'forward' || me.orgDomains?.length).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              {a.type === 'move' && <select value={a.folder} onChange={(e) => { const as = [...edit.actions]; as[i] = { ...a, folder: e.target.value }; setEdit({ ...edit, actions: as }); }}>
                {selectable.map((f) => <option key={f.path} value={f.path}>{folderLabel(f)}</option>)}</select>}
              {a.type === 'forward' && <input type="email" placeholder="name@example.com" value={a.value} onChange={(e) => { const as = [...edit.actions]; as[i] = { ...a, value: e.target.value }; setEdit({ ...edit, actions: as }); }} />}
              {a.type === 'category' && <select value={a.value} onChange={(e) => { const as = [...edit.actions]; as[i] = { ...a, value: e.target.value }; setEdit({ ...edit, actions: as }); }}>
                <option value="">{t("Choose…")}</option>{categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select>}
              {edit.actions.length > 1 && <button className="icon-btn" onClick={() => setEdit({ ...edit, actions: edit.actions.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>}
            </div>
          ))}
          <button className="link" onClick={() => setEdit({ ...edit, actions: [...edit.actions, { type: 'read' }] })}>{t("+ Add action")}</button>
          <label className="check"><input type="checkbox" checked={edit.stop} onChange={(e) => setEdit({ ...edit, stop: e.target.checked })} />{' '}{t("Stop processing more rules")}</label>
          <div className="step-actions">
            <button className="btn" onClick={() => setEdit(null)}>{t("Cancel")}</button>
            <button className="btn primary" onClick={async () => {
              if (!edit.conditions.some((c) => c.value.trim())) return toast(t("Add at least one condition"), { error: true });
              const exists = rules.some((r) => r.id === edit.id);
              if (await save(exists ? rules.map((r) => (r.id === edit.id ? edit : r)) : [...rules, edit])) setEdit(null);
            }}>{t("Save rule")}</button>
          </div>
        </div>
      ) : <button className="btn" onClick={() => setEdit(blank)}><Icon name="plus" size={16} />{' '}{t("New rule")}</button>}
      <ServerFilters />
    </div>
  );
}

function ServerFilters() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const [add, setAdd] = useState(null);
  const load = () => api.get('/api/filters/server').then(setList).catch(() => setList([]));
  useEffect(() => { if (open) load(); }, [open]);
  const run = async (fn, msg) => { try { await fn(); toast(msg); load(); return true; } catch (e) { toast(e.message, { error: true }); } };
  return (
    <details className="adv" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{t("Advanced: all mailcow server filters (Sieve)")}</summary>
      <p className="muted small">{t("Every filter stored for your mailbox on the mail server, including ones made in other tools. Order on the server: mailcow's global filters →")}{' '}<b>pre-filters</b> → <b>post-filters</b>{' '}{t("→ mailcow moves spam to Junk. Only one filter of each type can be active at a time.")}</p>
      {list?.map((f) => (
        <div key={f.id} className="rule-item col">
          <div className="rule-row">
            <label className="switch"><input type="checkbox" checked={f.active} onChange={(e) => run(() => api.patch('/api/filters/server', { id: f.id, active: e.target.checked }), e.target.checked ? 'Filter activated' : 'Filter turned off')} /></label>
            <b>{f.managed ? 'Rules & automatic replies (managed here)' : f.desc}</b><span className="pill">{f.type}</span><div className="spacer" />
            {!f.managed && <button className="icon-btn" onClick={() => confirm(`Delete filter "${f.desc}"?`) && run(() => api.del('/api/filters/server', { id: f.id }), 'Filter deleted')}><Icon name="trash" size={16} /></button>}
          </div>
          <pre className="sieve">{f.script}</pre>
        </div>
      ))}
      {list?.length === 0 && <div className="muted small">{t("No server filters yet.")}</div>}
      {add ? (
        <div className="card form">
          <label>{t("Name")}<input value={add.desc} onChange={(e) => setAdd({ ...add, desc: e.target.value })} /></label>
          <label>{t("Type")}<select value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value })}><option value="prefilter">{t("Pre-filter")}</option><option value="postfilter">{t("Post-filter")}</option></select></label>
          <label>{t("Sieve script")}<textarea rows={8} className="mono" value={add.script} onChange={(e) => setAdd({ ...add, script: e.target.value })} /></label>
          <small className="muted">{t("Saving activates it and turns off any other active")}{' '}{add.type}{t(". The server checks the script and refuses invalid ones.")}</small>
          <div className="step-actions"><button className="btn" onClick={() => setAdd(null)}>{t("Cancel")}</button>
            <button className="btn primary" onClick={async () => (await run(() => api.post('/api/filters/server', add), 'Filter saved')) && setAdd(null)}>{t("Save filter")}</button></div>
        </div>
      ) : <button className="btn sm" onClick={() => setAdd({ desc: '', type: 'postfilter', script: 'require ["fileinto"];\n\nif header :contains "subject" "[newsletter]" {\n  fileinto "Newsletters";\n}\n' })}><Icon name="plus" size={14} />{' '}{t("Add raw Sieve filter")}</button>}
    </details>
  );
}

const IMPORT_MSG = { started: 'Signed in to Microsoft. Your Outlook mail is being copied now.', cancelled: 'Microsoft sign-in was cancelled.', expired: 'That sign-in took too long. Please try again.', failed: "Microsoft sign-in didn't work. Try again, or upload an export file instead.", 'no-email': "Microsoft didn't tell us which mailbox to import." };
const when = (v) => (v ? fmtDate(new Date(typeof v === 'number' ? v : String(v).replace(' ', 'T')).toISOString()) : '');

function ImportRow({ r, onChange }) {
  const pct = r.found ? Math.min(100, Math.round((100 * (r.copied || 0)) / r.found)) : null;
  const state = r.status === 'failed' ? `Problem: ${r.error || 'the import stopped'}`
    : r.status === 'finished' ? (r.kind === 'upload' ? `Done: ${r.copied} messages copied` : `Finished. Copying stopped on ${when(r.stopsAt)}.`)
    : r.status === 'paused' ? 'Paused'
    : r.kind === 'upload' ? `Copying… ${r.copied || 0} messages so far`
    : r.kind === 'oauth' ? (r.error ? `Problem: ${r.error}` : `${r.copied || 0} of about ${r.found ?? '?'} messages copied`)
    : r.running ? 'Copying now…' : r.lastRun ? `Last copied ${when(r.lastRun)}${r.success === false ? ' · problem: check the app password' : ''}` : `Starting within 20 minutes · about ${r.found ?? '?'} messages`;
  return (
    <div className="import-row">
      <Icon name={r.status === 'failed' ? 'alert' : r.status === 'finished' ? 'check' : 'import'} />
      <div className="rule-text">
        <b>{r.user}</b> <span className="muted small">{r.label}</span>
        <small className="muted">{state}</small>
        {pct !== null && r.status === 'active' && r.kind !== 'syncjob' && <div className="meter"><div style={{ width: `${pct}%` }} /></div>}
        {r.status === 'active' && r.kind !== 'upload' && <small className="muted">{t("Keeps copying new mail until")}{' '}{when(r.stopsAt)}{t(", so nothing is lost while you switch.")}</small>}
      </div>
      {r.kind !== 'upload' && ['active', 'paused'].includes(r.status) && <button className="btn sm" onClick={async () => { await api.patch('/api/imports', { recordId: r.id, active: r.status !== 'active' }); onChange(); }}>{r.status === 'active' ? 'Pause' : 'Resume'}</button>}
      {['active', 'paused'].includes(r.status) && r.kind !== 'upload' && <button className="icon-btn" title={t("Stop")} aria-label={t("Stop import")} onClick={async () => { if (confirm(t("Stop importing from this account? Mail already copied stays."))) { await api.del('/api/imports', { recordId: r.id }); onChange(); } }}><Icon name="close" size={16} /></button>}
    </div>
  );
}

function ReadyToSwitch({ me }) {
  const business = (me?.orgs || []).length > 0;
  return (
    <div className="callout ok">
      <Icon name="check" size={16} />
      <div><b>{t("Ready to switch")}</b>
        {business
          ? <small>{t("Your mail is here. Now point your domain to Roammail: in")}{' '}<b>{t("Admin → Domains")}</b>{t(", copy the MX record into your DNS and press")}{' '}<b>{t("Check records")}</b>{t(". New mail arrives here within an hour; the import keeps catching anything sent to the old account meanwhile.")}</small>
          : <small>{t("Your mail is here. Tell people your new address, and in your old account turn on forwarding to it. The import keeps catching anything that still arrives there for the next few days.")}</small>}
      </div>
    </div>
  );
}

export function ImportMail({ me, importMsg }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [f, setF] = useState({ provider: 'gmail', user: '', password: '', host: '' });
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () => api.get('/api/imports').then(setD).catch((e) => toast(e.message, { error: true }));
  useEffect(() => {
    load(); const t = setInterval(load, 15000);
    if (importMsg && IMPORT_MSG[importMsg]) toast(IMPORT_MSG[importMsg], { error: importMsg !== 'started' });
    return () => clearInterval(t);
  }, []);
  if (!d) return <div className="spinner" />;
  const p = d.providers[f.provider];
  const set = (k) => (e) => { setFound(null); setF({ ...f, [k]: e.target.value }); };
  const test = async () => {
    setBusy('test');
    try { const r = await api.post('/api/imports/test', f); setFound(r); } catch (err) { toast(err.message, { error: true }); } finally { setBusy(''); }
  };
  const start = async (e) => {
    e.preventDefault(); setBusy('start');
    try { await api.post('/api/imports', f); toast(t("Import started. Mail appears within 20 minutes.")); setF({ ...f, user: '', password: '' }); setFound(null); load(); }
    catch (err) { toast(err.message, { error: true }); } finally { setBusy(''); }
  };
  const upload = (url, done) => async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    setBusy(url);
    try { const r = await api.form(url, fd); toast(done(r)); load(); } catch (err) { toast(err.message, { error: true }); } finally { setBusy(''); }
  };
  const ready = d.imports.some((r) => r.readyToSwitch);
  return (
    <div className="settings-section import">
      <p className="muted small">{t("Bring your mail, folders, contacts and calendar from your old account. Mail keeps syncing for")}{' '}{d.syncDays}{' '}{t("days, so you can switch over at your own pace.")}</p>
      {ready && <ReadyToSwitch me={me} />}
      {d.imports.map((r) => <ImportRow key={r.id} r={r} onChange={load} />)}
      {d.jobs.map((j) => <ImportRow key={`j${j.id}`} r={{ id: null, user: j.user, label: j.host, kind: 'syncjob', status: j.active ? 'active' : 'paused', running: j.running, lastRun: j.lastRun, success: j.success }} onChange={load} />)}

      <h3>{t("1. Copy your email")}</h3>
      <div className="provider-pick">
        {Object.entries(d.providers).map(([k, v]) => <button type="button" key={k} className={`chip ${f.provider === k ? 'on' : ''}`} onClick={() => { setFound(null); setF({ ...f, provider: k }); }}>{v.label}</button>)}
      </div>
      {p.oauth ? (
        <div className="card form">
          <div className="callout info"><Icon name="lock" size={16} /><small>{p.help}</small></div>
          {p.oauthReady
            ? <button className="btn primary" disabled={!!busy} onClick={async () => { setBusy('ms'); try { location.assign((await api.get('/api/imports/outlook/start')).url); } catch (err) { toast(err.message, { error: true }); setBusy(''); } }}>{t("Sign in with Microsoft")}</button>
            : <small className="muted">{t("Microsoft sign-in isn't switched on for this server yet. Use the file upload below for now.")}</small>}
        </div>
      ) : (
        <form className="card form" onSubmit={start}>
          {f.provider === 'other' && <label>{t("IMAP server")}<input value={f.host} placeholder="imap.example.com" onChange={set('host')} required /></label>}
          <label>{t("Old email address")}<input type="email" value={f.user} onChange={set('user')} required autoComplete="off" /></label>
          <label>{f.provider === 'other' ? 'Password' : 'App password'}<input type="password" value={f.password} onChange={set('password')} required autoComplete="new-password" /></label>
          <div className="callout info"><Icon name="lock" size={16} /><small>{p.help} {p.appPasswordUrl && <a href={p.appPasswordUrl} target="_blank" rel="noreferrer">{t("Open the app password page")}</a>}{' '}{t("An app password only allows mail access and can be revoked any time. We never see or keep your main password.")}</small></div>
          {found && <div className="callout ok"><Icon name="check" size={16} /><small>{t("Connected. Found about")}{' '}<b>{found.messages.toLocaleString()}</b>{' '}{t("messages in")}{' '}{found.folders} folders.</small></div>}
          <div className="row-btns">
            <button type="button" className="btn" disabled={!!busy || !f.user || !f.password} onClick={test}>{busy === 'test' ? 'Checking…' : 'Test connection'}</button>
            <button className="btn primary" disabled={!!busy}>{busy === 'start' ? 'Starting…' : 'Start import'}</button>
          </div>
        </form>
      )}
      <details className="card">
        <summary><b>{t("Or upload an export file")}</b> <span className="muted small">{t("(.mbox: Google Takeout, Apple Mail, Thunderbird; Outlook .pst converted to .mbox)")}</span></summary>
        <p className="muted small">{t("Messages go into a folder called")}{' '}<b>{t("Imported")}</b>{t(". Outlook desktop can't save .mbox directly: open the .pst in Thunderbird (free) with the ImportExportTools add-on and export the folders as .mbox.")}</p>
        <label className="btn">{busy === '/api/imports/upload' ? 'Uploading…' : 'Choose .mbox file'}<input type="file" accept=".mbox,.mbx,application/mbox" hidden onChange={upload('/api/imports/upload', (r) => `Uploaded. Copying into ${r.folder}…`)} /></label>
      </details>

      <h3>{t("2. Contacts and calendar")}</h3>
      <div className="row-btns left">
        <label className="btn">{busy === '/api/address-contacts/import' ? 'Importing…' : 'Import contacts (.vcf)'}<input type="file" accept=".vcf,text/vcard" hidden onChange={upload('/api/address-contacts/import', (r) => `Imported ${r.imported ?? r.count ?? ''} contacts`)} /></label>
        <label className="btn">{busy === '/api/calendar/import' ? 'Importing…' : 'Import calendar (.ics)'}<input type="file" accept=".ics,text/calendar" hidden onChange={upload('/api/calendar/import', (r) => `Imported ${r.imported} events${r.existing ? ` (${r.existing} were already here)` : ''}`)} /></label>
      </div>
      <p className="muted small">{t("Gmail: contacts.google.com → Export → vCard; calendar.google.com → Settings → Import & export → Export. Outlook: People → Manage → Export contacts; Calendar → Shared calendars → Publish → ICS.")}</p>
    </div>
  );
}
