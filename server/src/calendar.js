// Calendar on top of mailcow's CalDAV: events, recurrence, reminders, invitations (iMIP), RSVP.
import express from 'express';
import crypto from 'node:crypto';
import ICAL from 'ical.js';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { requireAuth } from './session.js';
import { audit } from './db.js';
import { withMailbox } from './imap.js';
import { discover, listCollections, createCalendar, report, putResource, deleteResource, getResource, assertOwnHref, xmlEscape } from './dav.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const clip = (s, n) => String(s ?? '').replace(/\r/g, '').slice(0, n);
const mailto = (v) => String(v || '').replace(/^mailto:/i, '').toLowerCase();

// ---------------------------------------------------------------- iCalendar helpers
function toTime(iso, allDay) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw fail(400, 'Invalid date');
  if (allDay) { const t = ICAL.Time.fromDateString(String(iso).slice(0, 10)); return t; }
  return ICAL.Time.fromJSDate(d, true); // UTC
}

const RRULES = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' };
function repeatOf(rrule) {
  if (!rrule) return 'none';
  const s = rrule.toString();
  if (/FREQ=WEEKLY/.test(s) && /BYDAY=MO,TU,WE,TH,FR/.test(s)) return 'weekdays';
  const m = /FREQ=(\w+)/.exec(s); return m ? m[1].toLowerCase() : 'custom';
}

/** Build a clean VCALENDAR from validated fields (never from raw client/sender text). */
export function buildEvent(f, { organizer, method } = {}) {
  const cal = new ICAL.Component(['vcalendar', [], []]);
  cal.updatePropertyWithValue('prodid', '-//Roammail//Calendar//EN');
  cal.updatePropertyWithValue('version', '2.0');
  if (method) cal.updatePropertyWithValue('method', method);
  const ev = new ICAL.Component('vevent');
  ev.updatePropertyWithValue('uid', f.uid);
  ev.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  ev.updatePropertyWithValue('sequence', Number(f.sequence) || 0);
  ev.updatePropertyWithValue('summary', clip(f.title, 300) || '(no title)');
  const start = toTime(f.start, f.allDay);
  let end = toTime(f.end || f.start, f.allDay);
  if (f.allDay && end.compare(start) <= 0) { end = start.clone(); end.adjust(1, 0, 0, 0); }
  if (!f.allDay && end.compare(start) <= 0) { end = start.clone(); end.adjust(0, 1, 0, 0); }
  ev.updatePropertyWithValue('dtstart', start);
  ev.updatePropertyWithValue('dtend', end);
  if (f.location) ev.updatePropertyWithValue('location', clip(f.location, 500));
  if (f.description) ev.updatePropertyWithValue('description', clip(f.description, 10000));
  if (f.status) ev.updatePropertyWithValue('status', f.status);
  const rule = f.rrule || RRULES[f.repeat];
  if (rule) ev.updatePropertyWithValue('rrule', ICAL.Recur.fromString(rule));
  if (organizer) {
    const p = ev.addPropertyWithValue('organizer', `mailto:${organizer.email}`);
    if (organizer.name) p.setParameter('cn', clip(organizer.name, 100));
  }
  for (const a of (f.attendees || []).slice(0, 100)) {
    const p = ev.addPropertyWithValue('attendee', `mailto:${a.email}`);
    if (a.name) p.setParameter('cn', clip(a.name, 100));
    p.setParameter('partstat', a.partstat || 'NEEDS-ACTION');
    p.setParameter('role', 'REQ-PARTICIPANT');
    if (a.rsvp !== false) p.setParameter('rsvp', 'TRUE');
  }
  const mins = Number(f.reminder);
  if (mins >= 0 && f.reminder !== '' && f.reminder !== null && f.reminder !== undefined && f.reminder !== 'none') {
    const al = new ICAL.Component('valarm');
    al.updatePropertyWithValue('action', 'DISPLAY');
    al.updatePropertyWithValue('description', clip(f.title, 200) || 'Reminder');
    al.updatePropertyWithValue('trigger', ICAL.Duration.fromSeconds(-mins * 60));
    ev.addSubcomponent(al);
  }
  cal.addSubcomponent(ev);
  return cal.toString();
}

function readEvent(vevent) {
  const e = new ICAL.Event(vevent);
  const att = vevent.getAllProperties('attendee').map((p) => ({
    email: mailto(p.getFirstValue()), name: p.getParameter('cn') || '', partstat: (p.getParameter('partstat') || 'NEEDS-ACTION').toUpperCase(),
  }));
  const org = vevent.getFirstProperty('organizer');
  const alarm = vevent.getFirstSubcomponent('valarm');
  const trig = alarm?.getFirstPropertyValue('trigger');
  return {
    uid: e.uid, title: e.summary || '(no title)', location: e.location || '', description: e.description || '',
    allDay: e.startDate?.isDate || false, attendees: att,
    organizer: org ? { email: mailto(org.getFirstValue()), name: org.getParameter('cn') || '' } : null,
    repeat: repeatOf(vevent.getFirstPropertyValue('rrule')), rrule: vevent.getFirstPropertyValue('rrule')?.toString() || '',
    reminder: trig && trig.toSeconds ? Math.round(-trig.toSeconds() / 60) : null,
    sequence: Number(vevent.getFirstPropertyValue('sequence') || 0),
    status: vevent.getFirstPropertyValue('status') || '',
  };
}
const iso = (t) => (t.isDate ? t.toString() : t.toJSDate().toISOString());

/** Expand one stored calendar object into instances inside [from, to). */
export function expand(data, from, to) {
  const comp = new ICAL.Component(ICAL.parse(data));
  const vevents = comp.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id')) || vevents[0];
  if (!master) return [];
  const ev = new ICAL.Event(master);
  for (const ex of vevents.filter((v) => v.hasProperty('recurrence-id'))) ev.relateException(ex);
  const base = readEvent(master);
  const out = [];
  if (!ev.isRecurring()) {
    out.push({ ...base, start: iso(ev.startDate), end: iso(ev.endDate) });
  } else {
    const it = ev.iterator();
    let next; let n = 0;
    const end = ICAL.Time.fromJSDate(to, true);
    while ((next = it.next()) && n++ < 1000) {
      if (next.compare(end) >= 0) break;
      const occ = ev.getOccurrenceDetails(next);
      if (occ.endDate.toJSDate() <= from) continue;
      const exc = occ.item !== ev ? readEvent(occ.item.component) : {};
      out.push({ ...base, ...exc, start: iso(occ.startDate), end: iso(occ.endDate), recurrenceId: iso(occ.recurrenceId), recurring: true });
    }
  }
  return out.filter((e) => new Date(e.end) > from && new Date(e.start) < to);
}

// ---------------------------------------------------------------- invitations (iMIP)
function transport(user) {
  return nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: { user: user.email, pass: user.password }, tls: { rejectUnauthorized: config.tlsRejectUnauthorized } });
}
async function sendInvites(user, f, method, recipients) {
  if (config.calendarInvites !== 'app' || !recipients.length) return;
  const ics = buildEvent(f, { organizer: { email: user.email, name: user.name }, method });
  const when = f.allDay ? new Date(f.start).toDateString() : new Date(f.start).toUTCString();
  const subject = method === 'CANCEL' ? `Canceled: ${f.title}` : f.sequence > 0 ? `Updated invitation: ${f.title}` : `Invitation: ${f.title}`;
  const text = `${method === 'CANCEL' ? 'This event has been canceled.' : 'You have been invited.'}\n\n${f.title}\nWhen: ${when}${f.location ? `\nWhere: ${f.location}` : ''}${f.description ? `\n\n${f.description}` : ''}`;
  await transport(user).sendMail({
    from: user.name ? { name: user.name, address: user.email } : user.email, to: recipients.map((a) => a.email), subject, text,
    icalEvent: { method: method.toLowerCase(), filename: 'invite.ics', content: ics },
  });
}

/** Parse a text/calendar attachment from a received message (untrusted input). */
export function parseInvite(ics) {
  try {
    const comp = new ICAL.Component(ICAL.parse(String(ics)));
    const v = comp.getFirstSubcomponent('vevent');
    if (!v) return null;
    const e = readEvent(v); const ev = new ICAL.Event(v);
    return { method: String(comp.getFirstPropertyValue('method') || 'PUBLISH').toUpperCase(), ...e,
      start: ev.startDate ? iso(ev.startDate) : null, end: ev.endDate ? iso(ev.endDate) : null };
  } catch { return null; }
}

// ---------------------------------------------------------------- API
export const calendar = express.Router();
calendar.use(requireAuth);

calendar.get('/calendars', wrap(async (req, res) => res.json(await listCollections(req.user, 'calendar'))));

calendar.post('/calendars', wrap(async (req, res) => {
  const name = clip(req.body.name, 80).trim();
  if (!name) throw fail(400, 'Give the calendar a name');
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : '#038387';
  res.json(await createCalendar(req.user, name, color));
}));

calendar.get('/calendar/events', wrap(async (req, res) => {
  const from = new Date(String(req.query.from)); const to = new Date(String(req.query.to));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw fail(400, 'Invalid range');
  if (to - from > 100 * 864e5) throw fail(400, 'Range too large');
  const d = await discover(req.user);
  const cals = await listCollections(req.user, 'calendar');
  const wanted = req.query.calendars ? new Set(String(req.query.calendars).split(',')) : null;
  const stamp = (t) => t.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const results = await Promise.all(cals.filter((c) => !wanted || wanted.has(c.href)).map(async (c) => {
    assertOwnHref(c.href, d.calHome);
    const items = await report(req.user, c.href, body).catch(() => []);
    return items.flatMap((it) => {
      try { return expand(it.data, from, to).map((e) => ({ ...e, href: it.href, etag: it.etag, calendar: c.href, color: c.color })); } catch { return []; }
    });
  }));
  res.json(results.flat().sort((a, b) => new Date(a.start) - new Date(b.start)));
}));

function validate(body, me) {
  const f = {
    title: clip(body.title, 300).trim(), location: clip(body.location, 500), description: clip(body.description, 10000),
    allDay: !!body.allDay, start: body.start, end: body.end, repeat: RRULES[body.repeat] ? body.repeat : 'none',
    reminder: body.reminder === 'none' || body.reminder === null || body.reminder === undefined ? 'none' : Math.max(0, Math.min(40320, Number(body.reminder) || 0)),
  };
  if (!f.start) throw fail(400, 'Pick a start time');
  const atts = [];
  for (const a of Array.isArray(body.attendees) ? body.attendees : []) {
    const email = String(a.email || a.address || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email === me) continue;
    if (!atts.some((x) => x.email === email)) atts.push({ email, name: clip(a.name, 100), partstat: a.partstat });
  }
  if (atts.length > 100) throw fail(400, 'At most 100 attendees');
  f.attendees = atts;
  return f;
}

calendar.post('/calendar/events', wrap(async (req, res) => {
  const d = await discover(req.user);
  const cal = String(req.body.calendar || '');
  assertOwnHref(cal, d.calHome);
  const f = validate(req.body, req.user.email);
  f.uid = `${crypto.randomUUID()}@roammail`;
  f.sequence = 0;
  const href = `${cal.replace(/\/?$/, '/')}${encodeURIComponent(f.uid.split('@')[0])}.ics`;
  const ics = buildEvent(f, { organizer: f.attendees.length ? { email: req.user.email, name: req.user.name } : null });
  const etag = await putResource(req.user, href, ics, 'text/calendar; charset=utf-8');
  if (req.body.sendInvites !== false) await sendInvites(req.user, f, 'REQUEST', f.attendees).catch((e) => console.warn('invite email failed', e.message));
  audit(req.user.email, null, 'calendar.create', { attendees: f.attendees.length });
  res.json({ ok: true, href, etag, uid: f.uid });
}));

calendar.put('/calendar/events', wrap(async (req, res) => {
  const d = await discover(req.user);
  const href = assertOwnHref(String(req.body.href || ''), d.calHome);
  const cur = await getResource(req.user, href);
  const comp = new ICAL.Component(ICAL.parse(cur.data));
  const master = comp.getAllSubcomponents('vevent').find((v) => !v.hasProperty('recurrence-id'));
  const old = readEvent(master);
  if (old.organizer && old.organizer.email !== req.user.email) throw fail(403, 'Only the organizer can change this meeting. You can still accept or decline it.');
  const f = validate(req.body, req.user.email);
  f.uid = old.uid; f.sequence = old.sequence + 1;
  // keep everyone's existing replies
  f.attendees = f.attendees.map((a) => ({ ...a, partstat: old.attendees.find((o) => o.email === a.email)?.partstat || 'NEEDS-ACTION' }));
  if (req.body.repeat === undefined && old.rrule) f.rrule = old.rrule;
  const ics = buildEvent(f, { organizer: f.attendees.length ? { email: req.user.email, name: req.user.name } : null });
  const etag = await putResource(req.user, href, ics, 'text/calendar; charset=utf-8', req.body.etag || cur.etag);
  if (req.body.sendInvites !== false) {
    await sendInvites(req.user, f, 'REQUEST', f.attendees).catch(() => {});
    const removed = old.attendees.filter((o) => !f.attendees.some((a) => a.email === o.email));
    await sendInvites(req.user, f, 'CANCEL', removed).catch(() => {});
  }
  res.json({ ok: true, etag });
}));

calendar.delete('/calendar/events', wrap(async (req, res) => {
  const d = await discover(req.user);
  const href = assertOwnHref(String(req.query.href || ''), d.calHome);
  const cur = await getResource(req.user, href);
  const comp = new ICAL.Component(ICAL.parse(cur.data));
  const ev = readEvent(comp.getFirstSubcomponent('vevent'));
  await deleteResource(req.user, href, cur.etag);
  if (ev.attendees.length && (!ev.organizer || ev.organizer.email === req.user.email) && req.query.notify !== '0') {
    await sendInvites(req.user, { ...ev, start: comp.getFirstSubcomponent('vevent').getFirstPropertyValue('dtstart').toJSDate().toISOString(), sequence: ev.sequence + 1 }, 'CANCEL', ev.attendees).catch(() => {});
  }
  res.json({ ok: true });
}));

// Accept / tentative / decline an invitation received by email
calendar.post('/calendar/rsvp', wrap(async (req, res) => {
  const response = { accept: 'ACCEPTED', tentative: 'TENTATIVE', decline: 'DECLINED' }[req.body.response];
  if (!response) throw fail(400, 'Choose accept, tentative or decline');
  const msg = await withMailbox(req.user, String(req.body.folder || 'INBOX'), async (c) => (await c.fetchOne(String(req.body.uid), { source: true }, { uid: true }))?.source);
  if (!msg) throw fail(404, 'Message not found');
  const parsed = await simpleParser(msg);
  const ics = (parsed.attachments || []).find((a) => /text\/calendar|application\/ics/i.test(a.contentType))?.content?.toString('utf8');
  const inv = ics && parseInvite(ics);
  if (!inv || inv.method !== 'REQUEST' || !inv.organizer?.email) throw fail(400, 'This message has no invitation to answer');
  if (!/^[^@\s]+@[^@\s]+$/.test(inv.uid || '') && !/^[\w.@:+-]{1,200}$/.test(inv.uid || '')) throw fail(400, 'Invalid invitation');

  // Store a clean copy in the default calendar (not the raw sender-supplied file)
  const d = await discover(req.user);
  const cals = await listCollections(req.user, 'calendar');
  const href = `${cals[0].href.replace(/\/?$/, '/')}${crypto.createHash('sha256').update(inv.uid).digest('hex').slice(0, 32)}.ics`;
  assertOwnHref(href, d.calHome);
  const me = req.user.email;
  const attendees = inv.attendees.length ? inv.attendees : [{ email: me }];
  const mine = attendees.map((a) => (a.email === me ? { ...a, partstat: response, rsvp: false } : { ...a, rsvp: false }));
  if (!mine.some((a) => a.email === me)) mine.push({ email: me, partstat: response, rsvp: false });
  const f = { ...inv, attendees: mine, reminder: response === 'DECLINED' ? 'none' : 15 };
  const clean = buildEvent(f, { organizer: inv.organizer });
  let existing = null; try { existing = await getResource(req.user, href); } catch { /* new */ }
  if (response === 'DECLINED') { if (existing) await deleteResource(req.user, href, existing.etag); }
  else await putResource(req.user, href, clean, 'text/calendar; charset=utf-8', existing?.etag);

  // Reply to the organizer (iMIP REPLY)
  const reply = buildEvent({ ...inv, attendees: [{ email: me, name: req.user.name, partstat: response, rsvp: false }], reminder: 'none' }, { organizer: inv.organizer, method: 'REPLY' });
  const word = { ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined' }[response];
  await transport(req.user).sendMail({
    from: req.user.name ? { name: req.user.name, address: me } : me, to: inv.organizer.email,
    subject: `${word}: ${inv.title}`, text: `${req.user.name || me} has ${word.toLowerCase()} this invitation.${req.body.comment ? `\n\n${clip(req.body.comment, 2000)}` : ''}`,
    icalEvent: { method: 'reply', filename: 'reply.ics', content: reply },
  });
  audit(me, null, 'calendar.rsvp', { response });
  res.json({ ok: true, response });
}));

export { xmlEscape };

// Organizer opened an attendee's REPLY: record their answer on the organizer's copy of the event
calendar.post('/calendar/apply-reply', wrap(async (req, res) => {
  const msg = await withMailbox(req.user, String(req.body.folder || 'INBOX'), async (c) => (await c.fetchOne(String(req.body.uid), { source: true }, { uid: true }))?.source);
  if (!msg) throw fail(404, 'Message not found');
  const parsed = await simpleParser(msg);
  const sender = parsed.from?.value?.[0]?.address?.toLowerCase();
  const ics = (parsed.attachments || []).find((a) => /text\/calendar|application\/ics/i.test(a.contentType))?.content?.toString('utf8');
  const rep = ics && parseInvite(ics);
  if (!rep || rep.method !== 'REPLY' || !rep.uid) throw fail(400, 'Not a meeting reply');
  // Only trust the answer for the person who actually sent the reply
  const answer = rep.attendees.find((a) => a.email === sender);
  if (!answer) return res.json({ ok: false, reason: 'sender mismatch' });
  const d = await discover(req.user);
  const cals = await listCollections(req.user, 'calendar');
  const uidXml = xmlEscape(rep.uid);
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match collation="i;octet">${uidXml}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  for (const c of cals) {
    assertOwnHref(c.href, d.calHome);
    for (const it of await report(req.user, c.href, body).catch(() => [])) {
      const comp = new ICAL.Component(ICAL.parse(it.data));
      const v = comp.getAllSubcomponents('vevent').find((x) => !x.hasProperty('recurrence-id'));
      if (!v || v.getFirstPropertyValue('uid') !== rep.uid) continue;
      if (mailto(v.getFirstPropertyValue('organizer')) !== req.user.email) continue;
      const p = v.getAllProperties('attendee').find((a) => mailto(a.getFirstValue()) === sender);
      if (!p) continue;
      if (p.getParameter('partstat') === answer.partstat) return res.json({ ok: true, unchanged: true, partstat: answer.partstat });
      p.setParameter('partstat', answer.partstat);
      await putResource(req.user, it.href, comp.toString(), 'text/calendar; charset=utf-8', it.etag);
      return res.json({ ok: true, partstat: answer.partstat, who: sender });
    }
  }
  res.json({ ok: false, reason: 'event not found' });
}));
