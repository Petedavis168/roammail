import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtDate, fmtSize, personName, avatarColor, initials } from '../util.js';
import MessageBody from './MessageBody.jsx';

function AddrList({ label, list }) {
  if (!list?.length) return null;
  return <div className="addr-line"><span>{label}</span> {list.map((a, i) => <span key={i} title={a.address}>{a.name || a.address}{i < list.length - 1 ? ', ' : ''}</span>)}</div>;
}

function ThreadMessage({ m, expanded, onToggle, onReply, prefs, setPrefs, last }) {
  const sender = m.from?.[0] || {};
  const trusted = prefs.showImages === 'always' || prefs.trustedSenders.includes(sender.address?.toLowerCase());
  const [allow, setAllow] = useState(trusted);
  const [blocked, setBlocked] = useState(0);
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState(false);
  const files = (m.attachments || []).filter((a) => !a.inline);
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
        <span className="avatar lg" style={{ background: avatarColor(sender.address) }}>{initials(sender)}</span>
        <div className="who">
          <div><b>{personName(sender)}</b> <span className="muted">&lt;{sender.address}&gt;</span></div>
          <div className="muted small" onClick={(e) => { e.stopPropagation(); setDetails((d) => !d); }} style={{ cursor: 'pointer' }}>
            to {[...(m.to || []), ...(m.cc || [])].map(personName).join(', ') || 'undisclosed recipients'} <Icon name="down" size={12} />
          </div>
          {details && (
            <div className="details">
              <AddrList label="From:" list={m.from} /><AddrList label="To:" list={m.to} /><AddrList label="Cc:" list={m.cc} />
              <AddrList label="Reply-To:" list={m.replyTo} /><div className="addr-line"><span>Date:</span> {fmtDate(m.date, true)}</div>
            </div>
          )}
        </div>
        <div className="tmsg-actions" onClick={(e) => e.stopPropagation()}>
          <span className="date">{fmtDate(m.date, true)}</span>
          <button className="icon-btn" title="Reply" onClick={() => onReply(m, 'reply')}><Icon name="reply" /></button>
          <button className="icon-btn" title="Reply all" onClick={() => onReply(m, 'all')}><Icon name="replyAll" /></button>
          <button className="icon-btn" title="Forward" onClick={() => onReply(m, 'forward')}><Icon name="forward" /></button>
          <div className="dd" onMouseLeave={() => setMenu(false)}>
            <button className="icon-btn" onClick={() => setMenu((x) => !x)} title="More"><Icon name="more" /></button>
            {menu && (
              <div className="menu right">
                <button onClick={() => window.open(`/api/raw?folder=${encodeURIComponent(m.folder)}&uid=${m.uid}`, '_blank')}><Icon name="external" /> View source</button>
                <button onClick={() => { const f = document.querySelector(`[data-msg="${m.folder}:${m.uid}"] iframe`); f?.contentWindow?.print(); }}><Icon name="print" /> Print</button>
              </div>
            )}
          </div>
        </div>
      </header>
      {blocked > 0 && !allow && (
        <div className="img-banner">
          <Icon name="shield" size={16} /> Pictures were blocked to protect your privacy.
          <button className="link" onClick={() => setAllow(true)}>Show pictures</button>
          <button className="link" onClick={() => { setAllow(true); setPrefs((p) => ({ trustedSenders: [...new Set([...p.trustedSenders, sender.address?.toLowerCase()])] })); }}>Always show from {sender.address}</button>
        </div>
      )}
      {unsubUrl && <div className="unsub">Mailing list · <a href={unsubUrl} target="_blank" rel="noreferrer">Unsubscribe</a></div>}
      <div className="tmsg-body" data-msg={`${m.folder}:${m.uid}`}>
        <MessageBody msg={m} allowRemote={allow} onBlocked={setBlocked} />
      </div>
      {files.length > 0 && (
        <div className="attachments">
          {files.map((a) => (
            <a key={a.index} className="att" href={api.attachmentUrl(m.folder, m.uid, a.index)} download={a.filename}>
              {a.contentType?.startsWith('image/') ? <img src={api.attachmentUrl(m.folder, m.uid, a.index, true)} alt="" /> : <Icon name="clip" size={22} />}
              <div><div className="att-name" title={a.filename}>{a.filename}</div><div className="muted small">{fmtSize(a.size)}</div></div>
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

export default function ReadingPane({ folder, msg, me, prefs, setPrefs, conversation, onReply, act, categories, onClose, isJunk }) {
  const [thread, setThread] = useState(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    if (!msg) return;
    setThread(null); setError('');
    const p = conversation ? api.thread(folder, msg.uid) : api.get('/api/message', { folder, uid: msg.uid }).then((m) => ({ subject: m.subject, messages: [m] }));
    p.then((t) => {
      setThread(t);
      const last = t.messages[t.messages.length - 1];
      setExpanded(new Set([`${last.folder}:${last.uid}`, ...t.messages.filter((m) => !m.seen).map((m) => `${m.folder}:${m.uid}`), `${folder}:${msg.uid}`]));
    }).catch((e) => setError(e.message));
  }, [folder, msg?.uid, conversation]);

  if (!msg) {
    return (
      <section className="reading empty-pane">
        <Icon name="mail" size={64} />
        <p>Select an item to read</p>
        <small className="muted">Tip: press <kbd>?</kbd> for keyboard shortcuts</small>
      </section>
    );
  }

  const catColor = (n) => categories.find((c) => c.name.replace(/[^A-Za-z0-9_-]/g, '') === n)?.color || '#888';
  return (
    <section className="reading">
      <div className="reading-head">
        <button className="icon-btn back" onClick={onClose} title="Back (u)"><Icon name="back" /></button>
        <h1>{msg.subject}</h1>
        <div className="reading-tools">
          {msg.categories?.map((c) => <span key={c} className="cat" style={{ '--c': catColor(c) }}>{c}</span>)}
          <button className="icon-btn" title="Archive (e)" onClick={() => act.archive(msg.uid)}><Icon name="archive" /></button>
          <button className="icon-btn" title="Delete (#)" onClick={() => act.del(msg.uid)}><Icon name="trash" /></button>
          <button className="icon-btn" title={msg.flagged ? 'Unflag' : 'Flag (s)'} onClick={() => act.flag(msg.uid)}>
            <Icon name="flag" fill={msg.flagged ? 'currentColor' : 'none'} style={{ color: msg.flagged ? '#d13438' : undefined }} />
          </button>
          <button className="icon-btn" title="Mark unread" onClick={() => { act.read(false, msg.uid); onClose(); }}><Icon name="mail" /></button>
        </div>
      </div>
      {isJunk && <div className="banner warn">This message was identified as junk. Be careful with links and attachments. <button className="link" onClick={() => act.notJunk(msg.uid)}>It's not junk</button></div>}
      <div className="thread">
        {error && <div className="form-error">{error}</div>}
        {!thread && !error && <div className="list-msg"><div className="spinner" /></div>}
        {thread?.messages.length > 1 && <div className="muted small thread-count">{thread.messages.length} messages in this conversation</div>}
        {thread?.messages.map((m, i) => {
          const k = `${m.folder}:${m.uid}`;
          return (
            <ThreadMessage key={k} m={m} last={i === thread.messages.length - 1} expanded={expanded.has(k)} prefs={prefs} setPrefs={setPrefs}
              onToggle={() => setExpanded((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })}
              onReply={onReply} />
          );
        })}
        {thread && (
          <div className="quick-reply">
            <button className="btn" onClick={() => onReply(thread.messages[thread.messages.length - 1], 'reply')}><Icon name="reply" /> Reply</button>
            <button className="btn" onClick={() => onReply(thread.messages[thread.messages.length - 1], 'all')}><Icon name="replyAll" /> Reply all</button>
            <button className="btn" onClick={() => onReply(thread.messages[thread.messages.length - 1], 'forward')}><Icon name="forward" /> Forward</button>
          </div>
        )}
      </div>
    </section>
  );
}
