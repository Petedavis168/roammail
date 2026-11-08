import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import EventEditor from './EventEditor.jsx';
import { DAY, startOfDay, addDays, startOfWeek, startOfMonth, sameDay, fmt, timeLabel, evStart, evEnd } from './dates.js';

const HOUR_PX = 48;

function MiniMonth({ cursor, onPick, today }) {
  const [m, setM] = useState(startOfMonth(cursor));
  useEffect(() => setM(startOfMonth(cursor)), [cursor.getMonth(), cursor.getFullYear()]);
  const start = startOfWeek(m);
  return (
    <div className="mini-month">
      <div className="mm-head"><b>{fmt(m, { month: 'long', year: 'numeric' })}</b>
        <button className="icon-btn xs" aria-label="Previous month" title="Previous month" onClick={() => setM(new Date(m.getFullYear(), m.getMonth() - 1, 1))}><Icon name="back" size={14} /></button>
        <button className="icon-btn xs" aria-label="Next month" title="Next month" onClick={() => setM(new Date(m.getFullYear(), m.getMonth() + 1, 1))}><Icon name="chevron" size={14} /></button></div>
      <div className="mm-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="mm-dow">{d}</span>)}
        {Array.from({ length: 42 }, (_, i) => addDays(start, i)).map((d) => (
          <button key={d.toISOString()} className={`mm-day ${d.getMonth() !== m.getMonth() ? 'other' : ''} ${sameDay(d, today) ? 'today' : ''} ${sameDay(d, cursor) ? 'sel' : ''}`} onClick={() => onPick(d)}>{d.getDate()}</button>
        ))}
      </div>
    </div>
  );
}

/** Lay out overlapping timed events in side-by-side columns. */
function layoutDay(events) {
  const sorted = [...events].sort((a, b) => evStart(a) - evStart(b) || evEnd(b) - evEnd(a));
  const out = []; let group = []; let groupEnd = 0;
  const flush = () => {
    const cols = [];
    for (const e of group) {
      let c = cols.findIndex((end) => end <= evStart(e).getTime());
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = evEnd(e).getTime();
      out.push({ e, col: c });
    }
    for (const o of out.slice(out.length - group.length)) o.cols = cols.length;
    group = [];
  };
  for (const e of sorted) {
    if (group.length && evStart(e).getTime() >= groupEnd) { flush(); groupEnd = 0; }
    group.push(e); groupEnd = Math.max(groupEnd, evEnd(e).getTime());
  }
  if (group.length) flush();
  return out;
}

function TimeGrid({ days, events, onSlot, onOpen, now }) {
  const ref = useRef();
  useEffect(() => { if (ref.current) ref.current.scrollTop = HOUR_PX * 7.5; }, [days.length]);
  const allDay = events.filter((e) => e.allDay || evEnd(e) - evStart(e) >= DAY);
  const timed = events.filter((e) => !allDay.includes(e));
  return (
    <div className="tgrid">
      <div className="tg-head" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <span />
        {days.map((d) => (
          <div key={d} className={`tg-day ${sameDay(d, now) ? 'today' : ''}`}><small>{fmt(d, { weekday: 'short' })}</small><b>{d.getDate()}</b></div>
        ))}
      </div>
      <div className="tg-allday" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
        <small className="muted">all-day</small>
        {days.map((d) => (
          <div key={d} className="tg-allday-cell">
            {allDay.filter((e) => evStart(e) < addDays(d, 1) && evEnd(e) > d).map((e) => (
              <button key={e.href + e.start} className="ev-chip" style={{ '--c': e.color }} onClick={() => onOpen(e)}>{e.title}</button>
            ))}
          </div>
        ))}
      </div>
      <div className="tg-body" ref={ref} tabIndex={0} aria-label="Calendar times">
        <div className="tg-inner" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)`, height: HOUR_PX * 24 }}>
          <div className="tg-hours">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR_PX }}>{h ? timeLabel(new Date(2000, 0, 1, h)) : ''}</span>)}</div>
          {days.map((d) => {
            const dayEvents = timed.filter((e) => evStart(e) < addDays(d, 1) && evEnd(e) > d);
            return (
              <div key={d} className="tg-col" onClick={(ev) => {
                const y = ev.clientY - ev.currentTarget.getBoundingClientRect().top;
                const mins = Math.floor((y / HOUR_PX) * 2) * 30;
                onSlot(new Date(d.getTime() + mins * 60e3));
              }}>
                {Array.from({ length: 24 }, (_, h) => <div key={h} className="tg-line" style={{ top: h * HOUR_PX }} />)}
                {sameDay(d, now) && <div className="now-line" style={{ top: ((now - startOfDay(now)) / 3600e3) * HOUR_PX }} />}
                {layoutDay(dayEvents).map(({ e, col, cols }) => {
                  const s = Math.max(evStart(e), d); const en = Math.min(evEnd(e), addDays(d, 1));
                  const top = ((s - d) / 3600e3) * HOUR_PX; const h = Math.max(22, ((en - s) / 3600e3) * HOUR_PX - 2);
                  const declined = e.attendees?.some((a) => a.partstat === 'DECLINED' && a.email === e.me);
                  return (
                    <button key={e.href + e.start} className={`ev-block ${declined ? 'declined' : ''}`} style={{ top, height: h, left: `${(col / cols) * 100}%`, width: `${100 / cols}%`, '--c': e.color }}
                      onClick={(x) => { x.stopPropagation(); onOpen(e); }} title={`${e.title}\n${timeLabel(evStart(e))} – ${timeLabel(evEnd(e))}${e.location ? `\n${e.location}` : ''}`}>
                      <b>{e.title}</b>{h > 34 && <small>{timeLabel(evStart(e))}{e.location ? ` · ${e.location}` : ''}</small>}
                      {e.recurring && <Icon name="refresh" size={10} />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ cursor, events, onSlot, onOpen, now }) {
  const start = startOfWeek(startOfMonth(cursor));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  return (
    <div className="mgrid">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="mg-dow">{d}</div>)}
      {days.map((d) => {
        const list = events.filter((e) => evStart(e) < addDays(d, 1) && evEnd(e) > d);
        return (
          <div key={d} className={`mg-cell ${d.getMonth() !== cursor.getMonth() ? 'other' : ''}`} onClick={() => onSlot(new Date(d.getTime() + 9 * 3600e3))}>
            <span className={`mg-num ${sameDay(d, now) ? 'today' : ''}`}>{d.getDate()}</span>
            {list.slice(0, 3).map((e) => (
              <button key={e.href + e.start} className={`mg-ev ${e.allDay ? 'allday' : ''}`} style={{ '--c': e.color }} onClick={(x) => { x.stopPropagation(); onOpen(e); }}>
                {!e.allDay && <span className="dot" />}{!e.allDay && <small>{timeLabel(evStart(e))}</small>} {e.title}
              </button>
            ))}
            {list.length > 3 && <small className="muted more">+{list.length - 3} more</small>}
          </div>
        );
      })}
    </div>
  );
}

export default function Calendar({ me }) {
  const toast = useToast();
  const [view, setView] = useState(() => localStorage.getItem('calView') || (matchMedia('(max-width: 899px)').matches ? 'day' : 'week')); // phones start on Day
  const [cursor, setCursor] = useState(startOfDay(new Date()));
  const [calendars, setCalendars] = useState(null);
  const [hidden, setHidden] = useState(() => new Set(JSON.parse(localStorage.getItem('calHidden') || '[]')));
  const [events, setEvents] = useState([]);
  const [editing, setEditing] = useState(null);
  const [now, setNow] = useState(new Date());
  const [error, setError] = useState('');
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t); }, []);
  useEffect(() => localStorage.setItem('calView', view), [view]);

  const range = useMemo(() => {
    if (view === 'day') return [cursor, addDays(cursor, 1)];
    if (view === 'week') { const s = startOfWeek(cursor); return [s, addDays(s, 7)]; }
    const s = startOfWeek(startOfMonth(cursor)); return [s, addDays(s, 42)];
  }, [view, cursor]);

  const loadCalendars = () => api.get('/api/calendars').then(setCalendars).catch((e) => { setCalendars([]); setError(e.message); });
  const load = () => api.get('/api/calendar/events', { from: range[0].toISOString(), to: range[1].toISOString() })
    .then((r) => setEvents(r.map((e) => ({ ...e, me: me.email })))).catch((e) => setError(e.message));
  useEffect(() => { loadCalendars(); }, []);
  useEffect(() => { load(); }, [range[0].getTime(), range[1].getTime()]);

  const visible = events.filter((e) => !hidden.has(e.calendar));
  const step = (dir) => setCursor((c) => (view === 'day' ? addDays(c, dir) : view === 'week' ? addDays(c, 7 * dir) : new Date(c.getFullYear(), c.getMonth() + dir, 1)));
  const title = view === 'month' ? fmt(cursor, { month: 'long', year: 'numeric' })
    : view === 'week' ? `${fmt(range[0], { month: 'short', day: 'numeric' })} – ${fmt(addDays(range[1], -1), { month: 'short', day: 'numeric', year: 'numeric' })}`
      : fmt(cursor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const nextSlot = () => {
    if (!sameDay(cursor, now)) return new Date(cursor.getTime() + 9 * 3600e3);
    const d = new Date(now); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d;
  };
  const newAt = (start) => setEditing({ start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), calendar: calendars?.find((c) => !hidden.has(c.href))?.href });
  const toggle = (href) => setHidden((h) => { const n = new Set(h); n.has(href) ? n.delete(href) : n.add(href); localStorage.setItem('calHidden', JSON.stringify([...n])); return n; });

  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable || editing) return;
      const k = { t: () => setCursor(startOfDay(new Date())), j: () => step(1), n: () => step(1), k: () => step(-1), p: () => step(-1), d: () => setView('day'), w: () => setView('week'), m: () => setView('month'), c: () => newAt(nextSlot()) }[e.key];
      if (k) { e.preventDefault(); k(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="calendar">
      <aside className="cal-side">
        <button className="compose-btn" onClick={() => newAt(nextSlot())}><Icon name="plus" /> New event</button>
        <MiniMonth cursor={cursor} today={now} onPick={(d) => setCursor(startOfDay(d))} />
        <div className="nav-title">My calendars
          <button className="icon-btn xs" aria-label="New calendar" title="New calendar" onClick={async () => { const name = prompt('Calendar name'); if (name) { try { await api.post('/api/calendars', { name }); loadCalendars(); } catch (e) { toast(e.message, { error: true }); } } }}><Icon name="plus" size={14} /></button>
        </div>
        {(calendars || []).map((c) => (
          <label key={c.href} className="cal-item"><input type="checkbox" checked={!hidden.has(c.href)} onChange={() => toggle(c.href)} style={{ accentColor: c.color }} /><span className="cat-dot" style={{ background: c.color }} />{c.name}</label>
        ))}
        <p className="muted small cal-sync">Syncs with your phone and Outlook (Settings → Phone &amp; apps).</p>
      </aside>
      <section className="cal-main">
        <div className="cal-toolbar">
          <button className="btn" onClick={() => setCursor(startOfDay(new Date()))}>Today</button>
          <button className="icon-btn" onClick={() => step(-1)} title="Previous (k)"><Icon name="back" /></button>
          <button className="icon-btn" onClick={() => step(1)} title="Next (j)"><Icon name="chevron" /></button>
          <h2>{title}</h2>
          <div className="spacer" />
          <div className="seg small-seg">
            {[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([v, l]) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{l}</button>)}
          </div>
        </div>
        {error && <div className="banner warn">Calendar: {error}</div>}
        {view === 'month'
          ? <MonthGrid cursor={cursor} events={visible} onSlot={newAt} onOpen={setEditing} now={now} />
          : <TimeGrid days={view === 'day' ? [cursor] : Array.from({ length: 7 }, (_, i) => addDays(range[0], i))} events={visible} onSlot={newAt} onOpen={setEditing} now={now} />}
      </section>
      {editing && calendars && <EventEditor event={editing} calendars={calendars} me={me} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}
