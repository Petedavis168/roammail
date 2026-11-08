import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtAddr, fmtDate, fmtSize, escapeHtml } from '../util.js';
import RecipientInput from './RecipientInput.jsx';
import { useToast } from './Toast.jsx';
import { signatureHtml, defaultChoice } from '../signatures.js';
import { safeHtml, onSafePaste } from '../safehtml.js';
import { presets, fmtWhen, localInputValue } from '../snooze.js';
import { queue, flushOutbox, isOffline } from '../outbox.js';
import { offlineAllowed } from '../api.js';
import { t } from '../i18n.js';

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
  const useTemplate = (t) => {
    setTplMenu(false);
    if (t.subject && !subject) setSubject(t.subject);
    const ed = editor.current; if (!ed) return;
    ed.focus();
    document.execCommand('insertHTML', false, safeHtml(t.html));
    markDirty();
  };
  const [sendMenu, setSendMenu] = useState(false);
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
    priority: important ? 'high' : 'normal', fromAddress, asMailbox: fromChoices.find((i) => i.address === fromAddress)?.mailboxId,
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
    if (hasContent && dirty.current) { await saveDraft(); toast(t("Draft saved")); }
    onClose();
  };
  const discard = async () => {
    if (draft.uid && draft.folder) await api.remove(draft.folder, [draft.uid], true).catch(() => {});
    onClose();
  };
  const send = (sendAt) => {
    if (!to.length && !cc.length && !bcc.length) return toast(t("Add at least one recipient"), { error: true });
    const bad = [...to, ...cc, ...bcc].find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address));
    if (bad) return toast(`"${bad.address}" isn't a valid email address`, { error: true });
    if (!subject.trim() && !confirm(t("Send this message without a subject?"))) return;
    const text = (editor.current?.innerText || '').toLowerCase();
    if (/\b(attached|attachment|enclosed)\b/.test(text.split('wrote:')[0]) && !files.length && !init.forwardUid && !confirm(t("You mentioned an attachment but none is attached. Send anyway?"))) return;
    onSend({ ...payload(), sendAt: typeof sendAt === 'number' ? sendAt : undefined });
  };

  const addFiles = (list) => {
    const arr = [...list];
    const total = [...files, ...arr].reduce((s, f) => s + f.size, 0);
    if (total > 25 * 1024 * 1024) return toast(t("Attachments are limited to 25 MB in total"), { error: true });
    setFiles((f) => [...f, ...arr]);
  };

  const exec = (cmd, val) => { editor.current?.focus(); document.execCommand(cmd, false, val); markDirty(); };
  const addLink = () => { const url = prompt(t("Link address (https://…)")); if (url) exec('createLink', /^\w+:/.test(url) ? url : `https://${url}`); };

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
        <button className="icon-btn on-dark xs" title={t("Minimize")} onClick={(e) => { e.stopPropagation(); setState(state === 'min' ? 'normal' : 'min'); }}><Icon name="min" size={14} /></button>
        <button className="icon-btn on-dark xs" title={state === 'max' ? 'Exit full screen' : 'Full screen'} onClick={(e) => { e.stopPropagation(); setState(state === 'max' ? 'normal' : 'max'); }}><Icon name="max" size={14} /></button>
        <button className="icon-btn on-dark xs" title={t("Save & close")} onClick={(e) => { e.stopPropagation(); close(); }}><Icon name="close" size={14} /></button>
      </div>
      <div className="composer-body" style={{ display: state === 'min' ? 'none' : undefined }}>
        {fromChoices.length > 1 && (
          <div className="rcpt from-row"><span className="rcpt-label">{t("From")}</span>
            <select value={fromAddress} onChange={(e) => { setFromAddress(e.target.value); markDirty(); }}>
              {fromChoices.map((i) => <option key={i.address} value={i.address}>{i.group ? `${i.name} <${i.address}>` : i.other ? `${i.address} (other account)` : i.address}</option>)}
            </select></div>
        )}
        <RecipientInput label={t("To")} value={to} onChange={setTo} autoFocus={!to.length}
          right={!showCc && <button type="button" className="link small" onClick={() => setShowCc(true)}>{t("Cc Bcc")}</button>} />
        {showCc && <RecipientInput label={t("Cc")} value={cc} onChange={setCc} />}
        {showCc && <RecipientInput label={t("Bcc")} value={bcc} onChange={setBcc} />}
        <input className="subject-input" placeholder={t("Subject")} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label={t("Subject")} />
        <div className="editor-wrap">
          {!ready && <div className="list-msg"><div className="spinner" /></div>}
          <div ref={editor} className="editor" contentEditable suppressContentEditableWarning onInput={markDirty} aria-label={t("Message body")} role="textbox" aria-multiline="true"
            onPaste={(e) => {
              const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
              if (imgs.length) { e.preventDefault(); addFiles(imgs); return; }
              onSafePaste(e, markDirty);
            }} />
          {dragging && <div className="drop-zone">{t("Drop files to attach")}</div>}
        </div>
        {enforced && (
          <div className="enforced-sig" title={t("Your organization adds this signature to every email")}>
            <small className="muted">{t("Added automatically by")}{' '}{enforced.company || 'your organization'}</small>
            <div dangerouslySetInnerHTML={{ __html: safeHtml(enforced.html) }} />
          </div>
        )}
        {files.length > 0 && (
          <div className="c-files">
            {files.map((f, i) => (
              <span key={i} className="c-file"><Icon name="clip" size={14} /> {f.name} <small>({fmtSize(f.size)})</small>
                <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={t("Remove attachment")}>×</button></span>
            ))}
          </div>
        )}
        {init.forwardUid && <div className="muted small c-note">{t("Original attachments will be included.")}</div>}
        <div className="composer-foot">
          <div className="split-send dd">
            <button className="btn primary" onClick={() => send()} title={t("Send (Ctrl+Enter)")}><Icon name="send" size={16} />{' '}{t("Send")}</button>
            <button className="btn primary caret" title={t("Schedule send")} onClick={() => setSendMenu((x) => !x)}><Icon name="down" size={14} /></button>
            {sendMenu && (
              <div className="menu up" onMouseLeave={() => { setSendMenu(false); setPickTime(false); }}>
                <div className="menu-head"><b>{t("Schedule send")}</b></div>
                {presets('send').map(([l, d]) => (
                  <button key={l} onClick={() => { setSendMenu(false); send(d.getTime()); }}>{l}<small className="muted right">{fmtWhen(d)}</small></button>
                ))}
                {!pickTime ? <button onClick={() => setPickTime(true)}><Icon name="draft" />{' '}{t("Pick date & time")}</button> : (
                  <div className="pick-time">
                    <input type="datetime-local" value={customTime} min={localInputValue(new Date())} onChange={(e) => setCustomTime(e.target.value)} />
                    <button className="btn primary sm" onClick={() => { const t = new Date(customTime).getTime(); if (t > Date.now() + 60000) { setSendMenu(false); send(t); } else toast(t("Pick a time in the future"), { error: true }); }}>{t("Schedule")}</button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="fmt">
            <button type="button" className="icon-btn" title={t("Attach files")} onClick={() => fileInput.current.click()}><Icon name="clip" size={16} /></button>
            <button type="button" className="icon-btn" title={t("Bold")} onMouseDown={(e) => { e.preventDefault(); exec('bold'); }}><Icon name="bold" size={16} /></button>
            <button type="button" className="icon-btn" title={t("Italic")} onMouseDown={(e) => { e.preventDefault(); exec('italic'); }}><Icon name="italic" size={16} /></button>
            <button type="button" className="icon-btn" title={t("Underline")} onMouseDown={(e) => { e.preventDefault(); exec('underline'); }}><Icon name="underline" size={16} /></button>
            <button type="button" className="icon-btn" title={t("Bulleted list")} onMouseDown={(e) => { e.preventDefault(); exec('insertUnorderedList'); }}><Icon name="list" size={16} /></button>
            <button type="button" className="icon-btn" title={t("Insert link")} onMouseDown={(e) => { e.preventDefault(); addLink(); }}><Icon name="link" size={16} /></button>
            <button type="button" className={`icon-btn ${important ? 'on-red' : ''}`} title={t("High importance")} onClick={() => setImportant((x) => !x)}>!</button>
            <div className="dd">
              <button type="button" className="icon-btn" title={t("Insert a template")} onClick={openTemplates}>📄</button>
              {tplMenu && (
                <div className="menu up" onMouseLeave={() => setTplMenu(false)}>
                  <div className="menu-head"><b>{t("Templates")}</b></div>
                  {!templates && <div className="menu-note">{t("Loading…")}</div>}
                  {templates?.company?.length > 0 && <div className="menu-note">{t("Company")}</div>}
                  {templates?.company?.map((t) => <button key={`c${t.id}`} onClick={() => useTemplate(t)}><span className="ic-space" /> {t.name}</button>)}
                  {templates?.company?.length > 0 && templates?.personal?.length > 0 && <div className="menu-note">{t("Mine")}</div>}
                  {templates?.personal?.map((t) => <button key={t.id} onClick={() => useTemplate(t)}><span className="ic-space" /> {t.name}</button>)}
                  {templates && !templates.personal.length && !templates.company.length && <div className="menu-note">{t("Create templates in Settings → Templates.")}</div>}
                </div>
              )}
            </div>
            <div className="dd">
              <button type="button" className="icon-btn" title={t("Signature")} onClick={() => setSigMenu((x) => !x)}><Icon name="pen" size={16} /></button>
              {sigMenu && (
                <div className="menu up" onMouseLeave={() => setSigMenu(false)}>
                  <div className="menu-head"><b>{t("Signature")}</b></div>
                  <button onClick={() => chooseSignature(null)}>{!sigChoice ? <Icon name="check" /> : <span className="ic-space" />}{' '}{t("No signature")}</button>
                  {sigData?.org?.mode === 'default' && <button onClick={() => chooseSignature('company')}>{sigChoice === 'company' ? <Icon name="check" /> : <span className="ic-space" />} {sigData.org.company || 'Company'} signature</button>}
                  {(sigData?.personal?.signatures || []).map((x) => (
                    <button key={x.id} onClick={() => chooseSignature(x.id)}>{sigChoice === x.id ? <Icon name="check" /> : <span className="ic-space" />} {x.name}</button>
                  ))}
                  {!(sigData?.personal?.signatures || []).length && <div className="menu-note">{t("Create signatures in Settings → Signatures.")}</div>}
                </div>
              )}
            </div>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </div>
          <span className="muted small saving">{saving}</span>
          <button className="icon-btn" title={t("Discard draft")} onClick={discard}><Icon name="trash" size={16} /></button>
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
  for (const k of ['inReplyTo', 'references', 'replyFolder', 'replyUid', 'forwardFolder', 'forwardUid', 'draftUid', 'priority', 'fromName', 'fromAddress', 'sendAt']) {
    if (p[k]) fd.append(k, p[k]);
  }
  for (const f of p.files) fd.append('attachments', f, f.name);
  return fd;
}

export default function ComposeManager({ composers, setComposers, me, prefs, sigData, onSent }) {
  const [identities, setIdentities] = useState(null);
  useEffect(() => { api.get('/api/identities').then(setIdentities).catch(() => setIdentities([])); }, []);
  const toast = useToast();
  const [focused, setFocused] = useState(null);
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
        await api.form('/api/send', form, payload.asMailbox);
        toast(t("Message sent"));
        onSent();
      } catch (e) {
        if (isOffline(e) && offlineAllowed()) { // no connection: keep it on this device and send it when we're back online
          try { await queue(form, payload.asMailbox, payload.subject || '(no subject)'); toast(t("You’re offline. Saved to your Outbox; it will send when you reconnect.")); return; } catch { /* fall through */ }
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
    toast(t("Sending…"), {
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
      {composers.map((c, i) => (
        <Composer key={c.id} c={c} me={me} prefs={prefs} sigData={sigData} identities={identities} count={composers.length} focusIndex={i}
          setFocus={() => setFocused(c.id)} onClose={() => remove(c.id)} onSend={(p) => onSend(c, p)} />
      ))}
    </div>
  );
}
