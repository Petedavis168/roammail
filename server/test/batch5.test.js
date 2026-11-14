// Batch 5: deliverability (SNDS parsing), fast mail lists (change-counter cache), in-app help (assistant, guides,
// contact), Spanish coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseSnds } from '../src/deliverability.js';
import { cachedList, listCacheStats } from '../src/listcache.js';
import { matchArticles } from '../src/help.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PW = 'Tq9-vLm2-Zx81';

test('Microsoft SNDS data is read', () => {
  const rows = parseSnds('203.0.113.7,11/12/2026 12:00 AM,11/13/2026 12:00 AM,1200,1180,1300,GREEN,< 0.1%,,,0,\r\nnot,a,row\r\n198.51.100.2,11/12/2026 12:00 AM,11/13/2026 12:00 AM,10,10,10,RED,1.5%,,,3,');
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].ip, rows[0].filter, rows[0].recipients], ['203.0.113.7', 'GREEN', 1300]);
  assert.equal(rows[1].trapHits, 3);
});

test('mail lists are reused only while the folder is unchanged', async () => {
  let modseq = 10; let computed = 0;
  const client = { capabilities: new Map([['CONDSTORE', true]]), mailbox: { path: 'INBOX', uidValidity: 7 }, status: async () => ({ messages: 3, uidNext: 4, highestModseq: modseq }) };
  const compute = async () => { computed++; return { total: 3, messages: [{ uid: computed }] }; };
  const key = `t${crypto.randomBytes(3).toString('hex')}@x|INBOX|0|50||`;
  const a = await cachedList(client, key, compute);
  const b = await cachedList(client, key, compute);
  assert.equal(computed, 1, 'second call answered from the copy'); assert.deepEqual(a, b);
  b.messages[0].uid = 999; // callers can't change the saved copy
  assert.equal((await cachedList(client, key, compute)).messages[0].uid, 1);
  modseq = 11; // anything changed in the folder (new mail, read, deleted)
  await cachedList(client, key, compute);
  assert.equal(computed, 2, 'changed folder is fetched again');
  const noCondstore = { ...client, capabilities: new Map() };
  await cachedList(noCondstore, key, compute); await cachedList(noCondstore, key, compute);
  assert.equal(computed, 4, 'servers without a change counter are never cached');
  assert.ok(listCacheStats.hits >= 2);
});

test('help guides match questions', () => {
  assert.equal(matchArticles('how do I set an out of office reply')[0].slug, 'out-of-office');
  assert.equal(matchArticles('disappearing email')[0].slug, 'disappearing');
  assert.equal(matchArticles('zzzz qqqq').length, 0);
});

test('every phrase in the app has a Spanish translation', async () => {
  const es = (await import('../../client/src/locales/es.js')).default;
  const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'locales') walk(p); } else if (/\.jsx?$/.test(f) && f !== 'i18n.js') files.push(p); } };
  walk(new URL('../../client/src', import.meta.url).pathname);
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*?)\1\s*\)/g; const missing = new Set();
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8'); let m;
    while ((m = re.exec(s))) { const k = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n'); if (!(k in es)) missing.add(k); }
  }
  assert.deepEqual([...missing], []);
});

test('in-app help: assistant answers from the guides, and people can reach the team', async () => {
  const ip = `198.51.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
  let cookie = '';
  const req = async (method, p, b) => {
    const r = await fetch(BASE + p, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': ip, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    for (const c of r.headers.getSetCookie()) if (c.startsWith('mc_session=')) cookie = c.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const u = `hp${crypto.randomBytes(3).toString('hex')}`;
  assert.equal((await req('POST', '/api/signup', { name: 'Help Test', username: u, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'r@example.org', phone: '+15555550123', formMs: 60000 })).status, 200);
  await req('POST', '/api/setup/2fa/remind'); await req('POST', '/api/setup/step', { step: 'done' });
  const arts = (await req('GET', '/api/help/articles')).data;
  assert.ok(arts.articles.length >= 20); assert.ok(arts.articles.every((a) => !/<[a-z]/i.test(a.text)), 'plain text');
  let r = await req('POST', '/api/help/ask', { question: 'How do I set up an out of office reply?' });
  assert.equal(r.status, 200); assert.match(r.data.answer, /Automatic replies/);
  assert.deepEqual(r.data.articles.map((a) => a.slug), ['out-of-office'], 'only real guides are linked');
  assert.equal(r.data.contactSupport, false);
  const seen = await (await fetch('http://127.0.0.1:8096/__seen')).json();
  const last = seen[seen.length - 1];
  assert.match(last.user, /<question>How do I set up an out of office reply\?<\/question>/);
  assert.match(JSON.stringify(last.system), /never ask for a password/i);
  r = await req('POST', '/api/help/ask', { question: 'I was charged twice, I want a refund' });
  assert.equal(r.data.contactSupport, true);
  r = await req('POST', '/api/help/ticket', { message: 'I was charged twice', transcript: [{ role: 'user', text: 'I was charged twice' }] });
  assert.equal(r.status, 200); assert.ok(r.data.id > 0);
  assert.equal((await req('POST', '/api/help/ask', { question: '' })).status, 400);
});
