// Booking pages end to end: the owner sets up their page, hours and meeting types; a guest only sees times that are free
// in the owner's real calendar; booking puts it in the calendar and emails the guest an invite; the cancel link removes
// it; a password change pauses the page. Then the same in a real browser. Needs the running stack (Radicale for CalDAV).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.35.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body) {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  put(p, b) { return this.req('PUT', p, b || {}); }
}
async function signup(user, name) {
  const c = new Client();
  assert.equal((await c.post('/api/signup', { name, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' })).status, 200);
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}
const ALL_DAY = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [[0, 1440]]]));
const tomorrowAt = (h) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(h, 0, 0, 0); return d; };

test('booking: free times from the real calendar, book, invite, cancel, pause on password change', async () => {
  const owner = await signup(`bko${run}`, 'Olivia Owner');
  const guest = await signup(`bkg${run}`, 'Gary Guest');
  const guestEmail = `bkg${run}@${D}`;
  await sleep(1500);

  // 1. set up the page (UTC, open all day so the test works at any hour) and a 1-hour meeting type
  let me = (await owner.get('/api/booking/me')).data;
  assert.equal(me.page, null);
  const slug = `olivia-${run}`;
  me = (await owner.put('/api/booking/page', { slug, title: 'Olivia Owner', intro: 'Pick a time.', timezone: 'UTC', hours: ALL_DAY })).data;
  assert.equal(me.page.slug, slug); assert.ok(me.page.connected); assert.equal(me.types.length, 1, 'a starter meeting type');
  assert.match(me.url, new RegExp(`/book/${slug}$`));
  me = (await owner.post('/api/booking/types', { name: 'Consultation', duration: 60, minNotice: 0, maxDays: 14, bufferAfter: 0, location: 'video' })).data;
  const consult = me.types.find((t) => t.name === 'Consultation');
  assert.equal(consult.slug, 'consultation');
  // another person can't take the same page address
  assert.equal((await guest.put('/api/booking/page', { slug, timezone: 'UTC' })).status, 409);

  // 2. something already in the owner's calendar tomorrow 10:00–11:00 UTC
  const cal = (await owner.get('/api/calendars')).data[0].href;
  assert.equal((await owner.post('/api/calendar/events', { calendar: cal, title: 'Dentist', start: tomorrowAt(10).toISOString(), end: tomorrowAt(11).toISOString(), sendInvites: false })).status, 200);

  // 3. the public page and its free times
  const pub = new Client();
  const p = (await pub.get(`/api/public/book/${slug}`)).data;
  assert.equal(p.open, true); assert.equal(p.title, 'Olivia Owner'); assert.equal(p.types.length, 2);
  assert.equal(p.types[0].locationDetail, '', 'no private details leak');
  const slotsFor = async () => (await pub.get(`/api/public/book/${slug}/consultation/slots?from=${encodeURIComponent(tomorrowAt(0).toISOString())}&days=1`)).data.slots;
  let slots = await slotsFor();
  assert.ok(!slots.includes(tomorrowAt(10).toISOString()), 'busy time is not offered');
  assert.ok(slots.includes(tomorrowAt(9).toISOString()) && slots.includes(tomorrowAt(12).toISOString()), 'free times are offered');
  assert.equal((await pub.get('/api/public/book/nobody-here-zz')).status, 404);

  // 4. book 12:00; it's gone from the list and can't be booked twice; bots filling the hidden field are refused
  const form = { start: tomorrowAt(12).toISOString(), timezone: 'Europe/London', name: 'Gary Guest', email: guestEmail, notes: 'About the Elm Street listing' };
  assert.equal((await pub.post(`/api/public/book/${slug}/consultation`, { ...form, website: 'http://spam' })).status, 400);
  const bk = await pub.post(`/api/public/book/${slug}/consultation`, form);
  assert.equal(bk.status, 200, JSON.stringify(bk.data));
  assert.match(bk.data.location, /^https:\/\/meet\.jit\.si\//);
  const token = bk.data.manageUrl.split('/manage/')[1];
  assert.ok(token && token.length > 20);
  slots = await slotsFor();
  assert.ok(!slots.includes(tomorrowAt(12).toISOString()));
  assert.equal((await pub.post(`/api/public/book/${slug}/consultation`, form)).status, 409);

  // in the owner's calendar, and the guest got a confirmation with an invite
  const range = `from=${encodeURIComponent(tomorrowAt(0).toISOString())}&to=${encodeURIComponent(tomorrowAt(23).toISOString())}`;
  let evs = (await owner.get(`/api/calendar/events?${range}`)).data;
  assert.ok(evs.some((e) => e.title === 'Consultation with Gary Guest' && e.attendees.some((a) => a.email === guestEmail)), 'in the calendar');
  await sleep(2500);
  const inbox = (await guest.get('/api/messages?folder=INBOX')).data.messages;
  assert.ok(inbox.some((m) => /^Confirmed: Consultation with Olivia Owner/.test(m.subject)), 'guest confirmation');
  me = (await owner.get('/api/booking/me')).data;
  assert.equal(me.bookings[0].email, guestEmail); assert.equal(me.bookings[0].notes, 'About the Elm Street listing');

  // 5. the guest cancels with their link
  const info = (await pub.get(`/api/public/booking/${token}`)).data;
  assert.equal(info.status, 'confirmed'); assert.equal(info.type, 'Consultation');
  assert.equal((await pub.post(`/api/public/booking/${token}/cancel`, { reason: 'Something came up' })).status, 200);
  assert.equal((await pub.get(`/api/public/booking/${token}`)).data.status, 'cancelled');
  evs = (await owner.get(`/api/calendar/events?${range}`)).data;
  assert.ok(!evs.some((e) => e.title === 'Consultation with Gary Guest'), 'removed from the calendar');
  assert.ok((await slotsFor()).includes(tomorrowAt(12).toISOString()), 'the time is free again');
  assert.equal((await pub.get('/api/public/booking/not-a-real-token')).status, 404);

  // 6. owner pauses, then a password change stops the page until they open their settings again
  await owner.put('/api/booking/page', { enabled: false });
  assert.equal((await pub.get(`/api/public/book/${slug}`)).data.open, false);
  await owner.put('/api/booking/page', { enabled: true });
  assert.equal((await owner.get('/api/booking/me')).data.page.timezone, 'UTC', 'pausing keeps the time zone');
  const NEW = 'Wx7-pRt4-Kd92';
  assert.equal((await owner.post('/api/security/password', { current: PW, next: NEW })).status, 200);
  await sleep(300);
  assert.equal((await pub.get(`/api/public/book/${slug}`)).data.open, false, 'paused after password change');
  const again = new Client();
  assert.equal((await again.post('/api/login', { email: `bko${run}@${D}`, password: NEW })).status, 200);
  assert.equal((await again.get('/api/booking/me')).data.page.connected, true);
  assert.equal((await pub.get(`/api/public/book/${slug}`)).data.open, true, 'reconnected');

  // 7. in a browser: pick the meeting type, a day, a time; fill in the form; booked
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ timezoneId: 'UTC', viewport: { width: 1100, height: 900 } })).newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/book/${slug}`);
    await page.click('text=Consultation');
    await page.waitForSelector('.bk-day.open');
    const day = String(tomorrowAt(0).getUTCDate());
    if (tomorrowAt(0).getUTCMonth() !== new Date().getUTCMonth()) await page.click('[aria-label="Next month"]');
    await page.click(`.bk-day.open:text-is("${day}")`);
    await page.click('.bk-time:has-text("3:00")');
    await page.fill('label:has-text("Your name") input', 'Browser Guest');
    await page.fill('label:has-text("Email") input', guestEmail);
    await page.click('text=Confirm booking');
    await page.waitForSelector('text=You’re booked', { timeout: 15000 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
