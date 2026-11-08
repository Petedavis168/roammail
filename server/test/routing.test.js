// Mailbox URL IDs, page access checks, several signed-in mailboxes, and host routing.
//   BASE_URL=http://localhost:3000 node --test test/routing.test.js
//   HOSTS_BASE=http://127.0.0.1:3003 (an instance started with ROOT_DOMAIN=roammail.test) also tests host routing.
import { test } from 'node:test';
import { finishSetup } from './setup-helper.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor() { this.cookie = ''; this.ip = `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, headers = {}) {
    const h = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (this.autoSetup !== false && method === 'POST' && /^\/api\/(login|login\/2fa|signup|password\/reset)$/.test(path) && res.status === 200 && data?.setupRequired?.length) this.password = await finishSetup((m, p, b) => this.req(m, p, b), data, body?.password);
    return { status: res.status, data, location: res.headers.get('location'), headers: res.headers };
  }
}
async function signup(b, username, name = 'Test Person') {
  const r = await b.req('POST', '/api/signup', { name, username, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await sleep(1200);
  return r.data;
}

test('free accounts get a random 8-digit mailbox ID; pages check ownership and answer 404 otherwise', async () => {
  const a = new Browser(); const ra = await signup(a, `ra${run}`);
  assert.match(ra.mailboxId, /^\d{8}$/);
  assert.equal(ra.redirect, `/${ra.mailboxId}/inbox`);
  assert.ok(!ra.redirect.includes('@'), 'no address in the URL');

  const page = await a.req('GET', `/${ra.mailboxId}/inbox`);
  assert.equal(page.status, 200); assert.match(page.data, /<div id="root">/);
  for (const p of ['sent', 'drafts', 'spam', 'trash', 'archive', 'calendar', 'contacts', 'settings', 'folder/Projects', 'message/SU5CT1g.12']) {
    assert.equal((await a.req('GET', `/${ra.mailboxId}/${p}`)).status, 200, p);
  }
  assert.equal((await a.req('GET', `/${ra.mailboxId}`)).location, `/${ra.mailboxId}/inbox`);
  assert.equal((await a.req('GET', `/${ra.mailboxId}/nonsense`)).status, 404);
  assert.equal((await a.req('GET', '/login')).location, `/${ra.mailboxId}/inbox`, 'signed in: the sign-in page goes to the inbox');
  assert.equal((await a.req('GET', '/login?add=1')).status, 200, 'unless adding another account');
  // installed app (PWA) start URL and home-screen shortcuts
  assert.equal((await a.req('GET', '/app')).location, `/${ra.mailboxId}/inbox`);
  assert.equal((await a.req('GET', '/app?compose=1')).location, `/${ra.mailboxId}/inbox?compose=1`);
  assert.equal((await a.req('GET', '/app?view=calendar')).location, `/${ra.mailboxId}/calendar`);
  assert.equal((await new Browser().req('GET', '/app')).location, '/login', 'not signed in: sign-in page');
  const mf = await a.req('GET', '/manifest.webmanifest');
  assert.equal(mf.status, 200); assert.equal(mf.data.start_url, '/app');

  const b = new Browser(); const rb = await signup(b, `rb${run}`);
  assert.notEqual(rb.mailboxId, ra.mailboxId);
  // someone else's mailbox, a made-up ID, and no session
  assert.equal((await a.req('GET', `/${rb.mailboxId}/inbox`)).status, 404);
  assert.equal((await a.req('GET', '/10000000/inbox')).status, 404);
  const anon = await new Browser().req('GET', `/${ra.mailboxId}/inbox`);
  assert.equal(anon.status, 302); assert.equal(anon.location, '/login');
  // same rule for the API
  assert.equal((await a.req('GET', '/api/messages?folder=INBOX', undefined, { 'X-Mailbox-Id': rb.mailboxId })).status, 404);
  assert.equal((await a.req('GET', '/api/messages?folder=INBOX', undefined, { 'X-Mailbox-Id': ra.mailboxId })).status, 200);
});

test('unknown mailbox IDs are rate limited per IP', async () => {
  const a = new Browser(); await signup(a, `rl${run}`);
  let last;
  for (let i = 0; i < 35; i++) last = await a.req('GET', `/${String(20000000 + i)}/inbox`);
  assert.equal(last.status, 429);
});

test('several mailboxes signed in at once; the ID in the path picks one; signing out one keeps the others', async () => {
  const br = new Browser();
  const one = await signup(br, `m1${run}`, 'One Person');
  const other = new Browser(); const two = await signup(other, `m2${run}`, 'Two Person');
  // same browser signs in to the second mailbox too ("Add another account")
  const login = await br.req('POST', '/api/login', { email: `m2${run}@free.test`, password: PW });
  assert.equal(login.status, 200); assert.equal(login.data.mailboxId, two.mailboxId);
  assert.equal(br.cookie.split('=')[1].split('.').length, 2, 'two sessions in one cookie');
  const me1 = (await br.req('GET', '/api/me', undefined, { 'X-Mailbox-Id': one.mailboxId })).data;
  const me2 = (await br.req('GET', '/api/me', undefined, { 'X-Mailbox-Id': two.mailboxId })).data;
  assert.equal(me1.email, `m1${run}@free.test`); assert.equal(me2.email, `m2${run}@free.test`);
  assert.deepEqual(me1.accounts.map((a) => a.mailboxId).sort(), [one.mailboxId, two.mailboxId].sort());
  for (const id of [one.mailboxId, two.mailboxId]) assert.equal((await br.req('GET', `/${id}/inbox`)).status, 200);

  // Item 10: compose From another signed-in account (X-Mailbox-Id of that account), All inboxes, unread badges
  const send = async (asId, to, subject) => {
    const fd = new FormData(); fd.append('to', to); fd.append('subject', subject); fd.append('text', 'hi');
    const r = await fetch(`${BASE}/api/send`, { method: 'POST', headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': br.ip, Cookie: br.cookie, 'X-Mailbox-Id': asId }, body: fd });
    return r.status;
  };
  assert.equal(await send(two.mailboxId, `m1${run}@free.test`, `to-one-${run}`), 200, 'sent as mailbox two from the same browser');
  assert.equal(await send(one.mailboxId, `m2${run}@free.test`, `to-two-${run}`), 200);
  await sleep(1500);
  const all = (await br.req('GET', '/api/all-inboxes')).data;
  const mine = all.messages.filter((m) => m.subject?.endsWith(run));
  assert.deepEqual(mine.map((m) => m.mailboxId).sort(), [one.mailboxId, two.mailboxId].sort(), 'one message from each inbox');
  assert.ok(mine.every((m) => m.account && m.uid));
  const sum = (await br.req('GET', '/api/accounts/summary')).data.accounts;
  assert.equal(sum.length, 2); assert.ok(sum.every((a) => a.unread >= 1), JSON.stringify(sum));
  // the summary only covers this browser's own sessions
  assert.equal((await other.req('GET', '/api/accounts/summary')).data.accounts.length, 1);

  assert.equal((await br.req('POST', '/api/logout', {}, { 'X-Mailbox-Id': one.mailboxId })).status, 200);
  assert.equal((await br.req('GET', `/${one.mailboxId}/inbox`)).status, 404, 'signed out of mailbox one');
  assert.equal((await br.req('GET', `/${two.mailboxId}/inbox`)).status, 200, 'still signed in to mailbox two');
});

test('"Keep me signed in": a 30-day cookie; without it the normal session length', async () => {
  const b = new Browser(); await signup(b, `kk${run}`);
  const plain = new Browser(); const p = await plain.req('POST', '/api/login', { email: `kk${run}@free.test`, password: b.password || PW });
  const days = (r) => (new Date(/Expires=([^;]+)/i.exec(r.headers.get('set-cookie'))[1]) - Date.now()) / 864e5;
  assert.equal(p.status, 200); assert.ok(days(p) < 8, `default ${days(p)}`);
  const kept = new Browser(); const k = await kept.req('POST', '/api/login', { email: `kk${run}@free.test`, password: b.password || PW, remember: true });
  assert.equal(k.status, 200); assert.ok(days(k) > 29 && days(k) <= 30.01, `remember ${days(k)}`);
  assert.equal((await kept.req('GET', '/api/me')).status, 200);
});

// ---------------------------------------------------------------- host routing (needs an instance with ROOT_DOMAIN)
const HB = process.env.HOSTS_BASE;
const get = (host, path) => new Promise((resolve, reject) => {
  const u = new URL(HB);
  http.get({ hostname: u.hostname, port: u.port, path, headers: { Host: host } }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location, cookie: res.headers['set-cookie'] }); }).on('error', reject);
});
test('hosts: www/app redirect to the root, sign-in host keeps to sign-in, health check works on any host', { skip: !HB && 'set HOSTS_BASE' }, async () => {
  assert.deepEqual(await get('www.roammail.test', '/help?x=1').then((r) => [r.status, r.location]), [301, 'https://roammail.test/help?x=1']);
  assert.deepEqual(await get('app.roammail.test', '/').then((r) => [r.status, r.location]), [301, 'https://roammail.test/']);
  assert.deepEqual(await get('login.roammail.test', '/12345678/inbox').then((r) => [r.status, r.location]), [302, 'https://roammail.test/12345678/inbox']);
  assert.equal((await get('10.0.1.23', '/healthz')).status, 200, 'load balancer health checks use the server IP');
  assert.equal((await get('roammail.test', '/')).status, 200, 'website home');
  assert.deepEqual(await get('roammail.test', '/signup?type=domain').then((r) => [r.status, r.location]), [301, 'https://login.roammail.test/signup?type=domain']);
  assert.equal((await get('login.roammail.test', '/signup?type=free&billing=monthly')).status, 200, 'sign-up page');
  assert.equal((await get('login.roammail.test', '/')).status, 200, 'sign-in page');
  const anon = await get('roammail.test', '/12345678/inbox');
  assert.deepEqual([anon.status, anon.location], [302, 'https://login.roammail.test/']);
});

test('polish: favicon.ico, robots.txt, real 404s for made-up paths, share image', async () => {
  const fav = await fetch(`${BASE}/favicon.ico`);
  assert.equal(fav.status, 200); assert.equal(fav.headers.get('content-type'), 'image/x-icon');
  assert.deepEqual([...new Uint8Array(await fav.arrayBuffer()).slice(0, 4)], [0, 0, 1, 0], 'an ICO file');
  const robots = await fetch(`${BASE}/robots.txt`);
  assert.match(robots.headers.get('content-type'), /text\/plain/); assert.match(await robots.text(), /User-agent: \*/);
  for (const p of ['/wp-login.php', '/nope', '/.env', '/admin.php']) assert.equal((await fetch(BASE + p)).status, 404, p);
  for (const p of ['/login', '/signup']) assert.equal((await fetch(BASE + p)).status, 200, p);
  const og = await fetch(`${BASE}/assets/og-image.png`);
  assert.equal(og.status, 200); assert.equal(og.headers.get('content-type'), 'image/png');
});

test('public website: home page and pages from the site, sign-up links, assets', async () => {
  const b = new Browser();
  const home = await b.req('GET', '/');
  assert.equal(home.status, 200); assert.match(home.data, /Your business\. Delivered\./); assert.match(home.data, /login\.roammail\.net\/signup/);
  for (const p of ['/terms.html', '/privacy', '/cookies.html', '/acceptable-use', '/accessibility.html', '/legal', '/brand.html', '/style.css', '/assets/roammail-symbol.png']) {
    assert.equal((await b.req('GET', p)).status, 200, p);
  }
  const gs = await b.req('GET', '/get-started.html?type=domain&billing=yearly');
  assert.equal(gs.status, 301); assert.equal(gs.location, '/signup?type=domain&billing=yearly');
  const su = await b.req('GET', '/signup?type=free');
  assert.equal(su.status, 200); assert.match(su.data, /<div id="root">/, 'sign-up is the web app');
  assert.equal((await b.req('GET', '/login')).status, 200);
});
