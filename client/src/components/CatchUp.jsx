import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { useToast } from './Toast.jsx';
import { fmtDate, personName, avatarColor, initials } from '../util.js';
import { safeHtml } from '../safehtml.js';
import { t } from '../i18n.js';

/**
 * Catch up: get through unread email without feeling buried.
 *  1. One-tap clean-ups for the easy stuff (newsletters, notifications, anything old, one noisy sender)
 *  2. "Go through them" — the people who wrote to you, one at a time: Keep, Archive, Reply, Later
 *  3. Auto-tidy, so it doesn't pile up again
 */
export default function CatchUp({ onClose, onReply, onChanged, onRule }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  const [cards, setCards] = useState(null); // quick catch-up queue
  const load = () => api.get('/api/catchup').then(setD).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []);

  const run = async (key, body, msg) => {
    setBusy(key);
    try { const r = await api.post('/api/catchup/apply', body); toast(`${msg} (${r.done})`); onChanged?.(); await load(); }
    catch (e) { toast(e.message, { error: true }); }
    setBusy('');
  };
  const saveTidy = async (patch) => {
    const next = { ...d.settings, ...patch };
    setD({ ...d, settings: next });
    try { await api.put('/api/catchup/settings', next); const r = await api.post('/api/catchup/autotidy', { force: true }); const n = r.done ? r.done.newsletters + r.done.updates + r.done.old : 0; toast(n ? `${t('Saved. Tidied')} ${n} ${t('emails just now.')}` : t('Saved')); onChanged?.(); load(); }
    catch (e) { toast(e.message, { error: true }); }
  };
  const startCards = async () => {
    const r = await api.get('/api/messages', { folder: 'INBOX', tab: 'primary', filter: 'unread', pageSize: 100 });
    setCards({ list: r.messages, i: 0, done: 0, current: null });
  };

  if (cards) return <Cards cards={cards} setCards={setCards} onReply={onReply} onDone={() => { setCards(null); onChanged?.(); load(); }} />;

  return (
    <section className="list catchup">
      <div className="list-head"><h2>{t('Catch up')}</h2><button className="icon-btn" aria-label={t('Close')} onClick={onClose}><Icon name="close" /></button></div>
      {!d && <div className="list-msg"><div className="spinner" /></div>}
      {d && (
        <div className="catchup-body">
          <div className="catchup-hero">
            <div className="catchup-num">{d.unread}</div>
            <div><b>{d.unread ? t('unread emails') : t('You’re all caught up!')}</b>
              <div className="muted small">{d.unread ? `${t('Only')} ${d.primary} ${d.primary === 1 ? t('is from a real person') : t('are from real people')}. ${t('Let’s clear the rest in a few taps.')}` : t('Nothing waiting. Enjoy your day.')}</div></div>
          </div>

          {d.primary > 0 && (
            <button className="catchup-go" onClick={startCards}><Icon name="inbox" size={20} /><span><b>{t('Go through the')} {d.primary} {t('from people')}</b><small>{t('One at a time: keep, archive, reply or later. About')} {Math.max(1, Math.round(d.primary * 0.15))} {t('min')}</small></span><Icon name="chevron" size={18} /></button>
          )}

          <h4>{t('Quick clean-ups')}</h4>
          {[
            ['newsletters', 'list', 'Newsletters', d.newsletters, 'unread newsletters and mailing lists'],
            ['updates', 'bell', 'Notifications & updates', d.updates, 'receipts, alerts and automatic emails'],
            ['old', 'clock', 'Older than a month', d.old, 'unread emails more than 30 days old'],
          ].filter((x) => x[3] > 0).map(([k, ic, title, n, sub]) => (
            <div className="catchup-row" key={k}>
              <Icon name={ic} size={18} /><span><b>{n} {t(title)}</b><small>{t(sub)}</small></span>
              <button className="btn sm" disabled={!!busy} onClick={() => run(k, { what: k, action: 'read' }, t('Marked as read'))}>{busy === k ? '…' : t('Mark read')}</button>
              <button className="btn sm" disabled={!!busy} onClick={() => run(k, { what: k, action: 'archive' }, t('Archived'))}>{t('Archive')}</button>
            </div>
          ))}
          {d.senders.length > 0 && <>
            <h4>{t('Who’s filling your inbox')}</h4>
            {d.senders.map((s) => (
              <div className="catchup-row" key={s.address}>
                <span className="avatar sm" style={{ background: avatarColor(s.address) }}>{initials(s)}</span>
                <span><b>{personName(s)}</b><small>{s.count} {t('unread')} · {s.address}</small></span>
                <button className="btn sm" disabled={!!busy} onClick={() => run(s.address, { what: 'sender', address: s.address, action: 'read' }, t('Marked as read'))}>{t('Mark read')}</button>
                <button className="btn sm" disabled={!!busy} onClick={() => run(s.address, { what: 'sender', address: s.address, action: 'archive' }, t('Archived'))}>{t('Archive')}</button>
                <button className="icon-btn" title={t('Make a rule for this sender')} onClick={() => onRule({ from: [{ address: s.address, name: s.name }] })}><Icon name="filter" size={15} /></button>
              </div>
            ))}
          </>}
          {d.unread > 0 && <button className="link small danger-link" disabled={!!busy} onClick={() => confirm(`${t('Mark all')} ${d.unread} ${t('unread emails as read?')}`) && run('all', { what: 'all', action: 'read' }, t('All marked as read'))}>{t('Fresh start: mark everything as read')}</button>}

          <h4>{t('Keep it tidy automatically')}</h4>
          <div className="catchup-tidy">
            <label className="row-field">{t('Mark newsletters as read after')} <select value={d.settings.newsletters} onChange={(e) => saveTidy({ newsletters: Number(e.target.value) })}><option value={0}>{t('Never')}</option><option value={1}>{t('1 day')}</option><option value={3}>{t('3 days')}</option><option value={7}>{t('1 week')}</option></select></label>
            <label className="row-field">{t('Archive notifications & updates after')} <select value={d.settings.updates} onChange={(e) => saveTidy({ updates: Number(e.target.value) })}><option value={0}>{t('Never')}</option><option value={3}>{t('3 days')}</option><option value={7}>{t('1 week')}</option><option value={14}>{t('2 weeks')}</option></select></label>
            <label className="row-field">{t('Mark anything unread as read after')} <select value={d.settings.old} onChange={(e) => saveTidy({ old: Number(e.target.value) })}><option value={0}>{t('Never')}</option><option value={30}>{t('1 month')}</option><option value={60}>{t('2 months')}</option><option value={90}>{t('3 months')}</option></select></label>
            <p className="muted small">{t('Nothing is deleted: archived emails are in Archive and searchable. Email from people is never archived automatically.')}</p>
          </div>
        </div>
      )}
    </section>
  );
}

/** One unread email at a time, with big buttons. Keyboard: K keep, A archive, R reply, L later. */
function Cards({ cards, setCards, onReply, onDone }) {
  const toast = useToast();
  const m = cards.list[cards.i];
  const [full, setFull] = useState(null);
  useEffect(() => { setFull(null); if (m) api.get('/api/message', { folder: 'INBOX', uid: m.uid, peek: 1 }).then(setFull).catch(() => {}); }, [m?.uid]);
  const next = (counted) => setCards((c) => ({ ...c, i: c.i + 1, done: c.done + (counted ? 1 : 0) }));
  const keep = async () => { await api.flags('INBOX', [m.uid], ['\\Seen'], []).catch(() => {}); next(true); };
  const archive = async () => { try { await api.flags('INBOX', [m.uid], ['\\Seen'], []); await api.post('/api/move', { folder: 'INBOX', uids: [m.uid], to: '@archive' }); } catch (e) { toast(e.message, { error: true }); } next(true); };
  const reply = () => { if (full) onReply({ ...full, folder: 'INBOX', uid: m.uid }); keep(); };
  useEffect(() => {
    // capture phase, so the inbox's own shortcuts (where "a" is reply-all) don't also fire
    const on = (e) => { if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable || !m || e.ctrlKey || e.metaKey) return; const f = { k: keep, a: archive, r: reply, l: () => next(false) }[e.key.toLowerCase()]; if (f) { e.preventDefault(); e.stopImmediatePropagation(); f(); } };
    window.addEventListener('keydown', on, true); return () => window.removeEventListener('keydown', on, true);
  });
  if (!m) {
    return (
      <section className="list catchup">
        <div className="catchup-done"><div className="catchup-party">🎉</div><h2>{t('All done!')}</h2><p className="muted">{cards.done} {t('emails handled.')}</p><button className="btn primary" onClick={onDone}>{t('Back to inbox')}</button></div>
      </section>
    );
  }
  const who = m.from?.[0] || {};
  return (
    <section className="list catchup">
      <div className="list-head"><h2>{t('Catch up')}</h2><span className="muted small">{cards.i + 1} / {cards.list.length}</span><button className="btn sm" onClick={onDone}>{t('Stop')}</button></div>
      <div className="catchup-progress"><i style={{ width: `${(cards.i / cards.list.length) * 100}%` }} /></div>
      <div className="catchup-card">
        <div className="cc-head"><span className="avatar" style={{ background: avatarColor(who.address) }}>{initials(who)}</span><div><b>{personName(who)}</b><div className="muted small">{fmtDate(m.date, true)}</div></div></div>
        <h3>{m.subject || t('(no subject)')}</h3>
        <div className="cc-body">{full ? (full.text ? full.text.slice(0, 1200) : <span dangerouslySetInnerHTML={{ __html: safeHtml(full.html || '').slice(0, 4000) }} />) : m.snippet}</div>
      </div>
      <div className="catchup-actions">
        <button className="ca keep" onClick={keep}><Icon name="check" size={22} /><span>{t('Keep')}</span><kbd>K</kbd></button>
        <button className="ca archive" onClick={archive}><Icon name="archive" size={22} /><span>{t('Archive')}</span><kbd>A</kbd></button>
        <button className="ca reply" onClick={reply}><Icon name="reply" size={22} /><span>{t('Reply')}</span><kbd>R</kbd></button>
        <button className="ca later" onClick={() => next(false)}><Icon name="clock" size={22} /><span>{t('Later')}</span><kbd>L</kbd></button>
      </div>
      <p className="muted small" style={{ textAlign: 'center' }}>{t('Keep = mark read and leave it in your inbox. Later = leave it unread for now.')}</p>
    </section>
  );
}
