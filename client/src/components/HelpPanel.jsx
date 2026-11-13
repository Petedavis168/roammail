import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { t } from '../i18n.js';
import { WHATS_NEW, markSeen } from '../whatsnew.js';

/** Help without leaving your mail: search the guides, ask the assistant, reach a person, and see what's new. */
export default function HelpPanel({ onClose, startTab = 'help' }) {
  const [tab, setTab] = useState(startTab);
  const [articles, setArticles] = useState([]);
  const [assistant, setAssistant] = useState(false);
  const [open, setOpen] = useState(null); // article being read
  const [q, setQ] = useState('');
  const [chat, setChat] = useState([]); // { role: 'user'|'assistant', text, articles?, contact? }
  const [busy, setBusy] = useState(false);
  const [contact, setContact] = useState(null); // { message, sent }
  const ref = useRef(); const inputRef = useRef(); const endRef = useRef();
  useEffect(() => { api.get('/api/help/articles').then((r) => { setArticles(r.articles); setAssistant(r.assistant); }).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'new') markSeen(); }, [tab]);
  useEffect(() => { inputRef.current?.focus(); }, [tab]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [chat, busy]);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); open ? setOpen(null) : onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);
  const matches = useMemo(() => {
    const w = q.toLowerCase().match(/[a-z0-9áéíóúñü]{2,}/g) || [];
    if (!w.length) return [];
    return articles.map((a) => ({ a, s: w.reduce((n, x) => n + (a.title.toLowerCase().includes(x) ? 3 : a.text.toLowerCase().includes(x) ? 1 : 0), 0) }))
      .filter((x) => x.s).sort((x, y) => y.s - x.s).slice(0, 5).map((x) => x.a);
  }, [q, articles]);
  const ask = async (e) => {
    e?.preventDefault();
    const question = q.trim();
    if (!question || busy) return;
    const history = chat.map(({ role, text }) => ({ role, text }));
    setChat((c) => [...c, { role: 'user', text: question }]); setQ(''); setBusy(true);
    try {
      const r = await api.post('/api/help/ask', { question, history });
      setChat((c) => [...c, { role: 'assistant', text: r.answer || (r.articles.length ? t('These guides might help:') : t('I couldn’t find a guide for that. Our team can help.')), articles: r.articles, contact: r.contactSupport, note: r.error }]);
    } catch (x) { setChat((c) => [...c, { role: 'assistant', text: x.message, contact: true }]); }
    setBusy(false);
  };
  const send = async (e) => {
    e.preventDefault();
    try { const r = await api.post('/api/help/ticket', { topic: 'From the help panel', message: contact.message, transcript: chat.map(({ role, text }) => ({ role, text })) }); setContact({ ...contact, sent: r.id }); }
    catch (x) { setContact({ ...contact, error: x.message }); }
  };
  const read = (slug) => setOpen(articles.find((a) => a.slug === slug) || null);

  return (
    <div ref={ref} className="help-panel" role="dialog" aria-modal="false" aria-label={t('Help')}>
      <div className="help-head">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'help'} className={tab === 'help' ? 'on' : ''} onClick={() => { setTab('help'); setOpen(null); }}>{t('Help')}</button>
          <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => { setTab('new'); setOpen(null); }}>{t('What’s new')}</button>
        </div>
        <button className="icon-btn xs" onClick={onClose} aria-label={t('Close help')}><Icon name="close" size={16} /></button>
      </div>

      {tab === 'new' ? (
        <div className="help-body">
          {WHATS_NEW.map((n) => (
            <article key={n.id} className="whatsnew-item">
              <small className="muted">{new Date(`${n.date}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</small>
              <h2>{t(n.title)}</h2><p>{t(n.body)}</p>
              {n.link && <button className="link small" onClick={() => { setTab('help'); read(n.link); }}>{t('How it works')}</button>}
            </article>
          ))}
        </div>
      ) : open ? (
        <div className="help-body">
          <button className="link small" onClick={() => setOpen(null)}>← {t('Back')}</button>
          <h2 className="help-title">{open.title}</h2><p className="help-article">{open.text}</p>
          <a className="link small" href={`/help/${open.slug}`} target="_blank" rel="noreferrer">{t('Open in a new tab')}</a>
        </div>
      ) : (
        <div className="help-body">
          {!chat.length && <>
            <p className="muted small">{assistant ? t('Ask anything about Roammail, or search the guides.') : t('Search the guides, or write to our team.')}</p>
            {!q && <div className="help-popular">{articles.slice(0, 6).map((a) => <button key={a.slug} className="chip" onClick={() => read(a.slug)}>{a.title}</button>)}</div>}
            {matches.length > 0 && <ul className="help-matches">{matches.map((a) => <li key={a.slug}><button className="link" onClick={() => read(a.slug)}>{a.title}</button></li>)}</ul>}
          </>}
          <div className="help-chat" aria-live="polite">
            {chat.map((m, i) => (
              <div key={i} className={`help-msg ${m.role}`}>
                <div className="help-bubble">{m.text}</div>
                {m.articles?.length > 0 && <div className="help-links">{m.articles.map((a) => <button key={a.slug} className="chip" onClick={() => read(a.slug)}>{a.title}</button>)}</div>}
                {m.contact && !contact && <button className="link small" onClick={() => setContact({ message: chat.filter((x) => x.role === 'user').map((x) => x.text).join('\n') })}>{t('Ask our team')}</button>}
              </div>
            ))}
            {busy && <div className="help-msg assistant"><div className="help-bubble typing" aria-label={t('Writing an answer')}><span /><span /><span /></div></div>}
            <div ref={endRef} />
          </div>
          {contact && (contact.sent
            ? <div className="help-sent">{t('Thanks, our team has it. Reference')} #{contact.sent}. {t('We’ll reply to your Roammail address, usually within one business day.')}</div>
            : <form className="help-contact" onSubmit={send}>
              <label className="small" htmlFor="help-contact-msg"><b>{t('Message our team')}</b></label>
              <textarea id="help-contact-msg" rows={4} value={contact.message} onChange={(e) => setContact({ ...contact, message: e.target.value })} required maxLength={5000} />
              {contact.error && <div className="form-error small">{contact.error}</div>}
              <div className="row-actions-inline"><button className="btn primary sm">{t('Send')}</button> <button type="button" className="link small" onClick={() => setContact(null)}>{t('Cancel')}</button></div>
              <small className="muted">{t('Never include your password. We’ll never ask for it.')}</small>
            </form>)}
          <form className="help-ask" onSubmit={ask}>
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={assistant ? t('Ask a question…') : t('Search help…')} aria-label={assistant ? t('Ask a question') : t('Search help')} maxLength={1000} />
            <button className="btn primary sm" disabled={!q.trim() || busy} aria-label={t('Send question')}><Icon name="send" size={16} /></button>
          </form>
          {assistant && <small className="muted help-foot">{t('Answers are written by AI from our guides and can be wrong. It can’t see your mail.')}</small>}
          {!contact && <button className="link small" onClick={() => setContact({ message: '' })}>{t('Write to our team instead')}</button>}
        </div>
      )}
    </div>
  );
}
