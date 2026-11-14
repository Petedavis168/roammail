import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';
import { fmtDate } from '../util.js';
import { t } from '../i18n.js';

/** Shared mailbox teamwork for one email: who it's assigned to, team notes, and who else is on it right now. */
export default function TeamBar({ msg, subject }) {
  const toast = useToast();
  const id = String(msg?.messageId || '').replace(/^<|>$/g, '');
  const [d, setD] = useState(null);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const replying = useRef(false);
  const load = () => api.get('/api/team/message', { id }).then(setD).catch(() => {});
  useEffect(() => {
    if (!id) return undefined;
    setD(null); setOpen(false);
    const beat = () => api.post('/api/team/presence', { id, state: replying.current ? 'replying' : 'viewing' }).catch(() => {});
    beat(); load();
    const iv = setInterval(() => { beat(); load(); }, 15000);
    const onLive = (e) => { if (e.detail?.id === id) load(); };
    const onReply = (e) => { if (String(e.detail || '').replace(/^<|>$/g, '').toLowerCase() === id.toLowerCase()) { replying.current = true; beat(); } };
    window.addEventListener('roammail:team', onLive); window.addEventListener('roammail:replying', onReply);
    return () => {
      clearInterval(iv); window.removeEventListener('roammail:team', onLive); window.removeEventListener('roammail:replying', onReply);
      replying.current = false; api.post('/api/team/presence', { id, state: 'done' }).catch(() => {});
    };
  }, [id]);
  if (!id || !d) return null;
  const assign = async (to) => { try { await api.post('/api/team/assign', { id, to: to || null, subject }); toast(to ? `${t('Assigned to')} ${to === d.me ? t('you') : d.members.find((m) => m.email === to)?.name || to}` : t('Unassigned')); load(); } catch (e) { toast(e.message, { error: true }); } };
  const add = async (e) => { e.preventDefault(); if (!note.trim()) return; try { await api.post('/api/team/notes', { id, body: note.trim() }); setNote(''); load(); } catch (x) { toast(x.message, { error: true }); } };
  const del = async (n) => { try { await api.del(`/api/team/notes/${n.id}`); load(); } catch (x) { toast(x.message, { error: true }); } };
  const replyingNow = d.others.filter((o) => o.state === 'replying');
  const viewing = d.others.filter((o) => o.state !== 'replying');
  return (
    <section className="team-bar" aria-label={t('Team')}>
      {replyingNow.length > 0 && <div className="team-alert" role="status">✍ {replyingNow.map((o) => o.name).join(', ')} {replyingNow.length > 1 ? t('are replying to this right now') : t('is replying to this right now')}</div>}
      <div className="team-row">
        <label className="small">{t('Assigned to')}{' '}
          <select value={d.assignee?.email || ''} onChange={(e) => assign(e.target.value)}>
            <option value="">{t('Nobody')}</option>
            {d.members.map((m) => <option key={m.email} value={m.email}>{m.email === d.me ? `${t('Me')} (${m.name || m.email})` : (m.name || m.email)}</option>)}
          </select>
        </label>
        {d.assignee?.email !== d.me && <button className="link small" onClick={() => assign(d.me)}>{t('Take it')}</button>}
        {viewing.length > 0 && <span className="small muted team-viewing">👀 {viewing.map((o) => o.name).join(', ')} {t('also has this open')}</span>}
        <button className="link small team-notes-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{t('Team notes')} ({d.notes.length})</button>
      </div>
      {open && (
        <div className="team-notes">
          <p className="small muted">{t('Only your team sees these. They’re never sent to the customer.')}</p>
          {d.notes.map((n) => (
            <div key={n.id} className="team-note">
              <b>{n.name}</b> <small className="muted">{fmtDate(new Date(n.at).toISOString())}</small>
              {n.mine && <button className="link small" onClick={() => del(n)} aria-label={t('Delete note')}>{t('Delete')}</button>}
              <div className="team-note-body">{n.body}</div>
            </div>
          ))}
          <form onSubmit={add} className="team-note-add">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Add a note for your team…')} aria-label={t('Add a note for your team')} maxLength={4000} />
            <button className="btn sm" disabled={!note.trim()}>{t('Add')}</button>
          </form>
        </div>
      )}
    </section>
  );
}
