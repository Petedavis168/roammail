// Load test: simulates people using the web app (sign in, read inbox, open mail, search, send, live updates).
// No dependencies. Run against STAGING, never production:
//   node loadtest/run.mjs --url https://staging.example.com --users 200 --minutes 10 --accounts accounts.csv
// accounts.csv: email,password per line (test mailboxes you created on the staging mailcow).
// Without --accounts it signs up throwaway accounts (only works when sign-up limits allow it, e.g. the dev stack).
import fs from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://localhost:3000');
const USERS = Number(arg('users', 50));
const SECONDS = Number(arg('seconds', Number(arg('minutes', 0)) * 60 || 30));
const THINK = Number(arg('think-ms', 1500)); // pause between actions, like a person reading
const PW = 'Lt7-qWv9-Kp42-x';

const stats = new Map(); // action -> { ok, fail, ms: [] }
const rec = (name, ms, ok) => { const s = stats.get(name) || { ok: 0, fail: 0, ms: [] }; ok ? s.ok++ : s.fail++; s.ms.push(ms); stats.set(name, s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class User {
  constructor(i, email, password) { this.i = i; this.email = email; this.password = password; this.cookie = ''; this.ip = `198.19.${i >> 8}.${(i & 255) || 1}`; }
  async req(name, method, path, body) {
    const headers = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const t0 = performance.now();
    try {
      const res = await fetch(BASE + path, { method, headers, body, signal: AbortSignal.timeout(30000) });
      for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
      const data = await res.json().catch(() => null);
      rec(name, performance.now() - t0, res.status < 400);
      return { status: res.status, data };
    } catch { rec(name, performance.now() - t0, false); return { status: 0 }; }
  }
  async start() {
    if (this.password) await this.req('login', 'POST', '/api/login', { email: this.email, password: this.password });
    else {
      const r = await this.req('signup', 'POST', '/api/signup', { name: `Load ${this.i}`, username: `load${Date.now().toString(36)}${this.i}`, password: PW, acceptTerms: true });
      this.email = r.data?.email; this.password = PW;
    }
    // live updates stream, like an open tab
    fetch(`${BASE}/api/events`, { headers: { Cookie: this.cookie, 'X-Forwarded-For': this.ip } }).then((r) => r.body?.cancel()).catch(() => {});
  }
  async step() {
    const roll = Math.random();
    const list = await this.req('inbox', 'GET', '/api/messages?folder=INBOX');
    const msgs = list.data?.messages || [];
    if (roll < 0.5 && msgs.length) await this.req('open message', 'GET', `/api/message?folder=INBOX&uid=${msgs[Math.floor(Math.random() * msgs.length)].uid}&peek=1`);
    else if (roll < 0.65) await this.req('search', 'GET', '/api/search?folder=INBOX&q=hello');
    else if (roll < 0.75) await this.req('folders', 'GET', '/api/folders');
    else if (roll < 0.82) {
      const fd = new FormData(); fd.append('to', this.email); fd.append('subject', `hello ${Date.now()}`); fd.append('text', 'load test');
      await this.req('send', 'POST', '/api/send', fd);
    } else await this.req('me', 'GET', '/api/me');
  }
}

const accounts = arg('accounts') ? fs.readFileSync(arg('accounts'), 'utf8').trim().split('\n').map((l) => l.split(',').map((x) => x.trim())) : [];
console.log(`Load test: ${USERS} people for ${SECONDS}s against ${BASE}`);
const users = Array.from({ length: USERS }, (_, i) => new User(i + 1, ...(accounts[i % (accounts.length || 1)] || [])));
for (let i = 0; i < users.length; i += 10) await Promise.all(users.slice(i, i + 10).map((u) => u.start())); // ramp up
const end = Date.now() + SECONDS * 1000;
await Promise.all(users.map(async (u) => { await sleep(Math.random() * THINK); while (Date.now() < end) { await u.step(); await sleep(THINK * (0.5 + Math.random())); } }));

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const rows = [...stats].map(([name, s]) => ({ action: name, requests: s.ok + s.fail, errors: s.fail, p50_ms: Math.round(pct(s.ms, 0.5)), p95_ms: Math.round(pct(s.ms, 0.95)), p99_ms: Math.round(pct(s.ms, 0.99)) }));
console.table(rows);
const total = rows.reduce((n, r) => n + r.requests, 0); const errs = rows.reduce((n, r) => n + r.errors, 0);
console.log(`Total ${total} requests, ${(total / SECONDS).toFixed(1)}/s, error rate ${((errs / Math.max(1, total)) * 100).toFixed(2)}%`);
const failed = errs / Math.max(1, total) > 0.01 || rows.some((r) => r.action === 'inbox' && r.p95_ms > 2000);
console.log(failed ? 'RESULT: FAIL (more than 1% errors or inbox p95 over 2s)' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
