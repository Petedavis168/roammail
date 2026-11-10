import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtAddr, fmtDate, fmtSize, escapeHtml } from '../util.js';
import RecipientInput from './RecipientInput.jsx';
import { useToast } from './Toast.jsx';
import { signatureHtml, defaultChoice } from '../signatures.js';
import { safeHtml, onSafePaste } from '../safehtml.js';
import { presets, fmtWhen, localInputValue, bestSendTime } from '../snooze.js';
import { queue, flushOutbox, isOffline } from '../outbox.js';
import { offlineAllowed } from '../api.js';
import { t as tr } from '../i18n.js';
import VoiceRecorder from './VoiceRecorder.jsx';
import { GALLERY, customFields, builtinValues, fillTemplate, fieldLabel } from '../templategallery.js';

const sigBlock = (html) => (html ? `<div class="signature" data-sig="1"><br>${safeHtml(html)}</div>` : '');

const prefix = (p, s = '') => (new RegExp(`^${p}:`, 'i').test(s.trim()) ? s : `${p}: ${s}`);

/** Build the initial state of a reply / reply-all / forward. */
export function replyDraft(msg, mode, myEmail) {
  const me = myEmail.toLowerCase();
  const notMe = (a) => a.address?.toLowerCase() !== me;
  const base = { quote: msg, mode, inReplyTo: msg.messageId, references: [...(msg.references || []), msg.messageId].filter(Boolean).join(' '),
    replyFolder: msg.folder, replyUid: msg.uid };
  if (mode === 'forward') {
    return { ...base, to: [], subject: prefix('Fwd', msg.subject), forwardFolder: msg.folder, forwardUid: msg.uid, inReplyTo: undefined, references: undefined };
  }
  const sentByMe = msg.from?.some((a) => !notMe(a));
  const primary = sentByMe ? msg.to || [] : msg.replyTo?.length ? msg.replyTo : msg.from || [];
  const to = primary.filter((a) => sentByMe || notMe(a));
  const cc = mode === 'all' ? [...(sentByMe ? [] : msg.to || []), ...(msg.cc || [])].filter(notMe).filter((a) => !to.some((t) => t.address === a.address)) : [];
  return { ...base, to, cc, subject: prefix('Re', msg.subject) };
}

function quoteHtml(msg, mode, allowRemote) {
  const body = msg.html || `<div style="white-space:pre-wrap">${escapeHtml(msg.text || '')}</div>`;
  const inner = safeHtml(body.replace(/^[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, ''), { blockRemote: !allowRemote });
  if (mode === 'forward') {
    return `<br><br><div>---------- Forwarded message ----------<br>From: ${escapeHtml((msg.from || []).map(fmtAddr).join(', '))}<br>Date: ${escapeHtml(fmtDate(msg.date, true))}<br>Subject: ${escapeHtml(msg.subject || '')}<br>To: ${escapeHtml((msg.to || []).map(fmtAddr).join(', '))}<br>${msg.cc?.length ? `Cc: ${escapeHtml(msg.cc.map(fmtAddr).join(', '))}<br>` : ''}<br>${inner}</div>`;
  }
  return `<br><br><div>On ${escapeHtml(fmtDate(msg.date, true))}, ${escapeHtml((msg.from || []).map(fmtAddr).join(', '))} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${inner}</blockquote>`;
}

function Composer({ c, me, prefs, sigData, identities, onClose, onSend, focusIndex, setFocus, count }) {
  const toast = useToast();
  const init = c.initial;
  const [to, setTo] = useState(init.to || []);
  const [cc, setCc] = useState(init.cc || []);
  const [bcc, setBcc] = useState(init.bcc || []);
  const [showCc, setShowCc] = useState(!!(init.cc?.length || init.bcc?.length));
  const [subject, setSubject] = useState(init.subject || '');
  const [files, setFiles] = useState(init.files || []);
  const [state, setState] = useState('normal'); // normal | min | max
  const [draft, setDraft] = useState({ uid: init.draftUid, folder: init.draftFolder });
  const [saving, setSaving] = useState('');
  const [ready, setReady] = useState(!(init.quote && !init.quote.html && !init.quote.text));
  const [dragging, setDragging] = useState(false);
  const [important, setImportant] = useState(init.priority === 'high');
  const [readR, setReadR] = useState(prefs.requestReceipts === 'always');
  const [delivR, setDelivR] = useState(prefs.requestReceipts === 'always');
  const [rcptMenu, setRcptMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  // password protection: recipients get a link; the password goes separately
  const [protect, setProtect] = useState(false);
  const [sec, setSec] = useState({ password: '', hint: '', days: 7, follow: 'later', show: false });
  const genPassword = () => {
    const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/l/I)
    const out = [];
    const limit = 256 - (256 % a.length); // reject the top few values so every character is equally likely
    while (out.length < 14) { const [b] = crypto.getRandomValues(new Uint8Array(1)); if (b < limit) out.push(a[b % a.length]); }
    setSec((x) => ({ ...x, password: out.join('').replace(/(.{4})(?=.)/g, '$1-'), show: true }));
  };
  const editor = useRef();
  const fileInput = useRef();
  const dirty = useRef(false);
  const isReply = !!init.mode;
  // Identities of this mailbox, plus every other signed-in account (item 10: compose From across accounts)
  const fromChoices = [...(identities || [{ address: me.email }]), ...(me.accounts || []).filter((a) => a.email !== me.email && !(identities || []).some((i) => i.address === a.email)).map((a) => ({ address: a.email, name: a.name, other: true, mailboxId: a.mailboxId }))];
  // Reply from the group address when the original was sent to a group you can send as
  const [fromAddress, setFromAddress] = useState(() => {
    if (init.fromAddress) return init.fromAddress;
    const rcpts = [...(init.quote?.to || []), ...(init.quote?.cc || [])].map((a) => a.address?.toLowerCase());
    return (identities || []).find((i) => i.group && rcpts.includes(i.address))?.address || me.email;
  });
  const [sigChoice, setSigChoice] = useState(() => defaultChoice(sigData, isReply));
  const [sigMenu, setSigMenu] = useState(false);
  const [tplMenu, setTplMenu] = useState(false);
  const [templates, setTemplates] = useState(null);
  const openTemplates = () => { setTplMenu((x) => !x); if (!templates) api.get('/api/templates').then(setTemplates).catch(() => setTemplates({ personal: [], company: [] })); };
  const [tplQ, setTplQ] = useState('');
  const [tplFill, setTplFill] = useState(null); // { t, values } while asking for the fill-in fields
  const insertTemplate = (t, values) => {
    const f = fillTemplate(t, { ...builtinValues({ to, me }), ...values });
    if (f.subject && !subject.trim()) setSubject(f.subject);
    const ed = editor.current; if (!ed) return;
    ed.focus();
    document.execCommand('insertHTML', false, safeHtml(f.html));
    markDirty();
  };
  const useTemplate = (t) => {
    setTplMenu(false); setTplQ('');
    const ask = customFields(t);
    if (ask.length) setTplFill({ t, values: Object.fromEntries(ask.map((k) => [k, ''])) });
    else insertTemplate(t, {});
  };
  // Colleagues who are out of office (business accounts): shown under the To line
  const [away, setAway] = useState([]);
  const rcptKey = [...to, ...cc].map((r) => r.address?.toLowerCase()).filter(Boolean).sort().join(',');
  useEffect(() => {
    if (!me.orgDomains?.length || !rcptKey) { setAway([]); return; }
    const inOrg = rcptKey.split(',').filter((a) => me.orgDomains.includes(a.split('@')[1]));
    if (!inOrg.length) { setAway([]); return; }
    const h = setTimeout(() => api.get(`/api/ooo?emails=${encodeURIComponent(inOrg.join(','))}`).then((r) => setAway(r.away || [])).catch(() => {}), 400);
    return () => clearTimeout(h);
  }, [rcptKey]);
  const [voice, setVoice] = useState(false);
  const addVoice = ({ url, durationMs }) => {
    setVoice(false);
    const s2 = Math.round((durationMs || 0) / 1000); const len = `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`;
    const html = `<div><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:8px 0"><tr><td style="background:#2563eb;border-radius:999px;padding:10px 18px"><a href="${escapeHtml(url)}" style="color:#ffffff;text-decoration:none;font:600 14px Arial,sans-serif">&#9654;&nbsp; ${escapeHtml(tr('Play voice message'))} (${len})</a></td></tr></table></div><div><br></div>`;
    const ed = editor.current; if (!ed) return;
    const cur = ed.querySelector('.signature, [data-sig]');
    if (cur) cur.insertAdjacentHTML('beforebegin', safeHtml(html)); else { ed.focus(); document.execCommand('insertHTML', false, safeHtml(html)); }
    markDirty();
  };
  const [sendMenu, setSendMenu] = useState(false);
  // Send at the best time for the first person on the To line (from when they usually write to you)
  const [best, setBest] = useState(null);
  const firstTo = to[0]?.address?.toLowerCase() || '';
  useEffect(() => {
    if (!sendMenu || !firstTo || best?.email === firstTo) return;
    api.get('/api/people/activity', { email: firstTo }).then((r) => setBest({ email: firstTo, name: to[0]?.name || firstTo.split('@')[0], ...bestSendTime(r.times) }))
      .catch(() => setBest({ email: firstTo, name: to[0]?.name || firstTo.split('@')[0], ...bestSendTime([]) }));
  }, [sendMenu, firstTo]);
  const [pickTime, setPickTime] = useState(false);
  const [customTime, setCustomTime] = useState(() => localInputValue(new Date(Date.now() + 3600e3)));
  const sig = sigBlock(signatureHtml(sigData, sigChoice));
  const enforced = sigData?.org?.mode === 'enforced' && (!isReply || sigData.org.onReplies) ? sigData.org : null;

  const chooseSignature = (choice) => {
    setSigChoice(choice); setSigMenu(false);
    const ed = editor.current; if (!ed) return;
    const html = sigBlock(signatureHtml(sigData, choice));
    const cur = ed.querySelector('.signature, [data-sig]');
    if (cur) { if (html) cur.outerHTML = html; else cur.remove(); }
    else if (html) {
      const quote = [...ed.children].find((el) => /wrote:|Forwarded message/.test(el.textContent || '') || el.tagName === 'BLOCKQUOTE');
      if (quote) quote.insertAdjacentHTML('beforebegin', html); else ed.insertAdjacentHTML('beforeend', html);
    }
    markDirty();
  };

  // Fill the editor (fetching the full original if we only have a list summary)
  useEffect(() => {
    let cancelled = false;
    const fill = (quote) => {
      if (cancelled || !editor.current) return;
      const sender = quote?.from?.[0]?.address?.toLowerCase();
      const allowRemote = prefs.showImages === 'always' || (sender && prefs.trustedSenders?.includes(sender));
      editor.current.innerHTML = init.html != null ? safeHtml(init.html) : `${init.prefillText ? `<div style="white-space:pre-wrap">${escapeHtml(init.prefillText)}</div>` : '<div><br></div>'}${sig}${quote ? quoteHtml(quote, init.mode, allowRemote) : ''}`; // prefillText: an AI-suggested reply
      setReady(true);
      if (to.length || init.mode === 'forward') {
        const r = document.createRange(); r.setStart(editor.current, 0); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        if (to.length) editor.current.focus();
      }
    };
    const q = init.quote;
    if (q && !q.html && !q.text) {
      api.get('/api/message', { folder: q.folder, uid: q.uid, peek: 1 }).then((full) => fill({ ...q, ...full })).catch(() => fill(q));
    } else fill(q);
    return () => { cancelled = true; };
  }, []);

  const payload = () => ({
    to, cc, bcc, subject, files, html: editor.current?.innerHTML || '', text: editor.current?.innerText || '',
    inReplyTo: init.inReplyTo, references: init.references, replyFolder: init.replyFolder, replyUid: init.replyUid,
    forwardFolder: init.forwardFolder, forwardUid: init.forwardUid, draftUid: draft.uid, draftFolder: draft.folder,
    priority: important ? 'high' : 'normal', readReceipt: readR, deliveryReceipt: delivR,
    ...(protect ? { protect: true, securePassword: sec.password, secureHint: sec.hint, secureDays: sec.days, pwFollow: sec.follow } : {}), fromAddress, asMailbox: fromChoices.find((i) => i.address === fromAddress)?.mailboxId,
    fromName: fromAddress !== me.email ? ((identities || []).find((i) => i.address === fromAddress)?.name || '') : (prefs.displayName || me.name || ''),
  });

  const saveDraft = async () => {
    if (!dirty.current) return;
    dirty.current = false;
    setSaving('Saving…');
    try {
      const r = await api.form('/api/drafts', toForm(payload()));
      setDraft({ uid: r.uid, folder: r.folder });
      setSaving(`Draft saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    } catch (e) { setSaving('Couldn\'t save draft'); dirty.current = true; }
  };
  useEffect(() => { const t = setInterval(saveDraft, 20000); return () => clearInterval(t); });

  const markDirty = () => { dirty.current = true; };
  useEffect(markDirty, [to, cc, bcc, subject, files]);

  const close = async () => {
    const hasContent = to.length || subject || (editor.current?.innerText || '').trim().replace(/^--[\s\S]*$/, '').trim();
    if (hasContent && dirty.current) { await saveDraft(); toast(tr("Draft saved")); }
    onClose();
  };
  const discard = async () => {
    if (draft.uid && draft.folder) await api.remove(draft.folder, [draft.uid], true).catch(() => {});
    onClose();
  };
  const send = (sendAt) => {
    if (!to.length && !cc.length && !bcc.length) return toast(tr("Add at least one recipient"), { error: true });
    const bad = [...to, ...cc, ...bcc].find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address));
    if (bad) return toast(`"${bad.address}" isn't a valid email address`, { error: true });
    if (protect && sec.password.length < 8) return toast(tr("Choose a password of at least 8 characters, or tap Generate"), { error: true });
    if (!subject.trim() && !confirm(tr("Send this message without a subject?"))) return;
    const text = (editor.current?.innerText || '').toLowerCase();
    if (/\b(attached|attachment|enclosed)\b/.test(text.split('wrote:')[0]) && !files.length && !init.forwardUid && !confirm(tr("You mentioned an attachment but none is attached. Send anyway?"))) return;
    onSend({ ...payload(), sendAt: typeof sendAt === 'number' ? sendAt : undefined });
  };

  const addFiles = (list) => {
    const arr = [...list];
    const total = [...files, ...arr].reduce((s, f) => s + f.size, 0);
    if (total > 25 * 1024 * 1024) return toast(tr("Attachments are limited to 25 MB in total"), { error: true });
    setFiles((f) => [...f, ...arr]);
  };

  const exec = (cmd, val) => { editor.current?.focus(); document.execCommand(cmd, false, val); markDirty(); };
  const addLink = () => { const url = prompt(tr("Link address (https://…)")); if (url) exec('createLink', /^\w+:/.test(url) ? url : `https://${url}`); };

  const title = subject || (init.mode === 'forward' ? 'Forward' : init.mode ? 'Reply' : 'New message');
  return (
    <div className={`composer ${state}`} style={state === 'max' ? undefined : { right: 16 + (count - 1 - focusIndex) * 0 }}
      onFocus={setFocus}
      onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); } if (e.key === 'Escape') { e.stopPropagation(); setState('min'); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); } }}>
      <div className="composer-bar" onClick={() => state === 'min' && setState('normal')}>
        <span className="ctitle">{title}</span>
        <button className="icon-btn on-dark xs" title={tr("Minimize")} onClick={(e) => { e.stopPropagation(); setState(state === 'min' ? 'normal' : 'min'); }}><Icon name="min" size={14} /></button>
        <button className="icon-btn on-dark xs" title={state === 'max' ? 'Exit full screen' : 'Full screen'} onClick={(e) => { e.stopPropagation(); setState(state === 'max' ? 'normal' : 'max'); }}><Icon name="max" size={14} /></button>
        <button className="icon-btn on-dark xs" title={tr("Save & close")} onClick={(e) => { e.stopPropagation(); close(); }}><Icon name="close" size={14} /></button>
      </div>
      <div className="composer-body" style={{ display: state === 'min' ? 'none' : undefined }}>
        {fromChoices.length > 1 && (
          <div className="rcpt from-row"><span className="rcpt-label">{tr("From")}</span>
            <select value={fromAddress} onChange={(e) => { setFromAddress(e.target.value); markDirty(); }}>
              {fromChoices.map((i) => <option key={i.address} value={i.address}>{i.group ? `${i.name} <${i.address}>` : i.other ? `${i.address} (other account)` : i.address}</option>)}
            </select></div>
        )}
        <RecipientInput label={tr("To")} value={to} onChange={setTo} autoFocus={!to.length}
          right={!showCc && <button type="button" className="link small" onClick={() => setShowCc(true)}>{tr("Cc Bcc")}</button>} />
        {showCc && <RecipientInput label={tr("Cc")} value={cc} onChange={setCc} />}
        {showCc && <RecipientInput label={tr("Bcc")} value={bcc} onChange={setBcc} />}
        {away.map((a) => (
          <div className="away-note" key={a.email} role="note"><Icon name="clock" size={14} />
            <span><b>{a.email}</b> {tr('is out of office')}{a.until ? ` ${tr('until')} ${new Date(`${a.until}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}.
              {a.cover && <> {tr('Contact')} <button type="button" className="link" onClick={() => !to.some((r) => r.address?.toLowerCase() === a.cover) && setTo((x) => [...x, { address: a.cover, name: a.coverName || '' }])}>{a.coverName || a.cover}</button> {tr('instead')}.</>}</span>
          </div>
        ))}
        <input className="subject-input" placeholder={tr("Subject")} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label={tr("Subject")} />
        {protect && (
          <div className="protect-panel">
            <div className="protect-title"><Icon name="lock" size={14} /> <b>{tr("Password-protected")}</b> <span className="muted small">{tr("They get a secure link. Send the password separately.")}</span>
              <button type="button" className="link" onClick={() => setProtect(false)}>{tr("Remove")}</button></div>
            <div className="protect-row">
              <input type={sec.show ? 'text' : 'password'} value={sec.password} onChange={(e) => setSec({ ...sec, password: e.target.value })} placeholder={tr("Password (8+ characters)")} aria-label={tr("Password")} autoComplete="new-password" />
              <button type="button" className="btn sm" onClick={() => setSec({ ...sec, show: !sec.show })}>{sec.show ? tr("Hide") : tr("Show")}</button>
              <button type="button" className="btn sm" onClick={genPassword}>{tr("Generate")}</button>
            </div>
            <div className="protect-row">
              <input value={sec.hint} onChange={(e) => setSec({ ...sec, hint: e.target.value })} placeholder={tr("Hint (optional, shown to them)")} maxLength={200} aria-label={tr("Password hint")} />
              <select value={sec.days} onChange={(e) => setSec({ ...sec, days: Number(e.target.value) })} aria-label={tr("Expires")}>
                {[[1, 'Expires in 1 day'], [7, 'Expires in 7 days'], [14, 'Expires in 14 days'], [30, 'Expires in 30 days']].map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}
              </select>
            </div>
            <label className="row-field small">{tr("Send the password")}{' '}<select value={sec.follow} onChange={(e) => setSec({ ...sec, follow: e.target.value })}>
              <option value="later">{tr("By email, 5 minutes later")}</option><option value="now">{tr("By email, straight after")}</option><option value="manual">{tr("I'll send it myself (text, call…)")}</option>
            </select></label>
          </div>
        )}
        <div className="editor-wrap">
          {!ready && <div className="list-msg"><div className="spinner" /></div>}
          <div ref={editor} className="editor" contentEditable suppressContentEditableWarning onInput={markDirty} aria-label={tr("Message body")} role="textbox" aria-multiline="true"
            onPaste={(e) => {
              const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
              if (imgs.length) { e.preventDefault(); addFiles(imgs); return; }
              onSafePaste(e, markDirty);
            }} />
          {dragging && <div className="drop-zone">{tr("Drop files to attach")}</div>}
        </div>
        {enforced && (
          <div className="enforced-sig" title={tr("Your organization adds this signature to every email")}>
            <small className="muted">{tr("Added automatically by")}{' '}{enforced.company || 'your organization'}</small>
            <div dangerouslySetInnerHTML={{ __html: safeHtml(enforced.html) }} />
          </div>
        )}
        {files.length > 0 && (
          <div className="c-files">
            {files.map((f, i) => (
              <span key={i} className="c-file"><Icon name="clip" size={14} /> {f.name} <small>({fmtSize(f.size)})</small>
                <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={tr("Remove attachment")}>×</button></span>
            ))}
          </div>
        )}
        {init.forwardUid && <div className="muted small c-note">{tr("Original attachments will be included.")}</div>}
        {voice && <VoiceRecorder onAdd={addVoice} onClose={() => setVoice(false)} />}
        {tplFill && (
          <form className="tpl-fill" onSubmit={(e) => { e.preventDefault(); insertTemplate(tplFill.t, tplFill.values); setTplFill(null); }}>
            <b>{tr('Fill in')} “{tplFill.t.name}”</b>
            {Object.keys(tplFill.values).map((k, i) => (
              <label key={k}>{fieldLabel(k)}<input autoFocus={i === 0} value={tplFill.values[k]} onChange={(e) => setTplFill((f) => ({ ...f, values: { ...f.values, [k]: e.target.value } }))} /></label>
            ))}
            <div className="actions"><button className="btn primary" type="submit">{tr('Insert')}</button><button className="btn" type="button" onClick={() => setTplFill(null)}>{tr('Cancel')}</button></div>
            <div className="muted small">{tr('Anything left empty stays as a blank you can fill in later.')}</div>
          </form>
        )}
        <div className="composer-foot">
          <div className="split-send dd">
            <button className="btn primary" onClick={() => send()} title={tr("Send (Ctrl+Enter)")}><Icon name="send" size={16} />{' '}{tr("Send")}</button>
            <button className="btn primary caret" title={tr("Schedule send")} onClick={() => setSendMenu((x) => !x)}><Icon name="down" size={14} /></button>
            {sendMenu && (
              <div className="menu up" onMouseLeave={() => { setSendMenu(false); setPickTime(false); }}>
                <div className="menu-head"><b>{tr("Schedule send")}</b></div>
                {firstTo && best?.email === firstTo && (
                  <button className="best-time" onClick={() => { setSendMenu(false); send(best.at); }}>
                    <Icon name="spark" size={15} /> <span><b>{tr('Best time for')} {best.name.split(' ')[0]}</b>
                      <small>{best.usual ? `${tr('They usually email around')} ${new Date(2000, 0, 1, best.hour).toLocaleTimeString([], { hour: 'numeric' })}` : tr('A weekday morning, when most email gets read')}</small></span>
                    <small className="muted right">{fmtWhen(best.at)}</small>
                  </button>
                )}
                {firstTo && best?.email !== firstTo && <div className="menu-note">{tr('Working out the best time…')}</div>}
                {presets('send').map(([l, d]) => (
                  <button key={l} onClick={() => { setSendMenu(false); send(d.getTime()); }}>{l}<small className="muted right">{fmtWhen(d)}</small></button>
                ))}
                {!pickTime ? <button onClick={() => setPickTime(true)}><Icon name="draft" />{' '}{tr("Pick date & time")}</button> : (
                  <div className="pick-time">
                    <input type="datetime-local" value={customTime} min={localInputValue(new Date())} onChange={(e) => setCustomTime(e.target.value)} />
                    <button className="btn primary sm" onClick={() => { const t = new Date(customTime).getTime(); if (t > Date.now() + 60000) { setSendMenu(false); send(t); } else toast(tr("Pick a time in the future"), { error: true }); }}>{tr("Schedule")}</button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="fmt">
            <button type="button" className="icon-btn" title={tr("Attach files")} onClick={() => fileInput.current.click()}><Icon name="clip" size={16} /></button>
            <button type="button" className="icon-btn" title={tr("Bold")} onMouseDown={(e) => { e.preventDefault(); exec('bold'); }}><Icon name="bold" size={16} /></button>
            <button type="button" className="icon-btn" title={tr("Italic")} onMouseDown={(e) => { e.preventDefault(); exec('italic'); }}><Icon name="italic" size={16} /></button>
            <button type="button" className="icon-btn" title={tr("Insert link")} onMouseDown={(e) => { e.preventDefault(); addLink(); }}><Icon name="link" size={16} /></button>
            <button type="button" className={`icon-btn ${voice ? 'on' : ''}`} title={tr("Voice message")} aria-label={tr("Voice message")} onClick={() => setVoice((x) => !x)}><Icon name="mic" size={16} /></button>
            <button type="button" className={`icon-btn ${protect ? 'on' : ''}`} title={tr("Protect with a password")} aria-label={tr("Protect with a password")} aria-pressed={protect} onClick={() => { setProtect((x) => !x); if (!protect && !sec.password) genPassword(); }}><Icon name="lock" size={16} /></button>
            <div className="dd">
              <button type="button" className={`icon-btn ${important || readR || delivR ? 'on' : ''}`} title={tr("More options")} aria-label={tr("More options")} aria-expanded={moreMenu} onClick={() => setMoreMenu((x) => !x)}><Icon name="more" size={16} /></button>
              {moreMenu && (
                <div className="menu up more-menu" onMouseLeave={() => setMoreMenu(false)}>
                  <button onMouseDown={(e) => { e.preventDefault(); exec('underline'); }}><Icon name="underline" size={15} /> {tr("Underline")}</button>
                  <button onMouseDown={(e) => { e.preventDefault(); exec('insertUnorderedList'); }}><Icon name="list" size={15} /> {tr("Bulleted list")}</button>
                  <button onMouseDown={(e) => { e.preventDefault(); exec('insertOrderedList'); }}><span className="ic-num">1.</span> {tr("Numbered list")}</button>
                  <div className="menu-sep" />
                  <button onClick={() => setImportant((x) => !x)}><Icon name={important ? 'check' : 'alert'} size={15} /> {tr("Important")}</button>
                  {prefs.requestReceipts !== 'never' && <>
                    <button onClick={() => setDelivR((x) => !x)}><Icon name={delivR ? 'check' : 'send'} size={15} /> {tr("Delivery receipt")}</button>
                    <button onClick={() => setReadR((x) => !x)}><Icon name={readR ? 'check' : 'mail'} size={15} /> {tr("Read receipt")}</button>
                  </>}
                  <div className="menu-sep" />
                  <button onClick={() => { setMoreMenu(false); openTemplates(); }}><Icon name="copy" size={15} /> {tr("Template")}…</button>
                  <button onClick={() => { setMoreMenu(false); setSigMenu(true); }}><Icon name="pen" size={15} /> {tr("Signature")}…</button>
                </div>
              )}
            </div>
            <div className="dd">
              {tplMenu && (() => {
                const match = (t) => !tplQ || `${t.name} ${t.subject} ${t.category || ''}`.toLowerCase().includes(tplQ.toLowerCase());
                const comp = (templates?.company || []).filter(match); const mine = (templates?.personal || []).filter(match);
                const ready = GALLERY.filter(match);
                return (
                  <div className="menu up tpl-menu" onMouseLeave={() => setTplMenu(false)}>
                    <div className="menu-head"><b>{tr("Templates")}</b></div>
                    <input type="search" autoFocus placeholder={tr('Search templates')} value={tplQ} onChange={(e) => setTplQ(e.target.value)} aria-label={tr('Search templates')} />
                    {!templates && <div className="menu-note">{tr("Loading…")}</div>}
                    {comp.length > 0 && <div className="menu-note">{tr("Company")}</div>}
                    {comp.map((t) => <button key={`c${t.id}`} onClick={() => useTemplate(t)}><Icon name="copy" size={15} /> {t.name}</button>)}
                    {mine.length > 0 && <div className="menu-note">{tr("Mine")}</div>}
                    {mine.map((t) => <button key={t.id} onClick={() => useTemplate(t)}><Icon name="copy" size={15} /> {t.name}</button>)}
                    {ready.length > 0 && <div className="menu-note">{tr("Ready-made")}</div>}
                    {ready.map((t) => <button key={t.id} onClick={() => useTemplate(t)}><Icon name="copy" size={15} /> {t.name}</button>)}
                  </div>
                );
              })()}
            </div>
            <div className="dd">
              {sigMenu && (
                <div className="menu up" onMouseLeave={() => setSigMenu(false)}>
                  <div className="menu-head"><b>{tr("Signature")}</b></div>
                  <button onClick={() => chooseSignature(null)}>{!sigChoice ? <Icon name="check" /> : <span className="ic-space" />}{' '}{tr("No signature")}</button>
                  {sigData?.org?.mode === 'default' && <button onClick={() => chooseSignature('company')}>{sigChoice === 'company' ? <Icon name="check" /> : <span className="ic-space" />} {sigData.org.company || 'Company'} signature</button>}
                  {(sigData?.personal?.signatures || []).map((x) => (
                    <button key={x.id} onClick={() => chooseSignature(x.id)}>{sigChoice === x.id ? <Icon name="check" /> : <span className="ic-space" />} {x.name}</button>
                  ))}
                  {!(sigData?.personal?.signatures || []).length && <div className="menu-note">{tr("Create signatures in Settings → Signatures.")}</div>}
                </div>
              )}
            </div>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </div>
          <span className="muted small saving">{saving}</span>
          <button className="icon-btn" title={tr("Discard draft")} onClick={discard}><Icon name="trash" size={16} /></button>
        </div>
      </div>
    </div>
  );
}

function toForm(p) {
  const fd = new FormData();
  const list = (a) => a.map(fmtAddr).join(', ');
  fd.append('to', list(p.to)); fd.append('cc', list(p.cc)); fd.append('bcc', list(p.bcc));
  fd.append('subject', p.subject);
  fd.append('html', p.html); fd.append('text', p.text);
  for (const k of ['inReplyTo', 'references', 'replyFolder', 'replyUid', 'forwardFolder', 'forwardUid', 'draftUid', 'priority', 'fromName', 'fromAddress', 'sendAt', 'readReceipt', 'deliveryReceipt', 'protect', 'securePassword', 'secureHint', 'secureDays']) {
    if (p[k]) fd.append(k, p[k]);
  }
  for (const f of p.files) fd.append('attachments', f, f.name);
  return fd;
}

// After sending a protected email: copy the password, text it, or email it now
function PasswordShare({ s, onClose }) {
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const smsBody = encodeURIComponent(`The password for the protected email I just sent you: ${s.password}`);
  return (
    <div className="modal-wrap pw-wrap" role="dialog" aria-modal="true" aria-label={tr("Send the password")}>
      <div className="modal pw-share">
        <h3><Icon name="lock" size={16} /> {tr("Protected email sent")}</h3>
        <p>{tr("Now send the password a different way, so the link and the password never travel together.")}</p>
        <div className="pw-box"><code>{s.password}</code><button className="btn sm" onClick={() => navigator.clipboard?.writeText(s.password).then(() => toast(tr("Copied")))}><Icon name="copy" size={14} /> {tr("Copy")}</button></div>
        <div className="btn-row">
          <a className="btn" href={`sms:?&body=${smsBody}`}>{tr("Text it")}</a>
          <button className="btn" disabled={sent} onClick={() => api.post(`/api/secure/${s.id}/send-password`, { password: s.password, delayMinutes: 0 }).then(() => { setSent(true); toast(tr("Password emailed separately")); }).catch((e) => toast(e.message, { error: true }))}>{sent ? tr("Emailed") : tr("Email it separately")}</button>
          <button className="btn primary" onClick={onClose}>{tr("Done")}</button>
        </div>
        <p className="muted small">{tr("We don't keep the password. If it's lost, send the email again.")}</p>
      </div>
    </div>
  );
}

export default function ComposeManager({ composers, setComposers, me, prefs, sigData, onSent }) {
  const [identities, setIdentities] = useState(null);
  useEffect(() => { api.get('/api/identities').then(setIdentities).catch(() => setIdentities([])); }, []);
  const toast = useToast();
  const [focused, setFocused] = useState(null);
  const [share, setShare] = useState(null); // a protected email whose password the sender sends themselves
  const remove = (id) => setComposers((cs) => cs.filter((c) => c.id !== id));
  // Outbox: send what was written while offline as soon as we're back online
  useEffect(() => {
    const flush = () => flushOutbox().then((r) => {
      if (r.sent) { toast(`${r.sent === 1 ? 'Your offline message was' : `${r.sent} offline messages were`} sent`); onSent(); }
      for (const f of r.failed) toast(`Couldn't send "${f.summary}": ${f.error}`, { error: true, duration: 10000 });
    });
    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, []);

  const onSend = (c, payload) => {
    remove(c.id);
    // Sending from another signed-in account: references to this mailbox's folders don't apply there
    if (payload.asMailbox) payload = { ...payload, draftUid: undefined, replyFolder: undefined, replyUid: undefined, forwardFolder: undefined, forwardUid: undefined };
    let undone = false;
    const doSend = async () => {
      if (undone) return;
      const form = toForm(payload);
      try {
        const r = await api.form('/api/send', form, payload.asMailbox);
        onSent();
        if (r?.secure) {
          if (payload.pwFollow === 'manual') { setShare({ ...r.secure, password: payload.securePassword }); return; }
          await api.post(`/api/secure/${r.secure.id}/send-password`, { password: payload.securePassword, delayMinutes: payload.pwFollow === 'now' ? 0 : 5 })
            .then(() => toast(payload.pwFollow === 'now' ? tr("Protected email sent. The password followed in a separate email.") : tr("Protected email sent. The password will follow in a separate email in 5 minutes.")))
            .catch((e) => { toast(e.message, { error: true }); setShare({ ...r.secure, password: payload.securePassword }); });
          return;
        }
        toast(tr("Message sent"));
      } catch (e) {
        if (isOffline(e) && offlineAllowed() && !payload.protect) { // protected emails are never stored on the device (they hold the password) // no connection: keep it on this device and send it when we're back online
          try { await queue(form, payload.asMailbox, payload.subject || '(no subject)'); toast(tr("You’re offline. Saved to your Outbox; it will send when you reconnect.")); return; } catch { /* fall through */ }
        }
        toast(`Couldn't send: ${e.message}`, { error: true, duration: 8000 });
        setComposers((cs) => [...cs, { id: Date.now(), initial: { ...c.initial, ...payload, html: payload.html, draftUid: payload.draftUid } }]);
      }
    };
    if (payload.sendAt) {
      return api.form('/api/send', toForm(payload), payload.asMailbox).then(() => { toast(`Scheduled for ${fmtWhen(payload.sendAt)}`); onSent(); })
        .catch((e) => { toast(`Couldn't schedule: ${e.message}`, { error: true }); setComposers((cs) => [...cs, { id: Date.now(), initial: { ...c.initial, ...payload } }]); });
    }
    const delay = Number(prefs.undoSeconds) || 0;
    if (!delay) return doSend();
    const timer = setTimeout(doSend, delay * 1000);
    toast(tr("Sending…"), {
      duration: delay * 1000,
      action: 'Undo',
      onAction: () => {
        undone = true;
        clearTimeout(timer);
        setComposers((cs) => [...cs, { id: Date.now(), initial: { ...c.initial, ...payload, html: payload.html, draftUid: payload.draftUid } }]);
      },
    });
  };

  return (
    <div className="composers">
      {share && <PasswordShare s={share} onClose={() => setShare(null)} />}
      {composers.map((c, i) => (
        <Composer key={c.id} c={c} me={me} prefs={prefs} sigData={sigData} identities={identities} count={composers.length} focusIndex={i}
          setFocus={() => setFocused(c.id)} onClose={() => remove(c.id)} onSend={(p) => onSend(c, p)} />
      ))}
    </div>
  );
}
