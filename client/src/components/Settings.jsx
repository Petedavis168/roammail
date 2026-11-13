import { useEffect, useState } from 'react';
import { useDialog } from '../a11y.js';
import { Icon } from '../icons.jsx';
import Booking from './settings/Booking.jsx';
import Signatures from './settings/Signatures.jsx';
import Templates from './settings/Templates.jsx';
import Referrals from './settings/Referrals.jsx';
import { NudgeSettings } from './Nudges.jsx';
import ChatAlerts from './settings/ChatAlerts.jsx';
import { SWIPE_ACTIONS } from '../swipe.js';
import { sayNewMail, naturalVoices, isNatural, PHRASES, STYLES } from '../voice.js';
import { pushState, enablePush, disablePush } from '../push.js';

function VoiceAlert({ prefs, setPrefs }) {
  const [list, setList] = useState(() => naturalVoices());
  useEffect(() => { if (!window.speechSynthesis) return undefined; const on = () => setList(naturalVoices()); speechSynthesis.addEventListener('voiceschanged', on); return () => speechSynthesis.removeEventListener('voiceschanged', on); }, []);
  const custom = prefs.voicePhrase && !PHRASES.includes(prefs.voicePhrase);
  const play = (over = {}) => sayNewMail({ phrase: prefs.voicePhrase, voice: prefs.voiceName, style: prefs.voiceStyle || 'voice', force: true, ...over });
  const good = list.filter(isNatural);
  const apple = /Mac|iPhone|iPad/.test(navigator.userAgent);
  return (
    <div className="field-group voice-alert">
      <label className="check"><input type="checkbox" checked={!!prefs.voiceAlert} onChange={(e) => { setPrefs({ voiceAlert: e.target.checked }); if (e.target.checked) play(); }} />{' '}{t("Play a sound when new mail arrives (“You’ve got mail!”)")}</label>
      {prefs.voiceAlert && (
        <div className="voice-opts">
          <label className="row-field">{t("Sound")}{' '}<select value={prefs.voiceStyle || 'voice'} onChange={(e) => { setPrefs({ voiceStyle: e.target.value }); play({ style: e.target.value }); }}>{STYLES.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select></label>
          {(prefs.voiceStyle || 'voice') !== 'chime' && <>
            <label className="row-field">{t("What to say")}{' '}<select value={custom ? '__custom' : (prefs.voicePhrase || PHRASES[0])} onChange={(e) => setPrefs({ voicePhrase: e.target.value === '__custom' ? 'Hey, new email!' : e.target.value })}>
              {PHRASES.map((p) => <option key={p} value={p}>{p}</option>)}<option value="__custom">{t("Something else…")}</option></select></label>
            {custom && <input value={prefs.voicePhrase} maxLength={80} onChange={(e) => setPrefs({ voicePhrase: e.target.value })} aria-label={t("Words to say")} />}
            {list.length > 1 && (
              <label className="row-field">{t("Voice")}{' '}<select value={prefs.voiceName || ''} onChange={(e) => { setPrefs({ voiceName: e.target.value }); play({ voice: e.target.value }); }}>
                <option value="">{t("Most natural available")}{good[0] ? ` (${good[0].name.replace(/^Microsoft |\s*\(.*\)$/g, '')})` : ''}</option>
                {list.map((v) => <option key={v.name} value={v.name}>{isNatural(v) ? '★ ' : ''}{v.name}</option>)}
              </select></label>
            )}
          </>}
          <button className="btn sm" onClick={() => play()}>🔊 {t("Play it")}</button>
          {!good.length && (prefs.voiceStyle || 'voice') !== 'chime' && (
            <p className="muted small">{apple
              ? t("For a much more natural voice: Settings → Accessibility → Spoken Content (iPhone) or Live Speech / Spoken Content (Mac) → Voices → English → download an “Enhanced” or “Premium” voice. Then pick it here.")
              : t("For a much more natural voice, open Roammail in Microsoft Edge (it has free “Natural” voices) or Chrome, or choose “Chime only”.")}</p>
          )}
          <p className="muted small">{t("★ = natural-sounding voice. Plays while Roammail is open; when it’s closed, your device plays its normal notification sound.")}</p>
        </div>
      )}
    </div>
  );
}
function ShareStatus() {
  const [on, setOn] = useState(null);
  useEffect(() => { api.get('/api/msg-status/settings').then((r) => setOn(r.share)).catch(() => {}); }, []);
  if (on === null) return null;
  return <label className="check"><input type="checkbox" checked={on} onChange={async (e) => { const v = e.target.checked; setOn(v); await api.put('/api/msg-status/settings', { share: v }).catch(() => setOn(!v)); }} />{' '}{t("Let other Roammail users see when I've read their email and when I'm typing a reply (like iMessage)")}</label>;
}
function PushToggle() {
  const [state, setState] = useState('…');
  const [err, setErr] = useState('');
  useEffect(() => { pushState().then(setState); }, []);
  if (state === 'unsupported') return <p className="muted small">{t("This browser can't show notifications when Roammail is closed. On iPhone, add Roammail to your Home Screen first (Share → Add to Home Screen).")}</p>;
  return (
    <div className="small" style={{ margin: '6px 0' }}>
      <label className="check"><input type="checkbox" checked={state === 'on'} disabled={state === 'blocked'} onChange={async (e) => {
        setErr('');
        try { if (e.target.checked) await enablePush(); else await disablePush(); setState(await pushState()); } catch (x) { setErr(x.message); setState(await pushState()); }
      }} />{' '}{t("Notify me on this device even when Roammail is closed")}</label>
      {state === 'on' && <PreviewToggle />}
      {state === 'blocked' && <div className="muted">{t("Notifications are blocked for this site in your browser settings.")}</div>}
      {err && <div className="bad">{err}</div>}
    </div>
  );
}
function PreviewToggle() {
  const [on, setOn] = useState(null);
  useEffect(() => { api.get('/api/push/preview').then((r) => setOn(r.on)).catch(() => {}); }, []);
  if (on === null) return null;
  return <label className="check" style={{ marginLeft: 22 }}><input type="checkbox" checked={on} onChange={async (e) => { const v = e.target.checked; setOn(v); await api.put('/api/push/preview', { on: v }).catch(() => setOn(!v)); }} />{' '}{t("Show sender and subject (turn off to show only \"New mail\")")}</label>;
}
import { aiStatus, setAiEnabled, aiConsentText } from '../ai.js';
function AiSetting() {
  const [st, setSt] = useState(null);
  useEffect(() => { aiStatus(true).then(setSt); }, []);
  if (!st?.available) return null;
  return (
    <>
      <h3>{t("AI help")}</h3>
      {st.blockedByOrg ? <p className="muted small">{t("Your company has turned off AI help.")}</p> : (
        <>
          <label className="check"><input type="checkbox" checked={!!st.enabled} onChange={async (e) => setSt(await setAiEnabled(e.target.checked))} />{' '}{t("Summarise conversations, suggest replies and find mail that needs a reply")}</label>
          <p className="muted small">{aiConsentText}{st.limit != null ? ` Free accounts get ${st.limit} AI requests a month (${Math.max(0, st.limit - st.used)} left this month).` : ''}</p>
        </>
      )}
    </>
  );
}
import Security from './settings/Security.jsx';
import Premium from './settings/Premium.jsx';
import { platform } from '../native.js';
import { AutoReply, Rules, ImportMail } from './settings/MailTools.jsx';
import SpamSettings from './settings/Spam.jsx';
import Privacy from './settings/Privacy.jsx';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';
import { t, lang, setLang, LANGS } from '../i18n.js';

function General({ prefs, setPrefs, me }) {
  const set = (k) => (e) => setPrefs({ [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="settings-section">
      <h3>{t("Layout")}</h3>
      <label className="row-field">{t("Reading pane")}{' '}<select value={prefs.readingPane} onChange={set('readingPane')}>
          <option value="right">{t("Show on the right")}</option><option value="bottom">{t("Show on the bottom")}</option><option value="off">{t("Hidden (open messages full width)")}</option>
        </select></label>
      <label className="row-field">{t("Language")}{' '}<select value={lang} onChange={(e) => setLang(e.target.value)}>{LANGS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></label>
      <label className="row-field">{t("Density")}{' '}<select value={prefs.density} onChange={set('density')}><option value="comfortable">{t("Comfortable")}</option><option value="compact">{t("Compact")}</option></select></label>
      <label className="check"><input type="checkbox" checked={prefs.conversation} onChange={set('conversation')} />{' '}{t("Conversation view (group replies together)")}</label>
      <label className="check"><input type="checkbox" checked={prefs.inboxTabs !== false} onChange={set('inboxTabs')} />{' '}{t("Inbox tabs: Primary, Updates and Newsletters")}</label>
      <label className="row-field">{t("Swipe left on a message (phones)")}{' '}<select value={prefs.swipeLeft || 'archive'} onChange={set('swipeLeft')}>{SWIPE_ACTIONS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select></label>
      <label className="row-field">{t("Swipe right on a message (phones)")}{' '}<select value={prefs.swipeRight || 'read'} onChange={set('swipeRight')}>{SWIPE_ACTIONS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select></label>
      <h3>{t("Writing")}</h3>
      <label className="row-field">{t("Your name (shown to recipients)")}<input value={prefs.displayName} placeholder={me.name || me.email} onChange={set('displayName')} /></label>
      <label className="row-field">{t("Undo send")}{' '}<select value={prefs.undoSeconds} onChange={set('undoSeconds')}>
          {[0, 5, 10, 20, 30].map((s) => <option key={s} value={s}>{s ? `${s} seconds` : 'Off'}</option>)}
        </select></label>
      <h3>{t("Sounds")}</h3>
      <VoiceAlert prefs={prefs} setPrefs={setPrefs} />
      <h3>{t("Slack & Teams alerts")}</h3>
      <ChatAlerts />
      <h3>{t("Roammail to Roammail")}</h3>
      <ShareStatus />
      <h3>{t("Follow-ups")}</h3>
      <NudgeSettings />
      <h3>{t("Privacy")}</h3>
      <label className="row-field">{t("Ask for receipts on emails I send")}{' '}<select value={prefs.requestReceipts} onChange={set('requestReceipts')}><option value="ask">{t("Choose for each email")}</option><option value="always">{t("Always (delivery and read)")}</option><option value="never">{t("Never")}</option></select></label>
      <label className="row-field">{t("When someone asks me for a read receipt")}{' '}<select value={prefs.sendReceipts} onChange={set('sendReceipts')}><option value="ask">{t("Ask me")}</option><option value="always">{t("Always send one")}</option><option value="never">{t("Never send one")}</option></select></label>
      <label className="row-field">{t("External images")}{' '}<select value={prefs.showImages} onChange={set('showImages')}><option value="ask">{t("Ask before showing")}</option><option value="always">{t("Always show")}</option></select></label>
      {prefs.trustedSenders.length > 0 && (
        <div className="trusted">
          <small className="muted">{t("Always show images from:")}</small>
          {prefs.trustedSenders.map((s) => (
            <span key={s} className="rchip">{s}<button onClick={() => setPrefs((p) => ({ trustedSenders: p.trustedSenders.filter((x) => x !== s) }))}>×</button></span>
          ))}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={prefs.notifications} onChange={set('notifications')} />{' '}{t("Desktop notifications for new mail")}</label>
      <PushToggle />
      <AiSetting />
      <h3>{t("Categories")}</h3>
      {prefs.categories.map((c, i) => (
        <div key={i} className="cat-edit">
          <input type="color" aria-label={`Colour for ${c.name || 'category'}`} value={c.color} onChange={(e) => setPrefs((p) => ({ categories: p.categories.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) }))} />
          <input aria-label={t("Category name")} value={c.name} onChange={(e) => setPrefs((p) => ({ categories: p.categories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} />
          <button className="icon-btn" aria-label={`Delete ${c.name || 'category'}`} title={t("Delete category")} onClick={() => setPrefs((p) => ({ categories: p.categories.filter((_, j) => j !== i) }))}><Icon name="trash" size={16} /></button>
        </div>
      ))}
      <div><button className="btn" onClick={() => setPrefs((p) => ({ categories: [...p.categories, { name: 'New', color: '#038387' }] }))}><Icon name="plus" size={16} />{' '}{t("Add category")}</button></div>
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
        {link && left > 0 ? <img src={link.qr} alt={t("Setup QR code")} width="200" height="200" /> : (
          <button className="qr-placeholder" onClick={make}><Icon name="phone" size={32} /><span>{t("Show my setup code")}</span></button>
        )}
      </div>
      <div className="phone-steps">
        <h3>{t("Set up your phone in seconds")}</h3>
        <ol>
          <li>{t("Click")}{' '}<b>{t("Show my setup code")}</b>.</li>
          <li>{t("Point your phone's camera at the code and tap the link.")}</li>
          <li><b>{t("iPhone:")}</b>{' '}{t("tap Install. Mail")}{' '}{t("(plus calendar & contacts) is set up with nothing to type.")}<br />
            <b>{t("Android:")}</b>{' '}{t("follow the one-screen instructions for your app.")}</li>
        </ol>
        {link && left > 0 && <p className="muted small">{t("Code works once and expires in")}{' '}{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}{t(". It contains a sign-in key, so don't share it.")}</p>}
        {link && left <= 0 && <p className="muted small">{t("Code expired.")}{' '}<button className="link" onClick={make}>{t("Make a new one")}</button></p>}
        <p className="muted small">{t("Already on your phone?")}{' '}<a href={`/setup?email=${encodeURIComponent(me.email)}`} target="_blank" rel="noreferrer">{t("Open the setup page")}</a></p>
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
      <h3>{t("Server settings")}</h3>
      <p className="muted small">{t("Outlook, Apple Mail, Thunderbird and most phone apps only need your email and password. If an app asks for server settings, use these:")}</p>
      <div className="table">
        <Row l="Email / username" v={me.email} />
        <Row l="Incoming (IMAP)" v={`${c.imapHost} · port ${c.imapPort} · SSL/TLS`} />
        <Row l="Outgoing (SMTP)" v={`${c.smtpHost} · port ${c.smtpPort} · ${c.smtpSecure ? 'SSL/TLS' : 'STARTTLS'}`} />
        <Row l="Password" v="Your normal password" />
        {me.clientSettings?.davEnabled !== false && <Row l="Calendar & contacts" v={`https://${c.davHost || c.imapHost}/SOGo/dav/`} />}
      </div>
      <h3>{t("Install this app")}</h3>
      <p className="muted small">{t("On your phone: open this site in Safari or Chrome, tap")}{' '}<b>{t("Share")}</b> → <b>{t("Add to Home Screen")}</b>{t(". On a computer: click the install icon in the address bar.")}</p>
      {sigData?.inOrg && <>
        <h3>{t("Your contact details")}</h3>
        <p className="muted small">{t("Used in your company signature. Your admin manages your name and job title.")}</p>
        <div className="two-col">
          <label>{t("Phone")}<input value={prof.phone} onChange={(e) => setProf({ ...prof, phone: e.target.value })} /></label>
          <label>{t("Mobile")}<input value={prof.mobile} onChange={(e) => setProf({ ...prof, mobile: e.target.value })} /></label>
        </div>
        <div><button className="btn" onClick={() => api.patch('/api/profile', prof).then(() => toast(t("Saved"))).catch((e) => toast(e.message, { error: true }))}>{t("Save")}</button></div>
      </>}
    </div>
  );
}

export const TABS = [
  ['general', 'General', 'settings'], ['signatures', 'Signatures', 'pen'], ['booking', 'Booking page', 'calendar'], ['templates', 'Templates', 'mail'], ['security', 'Security', 'lock'],
  ['autoreply', 'Out of office', 'reply'], ['junk', 'Junk & spam', 'junk'], ['rules', 'Rules', 'filter'], ['import', 'Import mail', 'import'], ['apps', 'Phone & apps', 'phone'], ['privacy', 'Privacy', 'shield'], ['premium', 'Premium', 'spark'], ['refer', 'Refer a friend', 'users'],
];

export default function SettingsPanel({ prefs, setPrefs, me, folders, sigData, reloadSigs, onClose, initialTab = 'general', importMsg, premiumMsg, ssoMsg }) {
  const [tab, setTab] = useState(initialTab);
  // Premium tab only where it can be bought (personal accounts, Stripe prices set) and never in the iPhone app
  const [showPremium, setShowPremium] = useState(false);
  useEffect(() => { if (platform() !== 'ios') api.get('/api/premium').then((p) => setShowPremium(p.available || p.active)).catch(() => {}); }, []);
  const tabs = TABS.filter(([k]) => k !== 'premium' || showPremium);
  const dlg = useDialog(onClose);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div ref={dlg} data-dialog tabIndex={-1} aria-modal="true" className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("Settings")}>
        <nav className="settings-nav">
          <h2>{t("Settings")}</h2>
          {tabs.map(([k, l, i]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon name={i} size={16} /> {l}</button>)}
        </nav>
        <div className="settings-body">
          <div className="drawer-head"><h2>{TABS.find((t) => t[0] === tab)[1]}</h2><button className="icon-btn" aria-label={t("Close settings")} title={t("Close")} onClick={onClose}><Icon name="close" /></button></div>
          <div className="drawer-body">
            {tab === 'general' && <General prefs={prefs} setPrefs={setPrefs} me={me} />}
            {tab === 'booking' && <Booking />}
            {tab === 'signatures' && <Signatures sigData={sigData} reloadSigs={reloadSigs} prefs={prefs} setPrefs={setPrefs} me={me} />}
            {tab === 'templates' && <Templates />}
            {tab === 'refer' && <Referrals />}
            {tab === 'security' && <Security me={me} ssoMsg={ssoMsg} />}
            {tab === 'autoreply' && <AutoReply me={me} />}
            {tab === 'junk' && <SpamSettings />}
            {tab === 'rules' && <Rules folders={folders} categories={prefs.categories} me={me} />}
            {tab === 'import' && <ImportMail me={me} importMsg={importMsg} />}
            {tab === 'premium' && <Premium premiumMsg={premiumMsg} />}
            {tab === 'apps' && <Apps me={me} sigData={sigData} />}
            {tab === 'privacy' && <Privacy me={me} />}
          </div>
        </div>
      </div>
    </div>
  );
}
