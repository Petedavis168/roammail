import { useEffect, useState } from 'react';
import { prefetched, openNow } from '../fastcache.js';
import TeamBar from './TeamBar.jsx';
import { api, mailUrl } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtDate, fmtSize, personName, avatarColor, initials } from '../util.js';
import MessageBody from './MessageBody.jsx';
import AiPanel from './AiPanel.jsx';
import { t } from '../i18n.js';
import { openCard } from '../people.js';

function AddrList({ label, list }) {
  if (!list?.length) return null;
  return <div className="addr-line"><span>{label}</span> {list.map((a, i) => <span key={i}><button type="button" className="person-link" title={a.address} onClick={(e) => openCard(e, a)}>{a.name || a.address}</button>{i < list.length - 1 ? ', ' : ''}</span>)}</div>;
}

function SecurityBanner({ m, sender, orgDomains }) {
  const sec = m.security || {};
  const issues = [];
  if (m.scan?.virus) issues.push('⚠ A virus was found in this email. Don’t open its attachments or links. Delete it.');
  if (m.scan?.phish) issues.push('⚠ This email contains links known to be used for phishing. Don’t click them or enter any passwords.');
  if (sec.dmarc === 'fail') issues.push(`This message claims to be from ${sender.address?.split('@')[1]} but failed the domain's own authenticity check.`);
  else if (sec.spf === 'fail' && sec.dkim !== 'pass') issues.push('We couldn\'t confirm this message really came from the sender\'s domain.');
  if (sec.spoofedName) issues.push(`The sender's name shows a different email address than the one it was really sent from (${sender.address}).`);
  const la = sec.lookalike;
  if (la?.reason === 'similar-domain') issues.unshift(`⚠ This is from ${la.domain}, which looks like ${la.real} but isn't. It may be pretending to be ${la.brand[0].toUpperCase()}${la.brand.slice(1)}.`);
  else if (la?.reason === 'brand-in-domain') issues.unshift(`⚠ This is from ${la.domain}, which uses a company's name but isn't that company's real address (${la.real}).`);
  else if (la?.reason === 'brand-name') issues.unshift(`⚠ The sender calls themselves "${sender.name}" but wrote from ${la.domain}, not from ${la.real}.`);
  else if (la?.reason === 'unusual-characters') issues.unshift(`⚠ The sender's address (${la.domain}) uses look-alike characters from other alphabets.`);
  if (sec.replyToDiffers) issues.push(`Replies will go to ${m.replyTo?.[0]?.address}, not to ${sender.address}.`);
  if (orgDomains.length && orgDomains.some((d) => sender.address?.toLowerCase().endsWith(`@${d}`)) && (sec.spf === 'fail' || sec.dmarc === 'fail')) {
    issues.unshift('⚠ This looks like it is from your own organization, but it was not sent from our servers. It may be a phishing attempt.');
  }
  if (!issues.length) return null;
  return (
    <div className="sec-banner">
      <Icon name="alert" size={18} />
      <div><b>{t("Be careful with this message")}</b>{issues.map((t, i) => <div key={i}>{t}</div>)}
        <small>{t("Don't click links, open attachments or reply with personal information unless you're sure it's genuine.")}</small></div>
    </div>
  );
}

function WhyJunk({ m }) {
  if (!m.spam || !(m.spam.score >= 0)) return null;
  return (
    <div className="why-junk">
      <Icon name="junk" size={16} />
      <div><b>{t("Why is this in Junk?")}</b> <span className="muted small">{t("Spam score")}{' '}{m.spam.score.toFixed(1)}{' '}{t("(blocked at")}{' '}{m.spam.threshold})</span>
        {m.spam.reasons.length > 0 ? <ul>{m.spam.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <div className="small">{t("Several small spam signals added up.")}</div>}
      </div>
    </div>
  );
}

function InviteCard({ m, me }) {
  const inv = m.invite;
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (inv?.method === 'REPLY') api.post('/api/calendar/apply-reply', { folder: m.folder, uid: m.uid }).then((r) => r.ok && setState(r.partstat)).catch(() => {});
  }, [m.uid]);
  if (!inv || !inv.start) return null;
  const mine = inv.attendees?.find((a) => a.email === me.email)?.partstat;
  const start = inv.allDay ? new Date(`${inv.start}T00:00:00`) : new Date(inv.start);
  const end = inv.end ? (inv.allDay ? new Date(`${inv.end}T00:00:00`) : new Date(inv.end)) : null;
  const when = inv.allDay ? start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    : `${start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${end ? ` – ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`;
  const respond = async (response) => {
    setBusy(true);
    try { const r = await api.post('/api/calendar/rsvp', { folder: m.folder, uid: m.uid, response }); setState(r.response); }
    catch (e) { alert(e.message); } finally { setBusy(false); }
  };
  const label = { ACCEPTED: 'You accepted', TENTATIVE: 'You said maybe', DECLINED: 'You declined' };
  return (
    <div className="invite-card">
      <div className="inv-date"><small>{start.toLocaleDateString([], { month: 'short' })}</small><b>{start.getDate()}</b><small>{start.toLocaleDateString([], { weekday: 'short' })}</small></div>
      <div className="inv-body">
        <b>{inv.method === 'CANCEL' ? 'Canceled: ' : inv.method === 'REPLY' ? 'Reply: ' : ''}{inv.title}</b>
        <div className="small">{when}{inv.repeat && inv.repeat !== 'none' ? ` · repeats ${inv.repeat}` : ''}</div>
        {inv.location && <div className="small muted">{inv.location}</div>}
        {inv.organizer && inv.method === 'REQUEST' && <div className="small muted">{t("Organizer:")}{' '}{inv.organizer.name || inv.organizer.email}</div>}
        {inv.method === 'REQUEST' && (
          <div className="inv-actions">
            {state || mine && mine !== 'NEEDS-ACTION' ? <span className="pill ok">{label[state || mine]}</span> : <span className="small">{t("Going?")}</span>}
            <button className="btn sm" disabled={busy} onClick={() => respond('accept')}>{t("Yes")}</button>
            <button className="btn sm" disabled={busy} onClick={() => respond('tentative')}>{t("Maybe")}</button>
            <button className="btn sm" disabled={busy} onClick={() => respond('decline')}>{t("No")}</button>
          </div>
        )}
        {inv.method === 'REPLY' && state && <div className="small ok">{t("Your calendar was updated.")}</div>}
      </div>
    </div>
  );
}

// Someone asked for a read receipt: ask, always send, or never send (Settings -> General)
function ReceiptAsk({ m, prefs, sender }) {
  const [state, setState] = useState(m.receiptRequested && prefs.sendReceipts === 'ask' ? 'ask' : 'done');
  useEffect(() => {
    if (!m.receiptRequested || prefs.sendReceipts === 'ask') return;
    api.post('/api/receipts/send', { folder: m.folder, uid: m.uid, decline: prefs.sendReceipts === 'never' }).catch(() => {});
  }, [m.folder, m.uid]);
  if (state !== 'ask') return state === 'sent' ? <div className="img-banner"><Icon name="check" size={15} /> {t("Read receipt sent.")}</div> : null;
  const answer = (decline) => api.post('/api/receipts/send', { folder: m.folder, uid: m.uid, decline }).then(() => setState(decline ? 'done' : 'sent')).catch(() => setState('done'));
  return (
    <div className="img-banner">
      <Icon name="check" size={15} /> {personName(sender)} {t("asked for a read receipt.")}{' '}
      <button className="link" onClick={() => answer(false)}>{t("Send receipt")}</button>
      <button className="link" onClick={() => answer(true)}>{t("Don't send")}</button>
    </div>
  );
}

// On my own sent email: delivered / read for each recipient, when I asked for receipts
function ReceiptStatus({ m }) {
  const [r, setR] = useState(null);
  useEffect(() => { if (m.messageId) api.get('/api/receipts', { messageId: m.messageId }).then(setR).catch(() => {}); }, [m.messageId]);
  if (!r) return null;
  const when = (t2) => new Date(t2).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="rcpt-status">
      {r.recipients.map((p) => (
        <div key={p.address} className="small">
          <b>{p.address}</b>{' '}
          {p.failed ? <span className="bad">{t("Not delivered")} · {when(p.failed)}</span>
            : <>
              {r.deliveryRequested && (p.delivered ? <span className="ok"><Icon name="check" size={12} /> {t("Delivered")} {when(p.delivered)}</span> : <span className="muted">{t("Delivery receipt requested")}</span>)}
              {r.readRequested && (p.read ? <span className="ok"> <Icon name="check" size={12} /><Icon name="check" size={12} /> {t("Read")} {when(p.read)}</span> : <span className="muted"> · {t("Read receipt requested")}</span>)}
            </>}
        </div>
      ))}
    </div>
  );
}

// My own password-protected email: opened yet? expires when? withdraw it
function SecureStatus({ id }) {
  const [s, setS] = useState(null);
  const load = () => api.get(`/api/secure/${id}`).then(setS).catch(() => {});
  useEffect(() => { load(); }, [id]);
  if (!s) return null;
  const when = (t2) => new Date(t2).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const off = s.revoked || s.expired || s.locked;
  return (
    <div className={`sec-status ${off ? 'off' : ''}`}>
      <Icon name="lock" size={14} /> <b>{t("Password-protected")}</b>
      <span>{s.revoked ? t("Withdrawn") : s.expired ? t("Expired") : s.locked ? t("Locked after too many wrong passwords") : s.openedAt ? `${t("Opened")} ${when(s.openedAt)}` : t("Not opened yet")}</span>
      {!off && <span className="muted">· {t("Expires")} {when(s.expiresAt)}</span>}
      {!off && <button className="link" onClick={() => confirm(t("Withdraw this email? The link will stop working and the encrypted copy is deleted.")) && api.post(`/api/secure/${id}/revoke`).then(load)}>{t("Withdraw")}</button>}
    </div>
  );
}

/** Delivery reports and read receipts, in plain words (the raw report only behind "Technical details"). */
function ReportCard({ m }) {
  const [raw, setRaw] = useState(false);
  const r = m.report;
  const when = fmtDate(m.date, true);
  const subj = r.subject ? <> “<b>{r.subject}</b>”</> : null;
  return (
    <div className="report-card">
      {r.recipients.map((x, i) => {
        const ok = x.kind === 'delivered' || x.kind === 'read';
        const icon = x.kind === 'failed' ? 'close' : x.kind === 'delayed' ? 'clock' : 'check';
        const title = x.kind === 'read' ? t('Read') : x.kind === 'delivered' ? t('Delivered') : x.kind === 'failed' ? t('Not delivered') : x.kind === 'delayed' ? t('Delayed') : t('Receipt');
        return (
          <div key={i} className={`report-line ${ok ? 'ok' : x.kind}`}>
            <span className="report-icon"><Icon name={icon} size={18} /></span>
            <div>
              <div className="report-title">{title}</div>
              <div className="report-text">
                {x.kind === 'read' && <>{t('Your email')}{subj} {t('was opened by')} <b>{x.address}</b>.</>}
                {x.kind === 'delivered' && <>{t('Your email')}{subj} {t('was delivered to')} <b>{x.address}</b>.</>}
                {x.kind === 'delayed' && <>{t('Your email')}{subj} {t('to')} <b>{x.address}</b> {t('hasn’t been delivered yet. Their mail server will keep trying — no need to do anything.')}</>}
                {x.kind === 'failed' && <>{t('Your email')}{subj} {t('couldn’t be delivered to')} <b>{x.address}</b>. {t(x.reason)}</>}
                {x.kind === 'deleted' && <>{t('Your email')}{subj} {t('was deleted without being read by')} <b>{x.address}</b>.</>}
                {x.kind === 'other' && <>{t('A receipt came back from')} <b>{x.address}</b>.</>}
              </div>
              <div className="muted small">{when}</div>
            </div>
          </div>
        );
      })}
      <button className="link small" onClick={() => setRaw((v) => !v)}>{raw ? t('Hide technical details') : t('Technical details')}</button>
      {raw && <pre className="report-raw">{m.text}</pre>}
    </div>
  );
}

/** iMessage-style: "Delivered" / "Read 3:42 PM" under an email you sent to someone on Roammail. */
function ChatStatus({ list }) {
  if (!list?.length) return null;
  const fmtT = (ms) => { const d = new Date(ms); const today = new Date().toDateString() === d.toDateString(); return d.toLocaleString([], today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
  const one = list.length === 1;
  const read = list.filter((x) => x.read);
  const text = one
    ? (list[0].read ? `${t('Read')} ${fmtT(list[0].read)}` : t('Delivered'))
    : read.length === list.length ? `${t('Read by everyone')} · ${fmtT(Math.max(...read.map((x) => x.read)))}` : read.length ? `${t('Read by')} ${read.length} ${t('of')} ${list.length}` : t('Delivered');
  return <div className={`chat-status ${read.length ? 'read' : ''}`} title={list.map((x) => `${x.address}: ${x.read ? `read ${new Date(x.read).toLocaleString()}` : 'delivered'}`).join('\n')}>{text}</div>;
}

/** "Robin is typing…" (another Roammail user writing a reply in this conversation right now). */
function TypingBubble({ ids }) {
  const [who, setWho] = useState({});
  useEffect(() => {
    const on = (e) => {
      const d = e.detail; if (!ids.includes(d.ref)) return;
      setWho((w) => { const n = { ...w }; if (d.stop) delete n[d.from]; else n[d.from] = { name: d.name || d.from.split('@')[0], until: Date.now() + 7000 }; return n; });
    };
    window.addEventListener('roammail:typing', on);
    const tick = setInterval(() => setWho((w) => { const n = Object.fromEntries(Object.entries(w).filter(([, v]) => v.until > Date.now())); return Object.keys(n).length === Object.keys(w).length ? w : n; }), 1000);
    return () => { window.removeEventListener('roammail:typing', on); clearInterval(tick); };
  }, [ids.join(',')]);
  const names = Object.values(who).map((v) => v.name.split(' ')[0]);
  if (!names.length) return null;
  return <div className="typing-bubble" role="status"><span className="dots"><i /><i /><i /></span> {names.join(', ')} {names.length === 1 ? t('is typing…') : t('are typing…')}</div>;
}

function ThreadMessage({ m, expanded, onToggle, onReply, prefs, setPrefs, last, orgDomains, onBlock, isJunk, me, onAddTask, onFollowUp, chatStatus }) {
  const sender = m.from?.[0] || {};
  const trusted = prefs.showImages === 'always' || prefs.trustedSenders.includes(sender.address?.toLowerCase());
  const [allow, setAllow] = useState(trusted);
  const [blocked, setBlocked] = useState(0);
  const [trackers, setTrackers] = useState({ pixels: [], links: 0 });
  // count blocked trackers for the monthly privacy report (once per email, numbers only)
  useEffect(() => {
    const k = `trk:${m.folder}:${m.uid}`;
    if ((!trackers.pixels.length && !trackers.links) || sessionStorage.getItem(k)) return;
    sessionStorage.setItem(k, '1');
    api.post('/api/privacy-report/trackers', { pixels: trackers.pixels.length, links: trackers.links }).catch(() => {});
  }, [trackers.pixels.length, trackers.links]);
  const [showTrackers, setShowTrackers] = useState(false);
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const files = m.report ? [] : (m.attachments || []).filter((a) => !a.inline);
  const external = orgDomains.length > 0 && sender.address && !orgDomains.some((d) => sender.address.toLowerCase().endsWith(`@${d}`));
  const lu = m.listUnsubscribe;
  const unsubUrl = !lu ? null : typeof lu === 'object' ? lu.url || null : (/<(https?:[^>]+)>/.exec(lu) || [])[1] || null;

  if (!expanded) {
    return (
      <div className="tmsg collapsed" onClick={onToggle}>
        <span className="avatar" style={{ background: avatarColor(sender.address) }}>{initials(sender)}</span>
        <b>{personName(sender)}</b>
        <span className="snip">{m.snippet}</span>
        <span className="date">{fmtDate(m.date)}</span>
      </div>
    );
  }
  return (
    <article className="tmsg">
      <header className="tmsg-head" onClick={last ? undefined : onToggle}>
        <button type="button" className="avatar lg avatar-btn" style={{ background: avatarColor(sender.address) }} onClick={(e) => openCard(e, sender)} ><span aria-hidden="true">{initials(sender)}</span><span className="sr-only">{`${personName(sender)}: ${t('contact card')}`}</span></button>
        <div className="who">
          <div><button type="button" className="person-link strong" onClick={(e) => openCard(e, sender)}>{personName(sender)}</button> <span className="muted">&lt;{sender.address}&gt;</span>
            {external && <span className="ext-tag" title={t("This message came from outside your organization")}>{t("External")}</span>}
            {m.security?.dkim === 'pass' && m.security?.dmarc === 'pass' && !m.security?.lookalike && <span className="verified" title={t("Sender's domain verified (DKIM + DMARC)")}><Icon name="check" size={11} /> {t("Verified")}</span>}
            {m.privateDelivery && <span className="private-pill" title={t('Sent between Roammail accounts: it never travelled over the public internet, and was encrypted on the way')}><Icon name="lock" size={11} /> {t('Private')}</span>}
            {m.scan?.checked && !m.scan.virus && !m.scan.phish && sender.address?.toLowerCase() !== me?.email?.toLowerCase() && <span className="scanned" title={t('Checked when it arrived: no viruses found, and scanned for spam and phishing')}><Icon name="shield" size={11} /> {t('Scanned')}</span>}
          </div>
          <div className="muted small" onClick={(e) => { e.stopPropagation(); setDetails((d) => !d); }} style={{ cursor: 'pointer' }}>
            to {[...(m.to || []), ...(m.cc || [])].map((a, i, all) => (<span key={i}>{a.address?.toLowerCase() === me?.email?.toLowerCase() ? 'me' : <button type="button" className="person-link" onClick={(e) => openCard(e, a)}>{personName(a)}</button>}{i < all.length - 1 ? ', ' : ''}</span>))}{!(m.to?.length || m.cc?.length) && 'undisclosed recipients'} <Icon name="down" size={12} />
          </div>
          {details && (
            <div className="details">
              <AddrList label={t("From:")} list={m.from} /><AddrList label={t("To:")} list={m.to} /><AddrList label={t("Cc:")} list={m.cc} />
              <AddrList label={t("Reply-To:")} list={m.replyTo} /><div className="addr-line"><span>{t("Date:")}</span> {fmtDate(m.date, true)}</div>
            </div>
          )}
        </div>
        <div className="tmsg-actions" onClick={(e) => e.stopPropagation()}>
          <span className="date">{fmtDate(m.date, true)}</span>
          <button className="icon-btn" title={t("Reply")} onClick={() => onReply(m, 'reply')}><Icon name="reply" /></button>
          <button className="icon-btn" title={t("Reply all")} onClick={() => onReply(m, 'all')}><Icon name="replyAll" /></button>
          <button className="icon-btn" title={t("Forward")} onClick={() => onReply(m, 'forward')}><Icon name="forward" /></button>
          <div className="dd" onMouseLeave={() => setMenu(false)}>
            <button className="icon-btn" onClick={() => setMenu((x) => !x)} title={t("More")}><Icon name="more" /></button>
            {menu && (
              <div className="menu right">
                {sender.address && <button onClick={async () => {
                  setMenu(false);
                  const parts = (sender.name || '').trim().split(/\s+/);
                  try { await api.post('/api/address-contacts', { first: parts[0] || '', last: parts.slice(1).join(' '), name: sender.name || '', emails: [{ value: sender.address, type: 'work' }] }); alert(`${sender.name || sender.address} was added to your contacts`); }
                  catch (e) { alert(e.message); }
                }}><Icon name="users" />{' '}{t("Add to contacts")}</button>}
                {onAddTask && <button onClick={() => { setMenu(false); onAddTask(m); }}><Icon name="check" />{' '}{t("Add as task")}{' '}<kbd>{t("Shift+T")}</kbd></button>}
                {onFollowUp && m.messageId && <>
                  <div className="menu-note">{t("Remind me if no reply")}</div>
                  {[['Tomorrow', 1], ['In 3 days', 3], ['In a week', 7]].map(([l, d]) => (
                    <button key={d} onClick={() => { setMenu(false); onFollowUp(m, d); }}><Icon name="clock" /> {l}</button>
                  ))}
                </>}
                <button onClick={() => { setMenu(false); window.dispatchEvent(new CustomEvent('roammail:readlater', { detail: m })); }}><Icon name="archive" />{' '}{t("Read later")}</button>
                <button onClick={() => { setMenu(false); window.dispatchEvent(new CustomEvent('roammail:makerule', { detail: m })); }}><Icon name="filter" />{' '}{t("Make a rule…")}</button>
                <button onClick={() => { setMenu(false); window.dispatchEvent(new CustomEvent('roammail:reportscam', { detail: m })); }}><Icon name="shield" />{' '}{t("Report scam or phishing")}</button>
                {sender.address && <button onClick={() => { setMenu(false); onBlock(sender.address); }}><Icon name="block" />{' '}{t("Block")}{' '}{sender.address}</button>}
                <button onClick={() => window.open(mailUrl(`/api/raw?folder=${encodeURIComponent(m.folder)}&uid=${m.uid}`), '_blank')}><Icon name="external" />{' '}{t("View source")}</button>
                <button onClick={() => { const f = document.querySelector(`[data-msg="${m.folder}:${m.uid}"] iframe`); f?.contentWindow?.print(); }}><Icon name="print" />{' '}{t("Print")}</button>
              </div>
            )}
          </div>
        </div>
      </header>
      {isJunk && <WhyJunk m={m} />}
      {!isJunk && <InviteCard m={m} me={me} />}
      <SecurityBanner m={m} sender={sender} orgDomains={orgDomains} />
      {!isJunk && sender.address?.toLowerCase() !== me?.email?.toLowerCase() && <ReceiptAsk m={m} prefs={prefs} sender={sender} />}
      {sender.address?.toLowerCase() === me?.email?.toLowerCase() && (chatStatus ? <ChatStatus list={chatStatus} /> : <ReceiptStatus m={m} />)}
      {m.secureId && sender.address?.toLowerCase() === me?.email?.toLowerCase() && <SecureStatus id={m.secureId} />}
      {isJunk && <div className="img-banner"><Icon name="shield" size={16} />{' '}{t("Links and pictures are turned off in Junk. Mark it as not junk to use them.")}</div>}
      {blocked > 0 && !allow && !isJunk && (
        <div className="img-banner">
          <Icon name="shield" size={16} />{' '}{t("Pictures were blocked to protect your privacy.")}{' '}<button className="link" onClick={() => setAllow(true)}>{t("Show pictures")}</button>
          <button className="link" onClick={() => { setAllow(true); setPrefs((p) => ({ trustedSenders: [...new Set([...p.trustedSenders, sender.address?.toLowerCase()])] })); }}>{t("Always show from")}{' '}{sender.address}</button>
        </div>
      )}
      {(trackers.pixels.length > 0 || trackers.links > 0) && (
        <div className="trk-banner">
          <Icon name="shield" size={15} />{' '}
          <button className="link" onClick={() => setShowTrackers((x) => !x)} aria-expanded={showTrackers}>
            {trackers.pixels.length + trackers.links} {trackers.pixels.length + trackers.links === 1 ? 'tracker' : 'trackers'} blocked
          </button>
          {showTrackers && <div className="small muted">
            {trackers.pixels.length > 0 && <div>{trackers.pixels.length} hidden {trackers.pixels.length === 1 ? 'image' : 'images'} that report when you open this email{[...new Set(trackers.pixels.filter(Boolean))].length ? ` (${[...new Set(trackers.pixels.filter(Boolean))].slice(0, 4).join(', ')})` : ''}</div>}
            {trackers.links > 0 && <div>Tracking codes removed from {trackers.links} {trackers.links === 1 ? 'link' : 'links'}</div>}
          </div>}
        </div>
      )}
      {unsubUrl && <div className="unsub">{t("Mailing list ·")}{' '}<a href={unsubUrl} target="_blank" rel="noreferrer">{t("Unsubscribe")}</a></div>}
      <div className="tmsg-body" data-msg={`${m.folder}:${m.uid}`}>
        {m.report ? <ReportCard m={m} /> : <MessageBody msg={m} allowRemote={allow && !isJunk} onBlocked={setBlocked} onTrackers={setTrackers} disableLinks={isJunk} />}
      </div>
      {files.length > 0 && (
        <div className="attachments">
          {files.map((a) => (
            <a key={a.index} className={`att ${a.risk ? `risk-${a.risk}` : ''}`} href={api.attachmentUrl(m.folder, m.uid, a.index)} download={a.filename}
              onClick={(e) => {
                if (a.risk === 'block') {
                  e.preventDefault();
                  if (confirm(t('This file can run programs on your computer. Files like this are the most common way computers get infected.\n\nOnly open it if you were expecting it and you trust the sender. Download it anyway?'))) location.href = `${api.attachmentUrl(m.folder, m.uid, a.index)}&confirm=1`;
                } else if ((a.risk === 'macro' || a.risk === 'html') && !confirm(a.risk === 'macro' ? t('This Office file contains macros (small programs). Never click “Enable content” unless you trust the sender. Download it?') : t('This attachment is a web page. Fake sign-in pages are often sent like this — never type a password into it. Download it?'))) e.preventDefault();
              }}>
              {a.contentType?.startsWith('image/') && !a.risk ? <img src={api.attachmentUrl(m.folder, m.uid, a.index, true)} alt="" /> : <Icon name={a.risk === 'block' ? 'shield' : 'clip'} size={22} />}
              <div><div className="att-name" title={a.filename}>{a.filename}</div>
                <div className="muted small">{fmtSize(a.size)}{a.risk === 'block' ? ` · ${t('Blocked: can run programs')}` : a.risk === 'macro' ? ` · ${t('Has macros')}` : a.risk === 'html' ? ` · ${t('Web page: careful')}` : a.risk === 'archive' ? ` · ${t('Archive')}` : ''}</div></div>
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

export default function ReadingPane({ folder, msg, me, prefs, setPrefs, conversation, team, onReply: onReplyRaw, act, categories, onClose, isJunk, orgDomains = [], onAddTask, onFollowUp, onThread }) {
  // in a shared mailbox, starting a reply tells teammates "X is replying"
  const onReply = (m, how) => { if (team && how !== 'forward') window.dispatchEvent(new CustomEvent('roammail:replying', { detail: m?.messageId })); onReplyRaw(m, how); };
  const [thread, setThread] = useState(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    if (!msg) return;
    setThread(null); setError('');
    let live = true; let shown = false; let real = false;
    const show = (t, isReal) => {
      if (!live || (real && !isReal)) return;
      if (isReal) real = true;
      setThread(t); onThread?.(t.messages[t.messages.length - 1]);
      if (shown) return; // keep what the person opened or closed
      shown = true;
      const last = t.messages[t.messages.length - 1];
      setExpanded(new Set([`${last.folder}:${last.uid}`, ...t.messages.filter((m) => !m.seen).map((m) => `${m.folder}:${m.uid}`), `${folder}:${msg.uid}`]));
    };
    // loaded ahead of time? show it now; the real open below marks it read and refreshes it
    prefetched(folder, msg.uid, conversation)?.then((t) => show(t, false)).catch(() => {});
    openNow(folder, msg.uid, conversation).then((t) => show(t, true)).catch((e) => { if (live && !shown) setError(e.message); });
    return () => { live = false; };
  }, [folder, msg?.uid, conversation]);

  // iMessage-style status of my emails in this conversation (to other Roammail users), updated live
  const mine = (thread?.messages || []).filter((m) => m.from?.[0]?.address?.toLowerCase() === me?.email?.toLowerCase() && m.messageId).map((m) => m.messageId);
  const [chat, setChat] = useState({});
  useEffect(() => {
    if (!mine.length) { setChat({}); return; }
    api.get('/api/msg-status', { ids: mine.join(',') }).then((r) => setChat(r.status || {})).catch(() => {});
  }, [mine.join(',')]);
  useEffect(() => {
    const on = (e) => {
      const d = e.detail;
      setChat((c) => (c[d.messageId] ? { ...c, [d.messageId]: c[d.messageId].map((x) => (x.address === d.recipient ? { ...x, read: d.read } : x)) } : c));
    };
    window.addEventListener('roammail:status', on); return () => window.removeEventListener('roammail:status', on);
  }, []);
  const threadIds = (thread?.messages || []).map((m) => m.messageId).filter(Boolean);

  if (!msg) {
    return (
      <section className="reading empty-pane">
        <Icon name="mail" size={48} />
        <b>{t("Nothing selected")}</b>
        <p className="muted">{t("Pick a message to read it here.")}</p>
        <small className="muted">{t("Tip: press")}{' '}<kbd>?</kbd>{' '}{t("for keyboard shortcuts")}</small>
      </section>
    );
  }

  const catColor = (n) => categories.find((c) => c.name.replace(/[^A-Za-z0-9_-]/g, '') === n)?.color || '#888';
  return (
    <section className="reading">
      <div className="reading-head">
        <button className="icon-btn back" onClick={onClose} title={t("Back (u)")}><Icon name="back" /></button>
        <h1>{msg.subject}</h1>
        <div className="reading-tools">
          {msg.categories?.map((c) => <span key={c} className="cat" style={{ '--c': catColor(c) }}>{c}</span>)}
        </div>
      </div>
      {isJunk && <div className="banner warn">{t("This message was identified as junk. Be careful with links and attachments.")}{' '}<button className="link" onClick={() => act.notJunk(msg.uid, msg.from?.[0]?.address)}>{t("It's not junk")}</button></div>}
      {team && thread && <TeamBar msg={thread.messages[thread.messages.length - 1]} subject={msg.subject} />}
      <div className="thread">
        {error && <div className="form-error">{error}</div>}
        {!thread && !error && <div className="list-msg"><div className="spinner" /></div>}
        {thread && <AiPanel folder={folder} uid={msg?.uid ?? thread.messages[thread.messages.length - 1].uid} last={thread.messages[thread.messages.length - 1]} onReply={onReply} />}
        {thread?.messages.length > 1 && <div className="muted small thread-count">{thread.messages.length}{' '}{t("messages in this conversation")}</div>}
        {thread?.messages.map((m, i) => {
          const k = `${m.folder}:${m.uid}`;
          return (
            <ThreadMessage key={k} m={m} last={i === thread.messages.length - 1} expanded={expanded.has(k)} prefs={prefs} setPrefs={setPrefs}
              onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })}
              onReply={onReply} orgDomains={orgDomains} onBlock={act.block} isJunk={isJunk} me={me} onAddTask={onAddTask} onFollowUp={onFollowUp} chatStatus={chat[m.messageId]} />
          );
        })}
        {thread && <TypingBubble ids={threadIds} />}
      </div>
      {thread && (
        <div className="reply-bar">
          <button className="btn" onClick={() => onReply(thread.messages[thread.messages.length - 1], 'reply')}><Icon name="reply" />{' '}{t("Reply")}</button>
          <button className="btn" onClick={() => onReply(thread.messages[thread.messages.length - 1], 'all')}><Icon name="replyAll" />{' '}{t("Reply all")}</button>
          <button className="btn" onClick={() => onReply(thread.messages[thread.messages.length - 1], 'forward')}><Icon name="forward" />{' '}{t("Forward")}</button>
        </div>
      )}
    </section>
  );
}
