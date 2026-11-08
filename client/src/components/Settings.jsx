import { useEffect, useState } from 'react';
import { Icon } from '../icons.jsx';
import Signatures from './settings/Signatures.jsx';
import Templates from './settings/Templates.jsx';
import { pushState, enablePush, disablePush } from '../push.js';

function PushToggle() {
  const [state, setState] = useState('…');
  const [err, setErr] = useState('');
  useEffect(() => { pushState().then(setState); }, []);
  if (state === 'unsupported') return <p className="muted small">This browser can't show notifications when Roammail is closed. On iPhone, add Roammail to your Home Screen first (Share → Add to Home Screen).</p>;
  return (
    <div className="small" style={{ margin: '6px 0' }}>
      <label className="check"><input type="checkbox" checked={state === 'on'} disabled={state === 'blocked'} onChange={async (e) => {
        setErr('');
        try { if (e.target.checked) await enablePush(); else await disablePush(); setState(await pushState()); } catch (x) { setErr(x.message); setState(await pushState()); }
      }} /> Notify me on this device even when Roammail is closed</label>
      {state === 'on' && <PreviewToggle />}
      {state === 'blocked' && <div className="muted">Notifications are blocked for this site in your browser settings.</div>}
      {err && <div className="bad">{err}</div>}
    </div>
  );
}
function PreviewToggle() {
  const [on, setOn] = useState(null);
  useEffect(() => { api.get('/api/push/preview').then((r) => setOn(r.on)).catch(() => {}); }, []);
  if (on === null) return null;
  return <label className="check" style={{ marginLeft: 22 }}><input type="checkbox" checked={on} onChange={async (e) => { const v = e.target.checked; setOn(v); await api.put('/api/push/preview', { on: v }).catch(() => setOn(!v)); }} /> Show sender and subject (turn off to show only "New mail")</label>;
}
import { aiStatus, setAiEnabled, aiConsentText } from '../ai.js';
function AiSetting() {
  const [st, setSt] = useState(null);
  useEffect(() => { aiStatus(true).then(setSt); }, []);
  if (!st?.available) return null;
  return (
    <>
      <h3>AI help</h3>
      {st.blockedByOrg ? <p className="muted small">Your company has turned off AI help.</p> : (
        <>
          <label className="check"><input type="checkbox" checked={!!st.enabled} onChange={async (e) => setSt(await setAiEnabled(e.target.checked))} /> Summarise conversations, suggest replies and find mail that needs a reply</label>
          <p className="muted small">{aiConsentText}{st.limit != null ? ` Free accounts get ${st.limit} AI requests a month (${Math.max(0, st.limit - st.used)} left this month).` : ''}</p>
        </>
      )}
    </>
  );
}
import Security from './settings/Security.jsx';
import { AutoReply, Rules, ImportMail } from './settings/MailTools.jsx';
import SpamSettings from './settings/Spam.jsx';
import Privacy from './settings/Privacy.jsx';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';

function General({ prefs, setPrefs, me }) {
  const set = (k) => (e) => setPrefs({ [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="settings-section">
      <h3>Layout</h3>
      <label className="row-field">Reading pane
        <select value={prefs.readingPane} onChange={set('readingPane')}>
          <option value="right">Show on the right</option><option value="bottom">Show on the bottom</option><option value="off">Hidden (open messages full width)</option>
        </select></label>
      <label className="row-field">Density
        <select value={prefs.density} onChange={set('density')}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
      <label className="check"><input type="checkbox" checked={prefs.conversation} onChange={set('conversation')} /> Conversation view (group replies together)</label>
      <h3>Writing</h3>
      <label className="row-field">Your name (shown to recipients)<input value={prefs.displayName} placeholder={me.name || me.email} onChange={set('displayName')} /></label>
      <label className="row-field">Undo send
        <select value={prefs.undoSeconds} onChange={set('undoSeconds')}>
          {[0, 5, 10, 20, 30].map((s) => <option key={s} value={s}>{s ? `${s} seconds` : 'Off'}</option>)}
        </select></label>
      <h3>Privacy</h3>
      <label className="row-field">External images
        <select value={prefs.showImages} onChange={set('showImages')}><option value="ask">Ask before showing</option><option value="always">Always show</option></select></label>
      {prefs.trustedSenders.length > 0 && (
        <div className="trusted">
          <small className="muted">Always show images from:</small>
          {prefs.trustedSenders.map((s) => (
            <span key={s} className="rchip">{s}<button onClick={() => setPrefs((p) => ({ trustedSenders: p.trustedSenders.filter((x) => x !== s) }))}>×</button></span>
          ))}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={prefs.notifications} onChange={set('notifications')} /> Desktop notifications for new mail</label>
      <PushToggle />
      <AiSetting />
      <h3>Categories</h3>
      {prefs.categories.map((c, i) => (
        <div key={i} className="cat-edit">
          <input type="color" aria-label={`Colour for ${c.name || 'category'}`} value={c.color} onChange={(e) => setPrefs((p) => ({ categories: p.categories.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) }))} />
          <input aria-label="Category name" value={c.name} onChange={(e) => setPrefs((p) => ({ categories: p.categories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} />
          <button className="icon-btn" aria-label={`Delete ${c.name || 'category'}`} title="Delete category" onClick={() => setPrefs((p) => ({ categories: p.categories.filter((_, j) => j !== i) }))}><Icon name="trash" size={16} /></button>
        </div>
      ))}
      <div><button className="btn" onClick={() => setPrefs((p) => ({ categories: [...p.categories, { name: 'New', color: '#038387' }] }))}><Icon name="plus" size={16} /> Add category</button></div>
    </div>
  );
}

function PhoneQr({ me }) {
  const toast = useToast();
  const [link, setLink] = useState(null);
  const [left, setLeft] = useState(0);
  const make = async () => { try { setLink(await api.post('/api/device-setup', {})); } catch (e) { toast(e.message, { error: true }); } };
  useEffect(() => {
    if (!link) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((link.expiresAt - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [link]);
  return (
    <div className="phone-setup card">
      <div className="phone-qr">
        {link && left > 0 ? <img src={link.qr} alt="Setup QR code" width="200" height="200" /> : (
          <button className="qr-placeholder" onClick={make}><Icon name="phone" size={32} /><span>Show my setup code</span></button>
        )}
      </div>
      <div className="phone-steps">
        <h3>Set up your phone in seconds</h3>
        <ol>
          <li>Click <b>Show my setup code</b>.</li>
          <li>Point your phone's camera at the code and tap the link.</li>
          <li><b>iPhone:</b> tap Install. Mail{' '}(plus calendar &amp; contacts) is set up with nothing to type.<br />
            <b>Android:</b> follow the one-screen instructions for your app.</li>
        </ol>
        {link && left > 0 && <p className="muted small">Code works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}. It contains a sign-in key, so don't share it.</p>}
        {link && left <= 0 && <p className="muted small">Code expired. <button className="link" onClick={make}>Make a new one</button></p>}
        <p className="muted small">Already on your phone? <a href={`/setup?email=${encodeURIComponent(me.email)}`} target="_blank" rel="noreferrer">Open the setup page</a></p>
      </div>
    </div>
  );
}

function Apps({ me, sigData }) {
  const toast = useToast();
  const c = me.clientSettings || {};
  const [prof, setProf] = useState({ phone: sigData?.profile?.phone || '', mobile: sigData?.profile?.mobile || '' });
  const Row = ({ l, v }) => <div className="tr two"><span className="muted">{l}</span><span className="mono">{v}</span><span /></div>;
  return (
    <div className="settings-section">
      <PhoneQr me={me} />
      <h3>Server settings</h3>
      <p className="muted small">Outlook, Apple Mail, Thunderbird and most phone apps only need your email and password. If an app asks for server settings, use these:</p>
      <div className="table">
        <Row l="Email / username" v={me.email} />
        <Row l="Incoming (IMAP)" v={`${c.imapHost} · port ${c.imapPort} · SSL/TLS`} />
        <Row l="Outgoing (SMTP)" v={`${c.smtpHost} · port ${c.smtpPort} · ${c.smtpSecure ? 'SSL/TLS' : 'STARTTLS'}`} />
        <Row l="Password" v="Your normal password" />
        {me.clientSettings?.davEnabled !== false && <Row l="Calendar & contacts" v={`https://${c.davHost || c.imapHost}/SOGo/dav/`} />}
      </div>
      <h3>Install this app</h3>
      <p className="muted small">On your phone: open this site in Safari or Chrome, tap <b>Share</b> → <b>Add to Home Screen</b>. On a computer: click the install icon in the address bar.</p>
      {sigData?.inOrg && <>
        <h3>Your contact details</h3>
        <p className="muted small">Used in your company signature. Your admin manages your name and job title.</p>
        <div className="two-col">
          <label>Phone<input value={prof.phone} onChange={(e) => setProf({ ...prof, phone: e.target.value })} /></label>
          <label>Mobile<input value={prof.mobile} onChange={(e) => setProf({ ...prof, mobile: e.target.value })} /></label>
        </div>
        <div><button className="btn" onClick={() => api.patch('/api/profile', prof).then(() => toast('Saved')).catch((e) => toast(e.message, { error: true }))}>Save</button></div>
      </>}
    </div>
  );
}

const TABS = [
  ['general', 'General', 'settings'], ['signatures', 'Signatures', 'pen'], ['templates', 'Templates', 'mail'], ['security', 'Security', 'lock'],
  ['autoreply', 'Automatic replies', 'reply'], ['junk', 'Junk & spam', 'junk'], ['rules', 'Rules', 'filter'], ['import', 'Import mail', 'import'], ['apps', 'Phone & apps', 'phone'], ['privacy', 'Privacy', 'shield'],
];

export default function SettingsPanel({ prefs, setPrefs, me, folders, sigData, reloadSigs, onClose, initialTab = 'general', importMsg }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <nav className="settings-nav">
          <h2>Settings</h2>
          {TABS.map(([k, l, i]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon name={i} size={16} /> {l}</button>)}
        </nav>
        <div className="settings-body">
          <div className="drawer-head"><h2>{TABS.find((t) => t[0] === tab)[1]}</h2><button className="icon-btn" aria-label="Close settings" title="Close" onClick={onClose}><Icon name="close" /></button></div>
          <div className="drawer-body">
            {tab === 'general' && <General prefs={prefs} setPrefs={setPrefs} me={me} />}
            {tab === 'signatures' && <Signatures sigData={sigData} reloadSigs={reloadSigs} prefs={prefs} setPrefs={setPrefs} />}
            {tab === 'templates' && <Templates />}
            {tab === 'security' && <Security me={me} />}
            {tab === 'autoreply' && <AutoReply me={me} />}
            {tab === 'junk' && <SpamSettings />}
            {tab === 'rules' && <Rules folders={folders} categories={prefs.categories} me={me} />}
            {tab === 'import' && <ImportMail me={me} importMsg={importMsg} />}
            {tab === 'apps' && <Apps me={me} sigData={sigData} />}
            {tab === 'privacy' && <Privacy me={me} />}
          </div>
        </div>
      </div>
    </div>
  );
}
