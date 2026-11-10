import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { useToast } from './Toast.jsx';
import { fmtDate, avatarColor, initials } from '../util.js';
import { t } from '../i18n.js';

/**
 * A person's card, like Outlook's: who they are, ways to reach them, your recent emails both ways and your notes.
 * Opens next to the name that was clicked (a sheet from the bottom on phones). person = { address, name }.
 */
export default function ContactCard({ person, anchor, onClose, onEmail, onMeeting, onOpenMessage, onShowAll, onBlock, me }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [pos, setPos] = useState(null);
  const [note, setNote] = useState('');
  const ref = useRef();
  const address = String(person.address || '').toLowerCase();
  const load = () => api.get('/api/people/card', { email: address }).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [address]);
  useEffect(() => {
    const key = (e) => e.key === 'Escape' && onClose();
    const click = (e) => { if (ref.current && !ref.current.contains(e.target) && !anchor?.contains?.(e.target)) onClose(); };
    window.addEventListener('keydown', key); document.addEventListener('mousedown', click);
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('mousedown', click); };
  }, []);
  // Place it under (or above) the name, kept on screen
  useLayoutEffect(() => {
    if (!ref.current || innerWidth < 700) { setPos(null); return; }
    const r = anchor?.getBoundingClientRect?.() || { left: innerWidth / 2 - 180, bottom: 120, top: 120 };
    const h = ref.current.offsetHeight; const w = ref.current.offsetWidth;
    const below = r.bottom + 8 + h < innerHeight;
    setPos({ left: Math.max(12, Math.min(r.left, innerWidth - w - 12)), top: below ? r.bottom + 8 : Math.max(12, r.top - h - 8) });
  }, [d, err]);

  const name = d?.name || person.name || address.split('@')[0];
  const isMe = address === me?.email?.toLowerCase();
  const copy = async () => { try { await navigator.clipboard.writeText(address); toast(t('Email address copied')); } catch { /* not allowed */ } };
  const save = async () => {
    try {
      await api.post('/api/address-contacts', { name, emails: [{ value: address, type: 'work' }], company: d?.company === 'Your company' ? '' : d?.company || '' });
      toast(t('Added to your contacts')); load();
    } catch (e) { toast(e.message, { error: true }); }
  };
  const addNote = async (e) => {
    e.preventDefault();
    if (!note.trim()) return;
    try { await api.post('/api/notes', { body: note.trim(), contact: address }); setNote(''); load(); } catch (x) { toast(x.message, { error: true }); }
  };
  const since = d?.stats?.first ? new Date(d.stats.first).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : null;

  return (
    <div className={`ccard-wrap ${pos ? '' : 'sheet'}`} role="presentation">
      <div ref={ref} className="ccard" role="dialog" aria-label={`${t('Contact card')}: ${name}`} style={pos ? { left: pos.left, top: pos.top } : undefined}>
        <div className="ccard-head">
          <span className="ccard-avatar" style={{ background: avatarColor(address) }}>{initials({ name, address })}</span>
          <div className="ccard-id">
            <b className="ccard-name">{name}</b>
            {(d?.title || d?.company) && <span className="ccard-role">{[d.title, d.department, d.company].filter(Boolean).join(' · ')}</span>}
            <button className="ccard-email" onClick={copy} title={t('Copy email address')}>{address} <Icon name="copy" size={12} /></button>
          </div>
          <button className="icon-btn xs ccard-x" aria-label={t('Close')} onClick={onClose}><Icon name="close" size={14} /></button>
        </div>

        {!isMe && (
          <div className="ccard-actions">
            <button onClick={() => { onClose(); onEmail({ address, name }); }}><Icon name="mail" size={18} /><span>{t('Email')}</span></button>
            <button onClick={() => { onClose(); onMeeting({ address, name }); }}><Icon name="calendar" size={18} /><span>{t('Meeting')}</span></button>
            {d?.phones?.[0] && <a href={`tel:${d.phones[0].value.replace(/[^\d+]/g, '')}`}><Icon name="phone" size={18} /><span>{t('Call')}</span></a>}
            {d && !d.inContacts && !d.coworker && <button onClick={save}><Icon name="plus" size={18} /><span>{t('Save')}</span></button>}
            {d && (d.inContacts || d.coworker) && <span className="ccard-saved"><Icon name="check" size={18} /><span>{d.coworker ? t('Coworker') : t('In contacts')}</span></span>}
          </div>
        )}

        {err && <div className="form-error small">{err}</div>}
        {!d && !err && <div className="ccard-loading"><div className="skel" /><div className="skel short" /><div className="skel" /></div>}

        {d && <>
          {(d.phones.length > 0 || d.address || d.birthday) && (
            <div className="ccard-sec">
              {d.phones.map((p, i) => <div key={i} className="ccard-row"><Icon name="phone" size={14} /> <a href={`tel:${p.value.replace(/[^\d+]/g, '')}`}>{p.value}</a> <small className="muted">{t(p.type)}</small></div>)}
              {d.address && <div className="ccard-row"><Icon name="globe" size={14} /> {[d.address.street, d.address.city, d.address.region, d.address.country].filter(Boolean).join(', ')}</div>}
              {d.birthday && <div className="ccard-row">🎂 {new Date(`${d.birthday}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</div>}
            </div>
          )}
          {!isMe && (
            <div className="ccard-sec">
              <div className="ccard-sub"><b>{t('Recent emails')}</b>
                <span className="muted small">{d.stats.received} {t('from them')} · {d.stats.sent} {t('to them')}{since ? ` · ${t('since')} ${since}` : ''}</span></div>
              {!d.recent.length && <div className="muted small">{t('No emails with this person yet.')}</div>}
              {d.recent.map((m) => (
                <button key={`${m.folder}:${m.uid}`} className="ccard-mail" onClick={() => { onClose(); onOpenMessage(m); }}>
                  <Icon name={m.dir === 'out' ? 'send' : 'inbox'} size={13} />
                  <span className="ccard-subj">{m.subject || t('(no subject)')}</span>{m.attachments && <Icon name="clip" size={12} />}
                  <small className="muted">{fmtDate(m.date)}</small>
                </button>
              ))}
              {d.stats.received + d.stats.sent > d.recent.length && <button className="link small" onClick={() => { onClose(); onShowAll(address); }}>{t('Show all emails with')} {name.split(' ')[0]}</button>}
            </div>
          )}
          {!isMe && (
            <div className="ccard-sec">
              <div className="ccard-sub"><b>{t('My notes')}</b> <span className="muted small">{t('only you see these')}</span></div>
              {d.notes.map((n) => <div key={n.id} className="ccard-note">{n.body}</div>)}
              <form className="ccard-note-add" onSubmit={addNote}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Add a note about them…')} aria-label={t('Add a note')} /></form>
            </div>
          )}
          {!isMe && !d.coworker && onBlock && <div className="ccard-foot"><button className="link small danger-link" onClick={() => { onClose(); onBlock(address); }}>{t('Block')} {address}</button></div>}
        </>}
      </div>
    </div>
  );
}
