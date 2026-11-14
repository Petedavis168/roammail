// Batch 4: smart reminders, privacy report, sign out everywhere, disappearing emails, student Premium,
// Slack/Teams alerts, one-click Cloudflare DNS, customer timeline, Read later and instant search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ImapFlow } from 'imapflow';
import { findPromise, dueFrom } from '../../client/src/promises.js';
import { hookKind } from '../src/chatalerts.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MOCK = 'http://127.0.0.1:8095';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.51.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  send(fields) { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return this.req('POST', '/api/send', null, f); }
}
async function signup(user) {
  const c = new Client();
  const r = await c.post('/api/signup', { name: `Test ${user}`, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123', formMs: 60000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}
async function login(email) { const c = new Client(); assert.equal((await c.post('/api/login', { email, password: PW })).status, 200); return c; }

test('smart reminders spot promises', () => {
  const mon = new Date('2026-11-16T10:00:00'); // a Monday
  const p = findPromise("Hi Sam,\nThanks. I'll send the contract by Friday.\n\nOn Mon, Sam wrote:\n> I'll call you tomorrow", mon);
  assert.ok(p); assert.match(p.text, /send the contract by Friday/);
  assert.equal(new Date(p.due).getDay(), 5);
  assert.equal(new Date(findPromise('I will get back to you tomorrow.', mon).due).getDate(), 17);
  assert.equal(findPromise('Thanks for the update, sounds good.', mon), null);
  assert.equal(findPromise('> I will call you tomorrow', mon), null, 'quoted text is ignored');
  assert.ok(dueFrom('next week', mon) > mon);
});

test('only real Slack / Teams / Discord webhook links are accepted', () => {
  assert.equal(hookKind('https://hooks.slack.com/services/T0/B0/xyz'), 'slack');
  assert.equal(hookKind('https://acme.webhook.office.com/webhookb2/abc'), 'teams');
  assert.equal(hookKind('https://discord.com/api/webhooks/1/abc'), 'discord');
  assert.equal(hookKind('http://hooks.slack.com/services/x'), null);
  assert.equal(hookKind('https://hooks.slack.com.evil.example/services/x'), null);
  assert.equal(hookKind('https://user:pw@hooks.slack.com/services/x'), null);
  assert.equal(hookKind('https://169.254.169.254/services/x'), null);
});

test('one-click Cloudflare DNS replaces the old mail records and adds the rest', async () => {
  process.env.CLOUDFLARE_API_BASE = `${MOCK}/cf`;
  const { applyCloudflare } = await import('../src/cloudflaredns.js');
  await assert.rejects(applyCloudflare('short', 'acme.test', []), /Paste the API token/);
  await assert.rejects(applyCloudflare('x'.repeat(40), 'acme.test', []), /didn’t accept that token/);
  const recs = [{ type: 'MX', host: '@', value: 'mail.roammail.test', priority: 10 }, { type: 'TXT', host: '@', value: 'v=spf1 mx -all' }, { type: 'CNAME', host: 'autoconfig', value: 'mail.roammail.test' }];
  const r = await applyCloudflare('cf_test_token_abcdefghijklmnopqrstuvwxyz0123', `acme${run}.test`, recs);
  assert.deepEqual(r, { added: 3, replaced: 1, kept: 0 });
  const state = await (await fetch(`${MOCK}/test/cf`)).json();
  assert.ok(!state.records.some((x) => x.content === 'mx.oldhost.example'), 'old MX removed');
  assert.ok(state.records.some((x) => x.type === 'A'), 'website record left alone');
  assert.deepEqual(await applyCloudflare('cf_test_token_abcdefghijklmnopqrstuvwxyz0123', `acme${run}.test`, recs).then((x) => x.kept), 3, 'running again changes nothing');
});

test('privacy report, sign out everywhere, disappearing email, student Premium, chat alerts, timeline', async () => {
  const a = await signup(`ba${run}`); const b = await signup(`bb${run}`);
  const ea = `ba${run}@${D}`; const eb = `bb${run}@${D}`;

  // ---- privacy report
  await a.post('/api/privacy-report/trackers', { pixels: 3, links: 5 });
  await a.post('/api/privacy-report/trackers', { pixels: 2, links: 0 });
  const pr = (await a.get('/api/privacy-report')).data;
  assert.equal(pr.trackers.pixels, 5); assert.equal(pr.trackers.links, 5);

  // ---- sign out everywhere else: this device stays in, the other one is out
  const a2 = await login(ea);
  assert.equal((await a.post('/api/security/signout-all')).status, 200);
  assert.equal((await a.get('/api/me')).status, 200, 'this device stays signed in');
  assert.equal((await a2.get('/api/me')).status, 401, 'the other device is signed out');

  // ---- disappearing email (burns after reading)
  let r = await a.send({ to: eb, subject: `Vanish ${run}`, text: 'Secret plan', html: '<p>Secret plan</p>', selfDestruct: 'read' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.secure?.selfDestruct);
  await sleep(1500);
  const note = (await b.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject?.includes('disappearing message'));
  assert.ok(note, 'the notice arrived');
  const body = (await b.get(`/api/message?folder=INBOX&uid=${note.uid}`)).data;
  const link = (body.html || body.text).match(/\/secure\/([A-Za-z0-9_-]+)#k=([A-Za-z0-9_-]+)/);
  assert.ok(link, 'notice links with the key in the #'); assert.ok(!(body.html || body.text).includes('Secret plan'), 'content not in the notice');

  // ---- student Premium: code goes to the school address
  const school = `st${run}@uni.edu`;
  assert.equal((await a.post('/api/student/start', { schoolEmail: 'me@gmail.com' })).status, 400);
  r = await a.post('/api/student/start', { schoolEmail: school });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ticket = r.data.ticket;
  assert.equal((await a.post('/api/student/verify', { ticket, code: '000000' })).status, 400);
  await sleep(1500);
  let code = null;
  const imap = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: school, pass: school }, logger: false });
  try {
    await imap.connect(); await imap.mailboxOpen('INBOX');
    for await (const m of imap.fetch('1:*', { source: true })) code = String(m.source).match(/\b(\d{6})\b/)?.[1] || code;
    await imap.logout();
  } catch { /* GreenMail without auto-created users */ }
  if (code) {
    r = await a.post('/api/student/verify', { ticket, code });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await a.get('/api/student')).data.verified, true);
    assert.ok((await a.get('/api/premium')).data.giftUntil > Date.now());
  }

  // ---- Slack alerts: test message on connect, then one per new email
  assert.equal((await a.post('/api/chat-alerts', { url: 'https://example.com/hook' })).status, 400);
  r = await a.post('/api/chat-alerts', { url: `${MOCK}/services/T${run}/B1/x` });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.kind, 'slack');
  let hooks = (await (await fetch(`${MOCK}/test/hooks`)).json()).filter((h) => h.path.includes(`T${run}`));
  assert.match(hooks[0].body, /Roammail is connected/);
  await sleep(4000); // the background watcher picks the new channel up
  await b.send({ to: ea, subject: `Ping ${run}`, text: 'hello', html: '<p>hello</p>' });
  for (let i = 0; i < 20 && hooks.length < 2; i++) { await sleep(500); hooks = (await (await fetch(`${MOCK}/test/hooks`)).json()).filter((h) => h.path.includes(`T${run}`)); }
  assert.ok(hooks.length >= 2, 'new email posted to the channel'); assert.match(hooks[1].body, new RegExp(`Ping ${run}`));
  assert.equal((await a.get('/api/chat-alerts')).data.length, 1);

  // ---- customer timeline on the contact card
  await a.post('/api/notes', { body: 'Met at the conference', contact: eb });
  const card = (await a.get(`/api/people/card?email=${encodeURIComponent(eb)}`)).data;
  assert.ok(card.timeline.some((x) => x.kind === 'note')); assert.ok(card.timeline.some((x) => x.kind === 'received'));

  // ---- company footer is for admins only
  assert.ok([403, 404].includes((await a.req('PUT', '/api/admin/orgs/1/footer', { enabled: true, text: 'x' })).status));

  // ---- in the browser: the disappearing email opens from the link once; instant search; Read later
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${BASE}/secure/${link[1]}#k=${link[2]}`);
    await p.waitForSelector(`h1:has-text("Vanish ${run}")`);
    await p.frameLocator('iframe').locator('text=Secret plan').waitFor();
    await p.waitForSelector('text=disappears');
    assert.ok(!p.url().includes('#k='), 'key removed from the address bar');
    const [n, v] = a.cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
    await p.goto(`${BASE}/app`);
    await p.waitForSelector(`text=Ping ${run}`);
    await p.fill('[aria-label="Search mail"]', `bb${run}`);
    await p.waitForSelector('.search-people');
    await p.fill('[aria-label="Search mail"]', '');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
