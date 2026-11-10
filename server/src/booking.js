// Booking pages: every mailbox can have a public page (roammail.net/book/your-name) where people book time with them.
//
// The owner adds as many meeting types as they like (30-minute call, 1-hour consultation, site visit…), each with its own
// length, buffers, notice, how far ahead, daily limit and location (video link, phone, in person or custom), and sets
// weekly hours in their time zone. Guests only see times that are free in the owner's real calendar (every calendar in
// their mailbox) and not already booked. A booking goes straight into the owner's calendar, the guest gets a confirmation
// with a calendar invite from the owner's address, and the owner gets a notice. Both can cancel with a link.
//
// To read the calendar while the owner isn't signed in, the page keeps their mailbox password encrypted (like passkeys
// and "keep me signed in"); it's refreshed each time they open their booking settings. A password change or "sign out
// everywhere" clears it and the page shows "not taking bookings right now" until they open the settings again.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { q, audit } from './db.js';
import { seal, unseal, requireAuth, onRevoke } from './session.js';
import { userTransport } from './imap.js';
import { checkSendQuota } from './abuse.js';
import { rateLimit } from './shared.js';
import { discover, listCollections, report, putResource, deleteResource, assertOwnHref } from './dav.js';
import { buildEvent, expand } from './calendar.js';
import { sendSystemMail } from './recovery.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const clip = (s, n) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>".]{1,63}(?:\.[^\s@<>".]{1,63}){1,8}$/; // no backtracking blow-up on long input
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['admin', 'api', 'app', 'book', 'booking', 'cancel', 'login', 'signup', 'help', 'support', 'roammail', 'www', 'mail', 'assets', 'static']);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LOCATIONS = ['video', 'phone', 'in_person', 'custom'];
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const base = (req) => config.publicUrl || (process.env.NODE_ENV === 'production' ? '' : `${req.protocol}://${req.get('host')}`);
const meetBase = () => (process.env.MEETING_URL || 'https://meet.jit.si').replace(/\/$/, '');
const MAX_TYPES = 20;

// ---------------------------------------------------------------- time zones (no library: Intl does the work)
const validTz = (tz) => { if (typeof tz !== 'string' || !tz || tz.length > 64) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
/** Minutes the zone is ahead of UTC at this instant. */
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000;
}
/** The UTC instant of a wall-clock time (date "YYYY-MM-DD" + minutes after midnight) in a zone. */
function zoned(dateStr, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - tzOffset(guess, tz) * 60000;
  t = guess - tzOffset(t, tz) * 60000; // second pass settles daylight-saving changes
  return t;
}
/** "YYYY-MM-DD" and weekday of an instant, in a zone. */
function dayIn(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
}
const addDays = (dateStr, n) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const fmtWhen = (ms, tz, durationMin) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const e = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${f.format(new Date(ms))} – ${e.format(new Date(ms + durationMin * 60000))}`;
};

// ---------------------------------------------------------------- validation
const DEFAULT_HOURS = { sun: [], mon: [[540, 1020]], tue: [[540, 1020]], wed: [[540, 1020]], thu: [[540, 1020]], fri: [[540, 1020]], sat: [] };
function cleanHours(h) {
  const out = {};
  for (const d of DAYS) {
    const ranges = Array.isArray(h?.[d]) ? h[d] : [];
    out[d] = ranges.slice(0, 6).map((r) => [Math.round(Number(r?.[0])), Math.round(Number(r?.[1]))])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b <= 1440 && b - a >= 15)
      .sort((a, b) => a[0] - b[0]);
  }
  return out;
}
const num = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
function cleanType(b, prev = {}) {
  const t = {
    name: clip(b.name ?? prev.name, 80), description: clip(b.description ?? prev.description, 1000),
    duration: num(b.duration ?? prev.duration, 5, 480, 30), step_min: num(b.interval ?? prev.step_min ?? 0, 0, 480, 0),
    buffer_before: num(b.bufferBefore ?? prev.buffer_before, 0, 240, 0), buffer_after: num(b.bufferAfter ?? prev.buffer_after, 0, 240, 0),
    min_notice: num(b.minNotice ?? prev.min_notice, 0, 60 * 24 * 30, 240), max_days: num(b.maxDays ?? prev.max_days, 1, 365, 60),
    daily_limit: num(b.dailyLimit ?? prev.daily_limit ?? 0, 0, 50, 0),
    location: LOCATIONS.includes(b.location ?? prev.location) ? (b.location ?? prev.location) : 'video',
    location_detail: clip(b.locationDetail ?? prev.location_detail, 300), color: /^#[0-9a-f]{6}$/i.test(b.color ?? prev.color ?? '') ? (b.color ?? prev.color) : '#1d4ed8',
    active: (b.active ?? (prev.active === undefined ? true : !!prev.active)) ? 1 : 0,
  };
  if (!t.name) throw fail(400, 'Give the meeting type a name');
  t.slug = clip(b.slug ?? prev.slug ?? t.name, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'meeting';
  return t;
}
const publicType = (t) => ({ id: t.id, slug: t.slug, name: t.name, description: t.description, duration: t.duration, location: t.location, color: t.color,
  locationDetail: t.location === 'in_person' || t.location === 'custom' ? t.location_detail : '' });
const ownerType = (t) => ({ ...publicType(t), locationDetail: t.location_detail, interval: t.step_min, bufferBefore: t.buffer_before, bufferAfter: t.buffer_after,
  minNotice: t.min_notice, maxDays: t.max_days, dailyLimit: t.daily_limit, active: !!t.active });

// ---------------------------------------------------------------- the owner's calendar
const ownerOf = (page) => {
  const c = page?.creds && unseal(page.creds);
  return c?.password ? { email: page.email, password: c.password, name: page.owner_name || '', sid: `booking:${page.email}` } : null;
};
async function busyTimes(user, from, to) {
  const d = await discover(user);
  const cals = await listCollections(user, 'calendar');
  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const out = [];
  for (const c of cals) {
    assertOwnHref(c.href, d.calHome);
    const items = await report(user, c.href, body).catch(() => []);
    for (const it of items) {
      try {
        for (const e of expand(it.data, new Date(from), new Date(to))) {
          if (e.allDay || String(e.status).toUpperCase() === 'CANCELLED') continue; // all-day notes (birthdays, holidays) don't block times
          out.push([Date.parse(e.start), Date.parse(e.end)]);
        }
      } catch { /* skip unreadable events */ }
    }
  }
  return out;
}

/** Free start times for one meeting type in [fromMs, toMs). */
async function freeSlots(page, type, fromMs, toMs, { busy } = {}) {
  const tz = validTz(page.timezone) ? page.timezone : 'UTC';
  const now = Date.now();
  const earliest = now + type.min_notice * 60000;
  const latest = now + type.max_days * 864e5;
  const from = Math.max(fromMs, earliest); const to = Math.min(toMs, latest);
  if (to <= from) return [];
  const dur = type.duration * 60000; const step = (type.step_min || Math.min(type.duration, 60)) * 60000;
  const pad = [type.buffer_before * 60000, type.buffer_after * 60000];
  const hours = JSON.parse(page.hours || '{}');
  const user = ownerOf(page);
  if (!user) return [];
  const blocked = busy || await busyTimes(user, from - 864e5, to + 864e5);
  const booked = await q.all("SELECT start_at, end_at FROM bookings WHERE owner = ? AND status = 'confirmed' AND end_at > ? AND start_at < ?", page.email, from - 864e5, to + 864e5);
  const all = [...blocked, ...booked.map((b) => [Number(b.start_at), Number(b.end_at)])];
  const perDay = {};
  if (type.daily_limit) {
    for (const b of await q.all("SELECT start_at FROM bookings WHERE owner = ? AND type_id = ? AND status = 'confirmed' AND start_at >= ? AND start_at < ?", page.email, type.id, from - 864e5, to + 864e5)) {
      const k = dayIn(Number(b.start_at), tz).date; perDay[k] = (perDay[k] || 0) + 1;
    }
  }
  const out = [];
  let day = dayIn(from, tz).date; const lastDay = dayIn(to, tz).date;
  for (let i = 0; i < 400 && day <= lastDay; i++, day = addDays(day, 1)) {
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (type.daily_limit && (perDay[day] || 0) >= type.daily_limit) continue;
    let left = type.daily_limit ? type.daily_limit - (perDay[day] || 0) : Infinity;
    for (const [a, b] of hours[DAYS[dow]] || []) {
      const winStart = zoned(day, a, tz); const winEnd = zoned(day, b, tz);
      for (let s = winStart; s + dur <= winEnd && left > 0; s += step) {
        if (s < from || s >= to) continue;
        const e = s + dur;
        if (all.some(([bs, be]) => s - pad[0] < be && e + pad[1] > bs)) continue;
        out.push(s); left--;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- owner API (signed in)
export const bookingApi = express.Router();
bookingApi.use('/booking', requireAuth);

async function pageFor(email) { return q.get('SELECT * FROM booking_pages WHERE email = ?', email); }
async function suggestSlug(email, name) {
  const baseSlug = (String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 34) || 'me';
  for (let i = 0; i < 50; i++) {
    const s = i ? `${baseSlug}-${i + 1}` : baseSlug;
    if (s.length >= 3 && SLUG_RE.test(s) && !RESERVED.has(s) && !(await q.get('SELECT 1 FROM booking_pages WHERE slug = ?', s))) return s;
  }
  return `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;
}
/** Keep the stored password fresh whenever the owner opens their booking settings. */
async function refreshCreds(req, page) {
  if (!page || req.delegatedMailbox || !req.user.password) return page;
  const c = page.creds && unseal(page.creds);
  if (c?.password === req.user.password && page.owner_name === (req.user.name || '')) return page;
  await q.run('UPDATE booking_pages SET creds = ?, owner_name = ? WHERE email = ?', seal({ password: req.user.password }), req.user.name || '', page.email);
  return pageFor(page.email);
}
async function ownerView(req, page) {
  const types = page ? await q.all('SELECT * FROM booking_types WHERE owner = ? ORDER BY sort, id', page.email) : [];
  const upcoming = page ? await q.all("SELECT b.*, t.name AS type_name FROM bookings b LEFT JOIN booking_types t ON t.id = b.type_id WHERE b.owner = ? AND b.end_at > ? ORDER BY b.start_at LIMIT 50", page.email, Date.now() - 3600e3) : [];
  return {
    page: page ? { slug: page.slug, title: page.title, intro: page.intro, timezone: page.timezone, hours: JSON.parse(page.hours || '{}'), enabled: !!page.enabled, connected: !!ownerOf(page) } : null,
    url: page ? `${base(req)}/book/${page.slug}` : '',
    types: types.map((t) => ({ ...ownerType(t), url: `${base(req)}/book/${page.slug}/${t.slug}` })),
    bookings: upcoming.map((b) => ({ id: b.id, type: b.type_name || '', start: Number(b.start_at), end: Number(b.end_at), name: b.guest_name, email: b.guest_email, phone: b.guest_phone, notes: b.notes, status: b.status, location: b.location })),
    meetUrl: meetBase(),
  };
}

bookingApi.get('/booking/me', wrap(async (req, res) => {
  const page = await refreshCreds(req, await pageFor(req.user.email));
  res.json(await ownerView(req, page));
}));

bookingApi.put('/booking/page', rateLimit({ windowMs: 60e3, limit: 30 }), wrap(async (req, res) => {
  if (req.delegatedMailbox) throw fail(403, 'Set up booking from your own mailbox');
  const prev = await pageFor(req.user.email);
  const tz = validTz(req.body.timezone) ? String(req.body.timezone) : prev?.timezone || 'America/New_York';
  let slug = String(req.body.slug ?? prev?.slug ?? '').toLowerCase().trim();
  if (!slug) slug = await suggestSlug(req.user.email, req.user.name);
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) throw fail(400, 'Your page address can use 3–40 lowercase letters, numbers and dashes');
  const taken = await q.get('SELECT email FROM booking_pages WHERE slug = ?', slug);
  if (taken && taken.email !== req.user.email) throw fail(409, 'That page address is taken. Try another.');
  const fields = {
    title: clip(req.body.title ?? prev?.title ?? req.user.name ?? '', 100), intro: clip(req.body.intro ?? prev?.intro, 1000),
    hours: JSON.stringify(cleanHours(req.body.hours ?? (prev ? JSON.parse(prev.hours) : DEFAULT_HOURS))),
    enabled: (req.body.enabled ?? (prev ? !!prev.enabled : true)) ? 1 : 0,
  };
  const creds = req.user.password ? seal({ password: req.user.password }) : prev?.creds || null;
  if (prev) {
    await q.run('UPDATE booking_pages SET slug = ?, title = ?, intro = ?, timezone = ?, hours = ?, enabled = ?, creds = ?, owner_name = ? WHERE email = ?',
      slug, fields.title, fields.intro, tz, fields.hours, fields.enabled, creds, req.user.name || '', req.user.email);
  } else {
    await q.run('INSERT INTO booking_pages(email, slug, title, intro, timezone, hours, enabled, creds, owner_name, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      req.user.email, slug, fields.title, fields.intro, tz, fields.hours, fields.enabled, creds, req.user.name || '', Date.now());
    // a sensible first meeting type, so the page works straight away
    await q.run(`INSERT INTO booking_types(owner, slug, name, description, duration, step_min, buffer_before, buffer_after, min_notice, max_days, daily_limit, location, location_detail, color, active, sort)
      VALUES(?, '30-min', '30-minute meeting', '', 30, 0, 0, 10, 240, 60, 0, 'video', '', '#1d4ed8', 1, 0)`, req.user.email);
    await audit(req.user.email, null, 'booking.page_created', { slug });
  }
  res.json(await ownerView(req, await pageFor(req.user.email)));
}));

bookingApi.get('/booking/slug-check', wrap(async (req, res) => {
  const s = String(req.query.slug || '').toLowerCase();
  const row = await q.get('SELECT email FROM booking_pages WHERE slug = ?', s);
  res.json({ ok: SLUG_RE.test(s) && !RESERVED.has(s) && (!row || row.email === req.user.email) });
}));

async function uniqueTypeSlug(owner, slug, exceptId) {
  for (let i = 0; i < 50; i++) {
    const s = i ? `${slug}-${i + 1}` : slug;
    if (!(await q.get('SELECT 1 FROM booking_types WHERE owner = ? AND slug = ? AND id != ?', owner, s, exceptId || 0))) return s;
  }
  return `${slug}-${crypto.randomBytes(2).toString('hex')}`;
}
bookingApi.post('/booking/types', wrap(async (req, res) => {
  const page = await pageFor(req.user.email);
  if (!page) throw fail(400, 'Set up your booking page first');
  const n = (await q.get('SELECT COUNT(*) AS n FROM booking_types WHERE owner = ?', req.user.email)).n;
  if (n >= MAX_TYPES) throw fail(400, `You can have up to ${MAX_TYPES} meeting types`);
  const t = cleanType(req.body);
  t.slug = await uniqueTypeSlug(req.user.email, t.slug);
  await q.run(`INSERT INTO booking_types(owner, slug, name, description, duration, step_min, buffer_before, buffer_after, min_notice, max_days, daily_limit, location, location_detail, color, active, sort)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.user.email, t.slug, t.name, t.description, t.duration, t.step_min, t.buffer_before, t.buffer_after,
  t.min_notice, t.max_days, t.daily_limit, t.location, t.location_detail, t.color, t.active, Number(n));
  res.json(await ownerView(req, page));
}));
bookingApi.put('/booking/types/:id', wrap(async (req, res) => {
  const prev = await q.get('SELECT * FROM booking_types WHERE id = ? AND owner = ?', Number(req.params.id), req.user.email);
  if (!prev) throw fail(404, 'Meeting type not found');
  const t = cleanType(req.body, prev);
  t.slug = t.slug === prev.slug ? prev.slug : await uniqueTypeSlug(req.user.email, t.slug, prev.id);
  await q.run(`UPDATE booking_types SET slug = ?, name = ?, description = ?, duration = ?, step_min = ?, buffer_before = ?, buffer_after = ?, min_notice = ?, max_days = ?, daily_limit = ?,
    location = ?, location_detail = ?, color = ?, active = ? WHERE id = ?`, t.slug, t.name, t.description, t.duration, t.step_min, t.buffer_before, t.buffer_after, t.min_notice,
  t.max_days, t.daily_limit, t.location, t.location_detail, t.color, t.active, prev.id);
  res.json(await ownerView(req, await pageFor(req.user.email)));
}));
bookingApi.delete('/booking/types/:id', wrap(async (req, res) => {
  await q.run('DELETE FROM booking_types WHERE id = ? AND owner = ?', Number(req.params.id), req.user.email);
  res.json(await ownerView(req, await pageFor(req.user.email)));
}));
bookingApi.post('/booking/bookings/:id/cancel', wrap(async (req, res) => {
  const b = await q.get('SELECT * FROM bookings WHERE id = ? AND owner = ?', Number(req.params.id), req.user.email);
  if (!b) throw fail(404, 'Booking not found');
  await cancelBooking(b, 'owner', clip(req.body.reason, 500));
  res.json(await ownerView(req, await pageFor(req.user.email)));
}));

// ---------------------------------------------------------------- booking and cancelling
async function cancelBooking(b, by, reason) {
  if (b.status !== 'confirmed') return;
  await q.run("UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancelled_at = ? WHERE id = ?", by, Date.now(), b.id);
  const page = await pageFor(b.owner);
  const user = ownerOf(page);
  const type = await q.get('SELECT * FROM booking_types WHERE id = ?', b.type_id);
  const title = `${type?.name || 'Meeting'} with ${b.guest_name}`;
  if (user && b.event_href) await deleteResource(user, b.event_href).catch(() => {});
  const when = fmtWhen(Number(b.start_at), b.guest_tz || page?.timezone || 'UTC', (Number(b.end_at) - Number(b.start_at)) / 60000);
  const why = reason ? `\n\nReason: ${reason}` : '';
  if (user) {
    const f = { uid: b.uid, sequence: 1, title, start: new Date(Number(b.start_at)).toISOString(), end: new Date(Number(b.end_at)).toISOString(), status: 'CANCELLED', attendees: [{ email: b.guest_email, name: b.guest_name }] };
    await userTransport(nodemailer, user).sendMail({
      from: user.name ? { name: user.name, address: user.email } : user.email, to: b.guest_email,
      subject: `Cancelled: ${title}`, text: `${by === 'guest' ? 'Your booking has been cancelled.' : `${user.name || user.email} cancelled this meeting.`}\n\n${title}\n${when}${why}`,
      icalEvent: { method: 'cancel', filename: 'cancel.ics', content: buildEvent(f, { organizer: { email: user.email, name: user.name }, method: 'CANCEL' }) },
    }).catch((e) => console.warn('booking cancel email failed', e.message));
  }
  if (by === 'guest') {
    await sendSystemMail(b.owner, `Cancelled: ${title}`, `<p><b>${esc(b.guest_name)}</b> (${esc(b.guest_email)}) cancelled their booking.</p><p>${esc(type?.name || 'Meeting')}<br>${esc(fmtWhen(Number(b.start_at), page?.timezone || 'UTC', (Number(b.end_at) - Number(b.start_at)) / 60000))}</p>${reason ? `<p>Reason: ${esc(reason)}</p>` : ''}<p>It has been removed from your calendar.</p>`).catch(() => {});
  }
  await audit(b.owner, null, 'booking.cancelled', { by, id: b.id });
}

// ---------------------------------------------------------------- public API (no sign-in)
export const bookingPublic = express.Router();
const readLimit = rateLimit({ windowMs: 60e3, limit: 60, standardHeaders: true, legacyHeaders: false });
const bookLimit = rateLimit({ windowMs: 3600e3, limit: 10, standardHeaders: true, legacyHeaders: false });

async function publicPage(slug) {
  const page = await q.get('SELECT * FROM booking_pages WHERE slug = ?', String(slug || '').toLowerCase());
  if (!page) throw fail(404, 'This booking page doesn’t exist');
  return page;
}

bookingPublic.get('/public/book/:slug', readLimit, wrap(async (req, res) => {
  const page = await publicPage(req.params.slug);
  const types = await q.all('SELECT * FROM booking_types WHERE owner = ? AND active = 1 ORDER BY sort, id', page.email);
  res.json({ slug: page.slug, title: page.title || page.owner_name || '', intro: page.intro, timezone: page.timezone,
    open: !!page.enabled && !!ownerOf(page), types: types.map(publicType) });
}));

bookingPublic.get('/public/book/:slug/:type/slots', readLimit, wrap(async (req, res) => {
  const page = await publicPage(req.params.slug);
  const type = await q.get('SELECT * FROM booking_types WHERE owner = ? AND slug = ? AND active = 1', page.email, String(req.params.type));
  if (!type) throw fail(404, 'This meeting type isn’t available');
  if (!page.enabled || !ownerOf(page)) return res.json({ slots: [], open: false });
  const from = Number.isFinite(Date.parse(String(req.query.from))) ? Date.parse(String(req.query.from)) : Date.now();
  const days = num(req.query.days, 1, 31, 7);
  try {
    const slots = await freeSlots(page, type, from, from + days * 864e5);
    res.json({ open: true, slots: slots.map((s) => new Date(s).toISOString()), duration: type.duration });
  } catch (e) {
    if (e.status === 502) { await q.run('UPDATE booking_pages SET creds = NULL WHERE email = ?', page.email); return res.json({ slots: [], open: false }); } // password changed elsewhere
    throw e;
  }
}));

bookingPublic.post('/public/book/:slug/:type', bookLimit, wrap(async (req, res) => {
  if (req.body.website) throw fail(400, 'Something went wrong. Please try again.'); // hidden field: only bots fill it in
  const page = await publicPage(req.params.slug);
  const type = await q.get('SELECT * FROM booking_types WHERE owner = ? AND slug = ? AND active = 1', page.email, String(req.params.type));
  if (!type) throw fail(404, 'This meeting type isn’t available');
  const user = ownerOf(page);
  if (!page.enabled || !user) throw fail(409, 'This page isn’t taking bookings right now');
  const name = clip(req.body.name, 100); const email = clip(req.body.email, 200).toLowerCase(); const phone = clip(req.body.phone, 40); const notes = clip(req.body.notes, 2000);
  if (!name) throw fail(400, 'Please enter your name');
  if (!EMAIL_RE.test(email)) throw fail(400, 'Please enter a valid email address');
  if (type.location === 'phone' && !phone) throw fail(400, 'Please enter a phone number we can call');
  const start = Date.parse(String(req.body.start));
  if (!Number.isFinite(start)) throw fail(400, 'Pick a time');
  const guestTz = validTz(req.body.timezone) ? String(req.body.timezone) : page.timezone;
  // still free? (someone may have just taken it, or the calendar changed)
  const free = await freeSlots(page, type, start - 60000, start + 60000);
  if (!free.includes(start)) throw fail(409, 'Sorry, that time was just taken. Please pick another.');
  const end = start + type.duration * 60000;
  await checkSendQuota(user.email, 1);

  const token = crypto.randomBytes(24).toString('base64url');
  const uid = `${crypto.randomUUID()}@roammail`;
  const location = type.location === 'video' ? `${meetBase()}/${page.slug}-${crypto.randomBytes(6).toString('hex')}`
    : type.location === 'phone' ? `Phone call: ${user.name || 'we'} will call ${phone}` : type.location_detail || '';
  const cancelUrl = `${base(req)}/book/manage/${token}`;
  const title = `${type.name} with ${name}`;
  const description = [`Booked through your Roammail booking page.`, `Name: ${name}`, `Email: ${email}`, phone && `Phone: ${phone}`, notes && `\nNotes from ${name}:\n${notes}`,
    type.location === 'video' && `\nJoin the video meeting: ${location}`].filter(Boolean).join('\n');
  const f = { uid, sequence: 0, title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), location, description, reminder: 15,
    attendees: [{ email, name, partstat: 'ACCEPTED', rsvp: false }] };

  // 1. into the owner's calendar
  const d = await discover(user);
  const cals = await listCollections(user, 'calendar');
  const cal = cals[0]?.href;
  if (!cal) throw fail(503, 'This page isn’t taking bookings right now');
  assertOwnHref(cal, d.calHome);
  const href = `${cal.replace(/\/?$/, '/')}${uid.split('@')[0]}.ics`;
  await putResource(user, href, buildEvent(f, { organizer: { email: user.email, name: user.name } }), 'text/calendar; charset=utf-8');
  const id = await q.insert(`INSERT INTO bookings(owner, type_id, start_at, end_at, guest_name, guest_email, guest_phone, guest_tz, notes, location, status, token_hash, uid, event_href, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`, page.email, type.id, start, end, name, email, phone, guestTz, notes, location, sha(token), uid, href, Date.now());

  // 2. confirmation to the guest, from the owner's address, with a calendar invite
  const whenGuest = fmtWhen(start, guestTz, type.duration);
  const where = type.location === 'video' ? `Video meeting: ${location}` : type.location === 'phone' ? `Phone call: we'll call you at ${phone}` : location ? `Where: ${location}` : '';
  await userTransport(nodemailer, user).sendMail({
    from: user.name ? { name: user.name, address: user.email } : user.email, to: { name, address: email },
    subject: `Confirmed: ${type.name} with ${user.name || user.email}`,
    text: `Hi ${name},\n\nYou're booked.\n\n${type.name} with ${user.name || user.email}\n${whenGuest}\n${where}\n\nNeed to cancel? ${cancelUrl}\n`,
    html: `<p>Hi ${esc(name)},</p><p>You're booked.</p><p><b>${esc(type.name)}</b> with ${esc(user.name || user.email)}<br>${esc(whenGuest)}${where ? `<br>${type.location === 'video' ? `Video meeting: <a href="${esc(location)}">${esc(location)}</a>` : esc(where)}` : ''}</p><p><a href="${esc(cancelUrl)}">Need to cancel?</a></p>`,
    icalEvent: { method: 'request', filename: 'invite.ics', content: buildEvent(f, { organizer: { email: user.email, name: user.name }, method: 'REQUEST' }) },
  }).catch((e) => console.warn('booking confirmation email failed', e.message));

  // 3. a notice to the owner
  await sendSystemMail(page.email, `New booking: ${title}`,
    `<p><b>${esc(name)}</b> (${esc(email)}${phone ? `, ${esc(phone)}` : ''}) booked <b>${esc(type.name)}</b>.</p><p>${esc(fmtWhen(start, page.timezone, type.duration))}</p>${notes ? `<p>Notes: ${esc(notes)}</p>` : ''}<p>It's in your calendar.</p>`).catch(() => {});
  await audit(page.email, null, 'booking.created', { id, type: type.slug });
  res.json({ ok: true, when: whenGuest, location: type.location === 'video' ? location : where, manageUrl: cancelUrl });
}));

// The guest's cancel link
bookingPublic.get('/public/booking/:token', readLimit, wrap(async (req, res) => {
  const b = await q.get('SELECT b.*, t.name AS type_name, p.title AS page_title, p.owner_name, p.slug FROM bookings b LEFT JOIN booking_types t ON t.id = b.type_id LEFT JOIN booking_pages p ON p.email = b.owner WHERE b.token_hash = ?', sha(req.params.token));
  if (!b) throw fail(404, 'Booking not found');
  res.json({ type: b.type_name || 'Meeting', with: b.page_title || b.owner_name || '', when: fmtWhen(Number(b.start_at), b.guest_tz || 'UTC', (Number(b.end_at) - Number(b.start_at)) / 60000),
    status: b.status, past: Number(b.start_at) < Date.now(), location: b.location, bookAgain: b.slug ? `/book/${b.slug}` : '' });
}));
bookingPublic.post('/public/booking/:token/cancel', bookLimit, wrap(async (req, res) => {
  const b = await q.get('SELECT * FROM bookings WHERE token_hash = ?', sha(req.params.token));
  if (!b) throw fail(404, 'Booking not found');
  if (Number(b.start_at) < Date.now()) throw fail(400, 'This meeting has already started');
  await cancelBooking(b, 'guest', clip(req.body.reason, 500));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- the public page itself
const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.join(here, 'bookpage');
const shell = fs.readFileSync(path.join(PAGE_DIR, 'index.html'), 'utf8');
export const bookingPages = express.Router();
bookingPages.get('/book-assets/:file', (req, res) => {
  const f = req.params.file;
  if (!/^(book\.js|book\.css)$/.test(f)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(PAGE_DIR, f));
});
bookingPages.get(['/book/:slug', '/book/:slug/:type', '/book/manage/:token'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', req.params.token ? 'noindex' : 'index, follow');
  res.type('html').send(shell.replaceAll('{{APP}}', esc(config.appName || 'Roammail')));
});

// Password changed or "sign out everywhere": stop using the stored password
onRevoke((email) => { q.run('UPDATE booking_pages SET creds = NULL WHERE email = ?', email).catch(() => {}); });
