// Calendar, contacts and groups integration tests (needs dev/start-stack.sh with Radicale on DAV_URL).
import { test } from 'node:test';
import { finishSetup } from './setup-helper.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const D = process.env.TEST_DOMAIN || 'free.test';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Client {
  constructor() { this.cookie = ''; this.ip = `198.20.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body) {
    const headers = { 'X-Forwarded-For': this.ip, 'X-Requested-With': 'mailcow-client', ...(this.cookie ? { Cookie: this.cookie } : {}) };
    let payload; if (body instanceof FormData) payload = body; else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + path, { method, headers, body: payload });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    if (this.autoSetup !== false && method === 'POST' && /^\/api\/(login|login\/2fa|signup|password\/reset)$/.test(path) && r.status === 200 && data?.setupRequired?.length) this.password = await finishSetup((m, p, b) => this.req(m, p, b), data, body?.password);
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
}
async function user(name) {
  const c = new Client();
  const r = await c.post('/api/signup', { name, username: name, password: PW, acceptTerms: true });
  assert.equal(r.status, 200, JSON.stringify(r.data)); await sleep(1200); return c;
}
const range = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 30 * 864e5).toISOString() });

test('calendar: recurring event with invite, RSVP updates both sides', async () => {
  const org = await user(`org${run}`); const guest = await user(`gst${run}`);
  const cal = (await org.get('/api/calendars')).data[0].href;
  const start = new Date(Date.now() + 864e5); start.setUTCMinutes(0, 0, 0);
  const r = await org.post('/api/calendar/events', { calendar: cal, title: 'Weekly sync', start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(),
    repeat: 'weekly', reminder: 15, attendees: [{ email: `gst${run}@${D}` }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const q = new URLSearchParams(range());
  const evs = (await org.get(`/api/calendar/events?${q}`)).data;
  assert.ok(evs.length >= 4 && evs.every((e) => e.title === 'Weekly sync' && e.repeat === 'weekly'));
  await sleep(1500);
  const inbox = (await guest.get('/api/messages?folder=INBOX')).data.messages;
  const inv = inbox.find((m) => m.subject.startsWith('Invitation'));
  assert.ok(inv, 'invitation delivered');
  assert.equal((await guest.post('/api/calendar/rsvp', { folder: 'INBOX', uid: inv.uid, response: 'accept' })).status, 200);
  assert.ok((await guest.get(`/api/calendar/events?${q}`)).data.some((e) => e.title === 'Weekly sync'));
  await sleep(1500);
  const reply = (await org.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject.startsWith('Accepted'));
  assert.ok(reply, 'organizer got the reply');
  assert.equal((await org.post('/api/calendar/apply-reply', { folder: 'INBOX', uid: reply.uid })).data.partstat, 'ACCEPTED');
  const mine = (await org.get(`/api/calendar/events?${q}`)).data[0];
  assert.equal(mine.attendees[0].partstat, 'ACCEPTED');
  // guest can't edit the organizer's meeting, nor touch another user's calendar
  const gEv = (await guest.get(`/api/calendar/events?${q}`)).data[0];
  assert.equal((await guest.req('PUT', '/api/calendar/events', { href: gEv.href, title: 'hijack', start: gEv.start, end: gEv.end })).status, 403);
  assert.equal((await guest.req('DELETE', `/api/calendar/events?href=${encodeURIComponent(mine.href)}`)).status, 403);
});

test('contacts: hostile vCards are rebuilt, other users\' address books are off-limits', async () => {
  const a = await user(`ct${run}`); const b = await user(`cu${run}`);
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bob\r\nEMAIL:bob@ex.test\r\nX-EVIL:1\r\nPHOTO;VALUE=URI:http://tracker.test/p.png\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ann\r\nEMAIL:ann@ex.test\r\nEND:VCARD\r\n';
  const fd = new FormData(); fd.append('file', new Blob([vcf], { type: 'text/vcard' }), 'c.vcf');
  assert.equal((await a.req('POST', '/api/address-contacts/import', fd)).data.added, 2);
  const list = (await a.get('/api/address-contacts?fresh=1')).data;
  assert.deepEqual(list.map((c) => c.name), ['Ann', 'Bob']);
  const exported = (await a.get('/api/address-contacts/export')).data;
  assert.ok(!/X-EVIL|tracker\.test/.test(exported));
  assert.equal((await b.req('PUT', '/api/address-contacts', { href: list[0].href, name: 'pwn' })).status, 403);
  assert.equal((await b.req('DELETE', `/api/address-contacts?href=${encodeURIComponent(list[0].href)}`)).status, 403);
  assert.ok((await a.get('/api/contacts?q=bob')).data.some((x) => x.address === 'bob@ex.test'), 'contacts appear in compose suggestions');
});

test('calendar invitations count against free-account sending limits', async () => {
  const a = await user(`inv${run}`);
  const cal = (await a.get('/api/calendars')).data[0].href;
  const start = new Date(Date.now() + 2 * 864e5).toISOString();
  const r = await a.post('/api/calendar/events', { calendar: cal, title: 'Spam party', start, attendees: Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@example.com` })) });
  assert.equal(r.status, 400, 'more than 20 invitees from a free account is refused');
});

test('calendar import: an .ics from another provider is rebuilt; importing twice adds nothing; nobody is emailed', async () => {
  const me = await user(`ics${run}`);
  const day = new Date(Date.now() + 2 * 864e5); const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar//EN',
    'BEGIN:VEVENT', 'UID:abc123@google.com', `DTSTART:${ymd(day)}T150000Z`, `DTEND:${ymd(day)}T160000Z`, 'SUMMARY:Dentist', 'LOCATION:Main St',
    'ATTENDEE;CN=Victim:mailto:victim@example.com', 'BEGIN:VALARM', 'ACTION:EMAIL', 'ATTENDEE:mailto:victim@example.com', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:bday@google.com', `DTSTART;VALUE=DATE:${ymd(day)}`, 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  for (let i = 0; i < 2; i++) {
    const fd = new FormData(); fd.append('file', new Blob([ics]), 'google.ics');
    const r = await me.req('POST', '/api/calendar/import', fd);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.imported, r.data.existing], i ? [0, 2] : [2, 0]);
  }
  const evs = (await me.get(`/api/calendar/events?${new URLSearchParams(range())}`)).data;
  assert.equal(evs.filter((e) => e.title === 'Dentist').length, 1, 'no duplicate on re-import');
  const dentist = evs.find((e) => e.title === 'Dentist');
  assert.equal(dentist.location, 'Main St'); assert.equal((dentist.attendees || []).length, 0, 'attendees dropped');
  assert.ok(evs.some((e) => e.title === 'Birthday' && e.allDay && e.repeat === 'yearly'));
  const bad = new FormData(); bad.append('file', new Blob(['not a calendar']), 'x.ics');
  assert.equal((await me.req('POST', '/api/calendar/import', bad)).status, 400);
});
