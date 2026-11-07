import { useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import RecipientInput from '../RecipientInput.jsx';
import { useToast } from '../Toast.jsx';
import { localInput, evStart, evEnd, addDays } from './dates.js';

const REPEATS = [['none', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year']];
const REMINDERS = [['none', 'No reminder'], [0, 'At start time'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']];

export default function EventEditor({ event, calendars, me, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !event.href;
  const readOnly = !isNew && event.organizer && event.organizer.email !== me.email;
  const s0 = evStart(event); const e0 = evEnd(event);
  const [f, setF] = useState({
    title: event.title || '', calendar: event.calendar || calendars[0]?.href, allDay: !!event.allDay,
    start: localInput(s0, event.allDay), end: localInput(event.allDay ? addDays(e0, -1) : e0, event.allDay),
    location: event.location || '', description: event.description || '', repeat: event.repeat && event.repeat !== 'custom' ? event.repeat : 'none',
    reminder: event.reminder ?? (isNew ? 15 : 'none'),
    attendees: (event.attendees || []).map((a) => ({ name: a.name, address: a.email, partstat: a.partstat })),
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const toggleAllDay = (on) => {
    const s = new Date(f.start); const e = new Date(f.end);
    setF({ ...f, allDay: on, start: localInput(s, on), end: on ? localInput(e, true) : localInput(new Date(s.getTime() + 3600e3)) });
  };

  const save = async (e) => {
    e?.preventDefault();
    if (!f.title.trim()) return toast('Add a title', { error: true });
    let start; let end;
    if (f.allDay) { start = f.start; end = localInput(addDays(new Date(`${f.end}T00:00:00`), 1), true); }
    else { start = new Date(f.start).toISOString(); end = new Date(f.end).toISOString(); }
    if (new Date(end) <= new Date(start) && !f.allDay) return toast('The end must be after the start', { error: true });
    const body = { ...f, start, end, attendees: f.attendees.map((a) => ({ email: a.address, name: a.name })) };
    setBusy(true);
    try {
      if (isNew) await api.post('/api/calendar/events', body);
      else await api.put('/api/calendar/events', { ...body, href: event.href, etag: event.etag });
      toast(f.attendees.length ? (isNew ? 'Event saved and invitations sent' : 'Event updated and attendees notified') : 'Event saved');
      onSaved();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!confirm(event.recurring ? 'Delete every occurrence of this repeating event?' : 'Delete this event?')) return;
    try { await api.del('/api/calendar/events', { href: event.href }); toast(f.attendees.length ? 'Deleted. Attendees were told it is canceled.' : 'Deleted'); onSaved(); }
    catch (err) { toast(err.message, { error: true }); }
  };

  return (
    <div className="modal-wrap" onClick={onClose}>
      <form className="modal event-editor" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="modal-head"><h2>{readOnly ? 'Event' : isNew ? 'New event' : 'Edit event'}</h2><button type="button" className="icon-btn" onClick={onClose}><Icon name="close" /></button></div>
        {readOnly && <div className="banner">Organized by {event.organizer.name || event.organizer.email}. Only they can change it.</div>}
        <fieldset disabled={readOnly} className="form">
          <input className="title-input" placeholder="Add a title" value={f.title} onChange={set('title')} autoFocus />
          <div className="ev-row">
            <Icon name="clock" />
            <input type={f.allDay ? 'date' : 'datetime-local'} value={f.start} onChange={(e) => {
              const ns = e.target.value; const dur = new Date(f.end) - new Date(f.start);
              setF({ ...f, start: ns, end: f.allDay ? (f.end < ns ? ns : f.end) : localInput(new Date(new Date(ns).getTime() + Math.max(dur, 15 * 60e3))) });
            }} required />
            <span>to</span>
            <input type={f.allDay ? 'date' : 'datetime-local'} value={f.end} min={f.start} onChange={set('end')} required />
            <label className="check"><input type="checkbox" checked={f.allDay} onChange={(e) => toggleAllDay(e.target.checked)} /> All day</label>
          </div>
          <div className="ev-row">
            <Icon name="refresh" />
            <select value={f.repeat} onChange={set('repeat')}>{REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <Icon name="alert" />
            <select value={f.reminder} onChange={set('reminder')}>{REMINDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <div className="ev-row"><Icon name="globe" /><input placeholder="Add a location" value={f.location} onChange={set('location')} /></div>
          <div className="ev-people"><RecipientInput label="Invite" value={f.attendees} onChange={(v) => setF({ ...f, attendees: v })} /></div>
          {!isNew && f.attendees.length > 0 && (
            <div className="rsvp-list">{f.attendees.map((a) => (
              <span key={a.address} className={`rsvp-chip ${String(a.partstat || '').toLowerCase()}`}>{a.name || a.address} · {{ ACCEPTED: 'Yes', DECLINED: 'No', TENTATIVE: 'Maybe' }[a.partstat] || 'Waiting'}</span>
            ))}</div>
          )}
          <textarea rows={4} placeholder="Add a description" value={f.description} onChange={set('description')} />
          {calendars.length > 1 && isNew && (
            <label className="row-field">Calendar<select value={f.calendar} onChange={set('calendar')}>{calendars.map((c) => <option key={c.href} value={c.href}>{c.name}</option>)}</select></label>
          )}
        </fieldset>
        <div className="step-actions">
          {!isNew && !readOnly && <button type="button" className="btn ghost danger-text" onClick={del}><Icon name="trash" size={16} /> Delete</button>}
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {!readOnly && <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : f.attendees.length && isNew ? 'Save & send invites' : 'Save'}</button>}
        </div>
      </form>
    </div>
  );
}
