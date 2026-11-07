// Unit tests for security-critical pure functions.  Run: npm test
process.env.SESSION_SECRET = 'unit-test-secret';
process.env.DATA_DIR = process.env.DATA_DIR || `${process.env.TMPDIR || '/tmp'}/mc-unit-${process.pid}`;
process.env.CHECK_BREACHED_PASSWORDS = 'false';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';

const { parseQuery } = await import('../src/search.js');
const { buildSieve } = await import('../src/mailtools.js');
const { cleanHtml, renderTemplate } = await import('../src/signatures.js');
const { spamInfo } = await import('../src/spam.js');
const { totp, base32, verifyTotp } = await import('../src/security.js');
const { seal, unseal } = await import('../src/session.js');
const abuse = await import('../src/abuse.js');

test('search: Gmail operators map to IMAP criteria', () => {
  const { criteria, folder } = parseQuery('from:bob is:unread has:attachment invoice -spam in:Sent');
  assert.equal(criteria.from, 'bob');
  assert.equal(criteria.seen, false);
  assert.deepEqual(criteria.header, { 'Content-Type': 'multipart/mixed' });
  assert.equal(criteria.text, 'invoice');
  assert.deepEqual(criteria.not, { text: 'spam' });
  assert.equal(folder, 'Sent');
  assert.deepEqual(parseQuery('').criteria, { all: true });
});

test('sieve: spam is filed to Junk before any rule or auto-reply', () => {
  const s = buildSieve({ vacation: { enabled: true, message: 'Away', subject: 'Out' }, rules: [{ name: 'x', match: 'any', conditions: [{ field: 'from', value: 'a@b.c' }], actions: [{ type: 'move', folder: 'F' }] }] }, 'me@d.e', ['d.e']);
  const spam = s.indexOf('X-Spam-Flag'); const vac = s.indexOf('vacation :days'); const rule = s.indexOf('fileinto "F"');
  assert.ok(spam > 0 && spam < vac && spam < rule);
});

test('sieve: user text cannot break out of strings or the multiline body', () => {
  const s = buildSieve({ vacation: { enabled: true, subject: 'a" ; discard; "', message: 'line\n.\nstop;' }, rules: [{ name: 'evil\nkeep;', conditions: [{ field: 'subject', value: '"; discard; "' }], actions: [{ type: 'read' }] }] }, 'me@d.e', ['d.e']);
  assert.ok(s.includes('"a\\" ; discard; \\""'));
  assert.ok(s.includes('\n..\nstop;'), 'a lone "." line in the message is dot-stuffed');
  assert.ok(s.includes('"\\"; discard; \\""'));
  assert.ok(!/^keep;/m.test(s), 'newline in a rule name cannot inject a command');
});

test('signatures: dangerous HTML is stripped', () => {
  const out = cleanHtml('<b onclick="x()">Hi</b><script>alert(1)</script><img src="javascript:alert(1)"><a href="javascript:alert(1)">l</a><iframe src="//e"></iframe><img src="https://ok.test/l.png" onerror="x">');
  assert.ok(!/script|onclick|onerror|javascript:|iframe/i.test(out), out);
  assert.ok(out.includes('https://ok.test/l.png'));
});

test('signatures: placeholder values are escaped, sections hide empty fields', () => {
  const out = renderTemplate('<p>{{name}}{{#phone}} T: {{phone}}{{/phone}}{{^title}} (no title){{/title}}</p>', { name: '<img src=x onerror=alert(1)>', phone: '' });
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('&lt;img'));
  assert.ok(!out.includes('T:'));
  assert.ok(out.includes('(no title)'));
});

test('spam: rspamd header is parsed into score and human reasons', () => {
  const i = spamInfo('default: True [11.40 / 15.00]; BAYES_SPAM(5.10)[99%]; RBL_SPAMHAUS_SBL(4.00)[x]; R_SPF_ALLOW(-0.20)[x]');
  assert.equal(i.score, 11.4);
  assert.equal(i.threshold, 15);
  assert.equal(i.reasons.length, 2);
  assert.equal(spamInfo(undefined), null);
});

test('2FA: TOTP matches RFC 6238 test vector and rejects bad codes', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  assert.equal(totp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(verifyTotp(secret, 'abcdef'), false);
  assert.equal(verifyTotp(secret, totp(secret, Math.floor(Date.now() / 30000))), true);
});

test('sessions: sealed data is encrypted and tamper-proof', () => {
  const token = seal({ password: 'hunter22-secret' });
  assert.ok(!token.includes('hunter22'));
  assert.equal(unseal(token).password, 'hunter22-secret');
  const raw = Buffer.from(token, 'base64url'); raw[raw.length - 1] ^= 1;
  assert.equal(unseal(raw.toString('base64url')), null);
  assert.equal(unseal(seal({ exp: Date.now() - 1 })), null, 'expired data is rejected');
});

test('abuse: private and metadata addresses are blocked for imports', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(abuse._isPrivate(ip), true, ip);
  }
  assert.equal(abuse._isPrivate('142.250.1.108'), false);
  const real = dns.lookup;
  try {
    dns.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await assert.rejects(abuse.assertPublicHost('rebind.example.com', 993), /not allowed/);
    await assert.rejects(abuse.assertPublicHost('imap.gmail.com', 22), /ports/);
    await assert.rejects(abuse.assertPublicHost('10.0.0.1', 993), /server name/);
  } finally { dns.lookup = real; }
});

test('abuse: common passwords are refused, strong ones allowed', async () => {
  for (const p of ['password123', 'Password123!', 'qwerty2026', 'Summer2026!', '11111111111', 'abcdefghijk']) {
    await assert.rejects(abuse.assertNotBreached(p, 'x@y.z'), /common|easy/, p);
  }
  await assert.rejects(abuse.assertNotBreached('janedoe-2026!', 'janedoe@y.z'), /email name/);
  await abuse.assertNotBreached('Tq9-vLm2-Zx81', 'x@y.z');
  await abuse.assertNotBreached('correct horse battery staple', 'x@y.z');
});

test('abuse: display names cannot impersonate an address', () => {
  assert.equal(abuse.cleanDisplayName('CEO <boss@bank.com>'), 'CEO');
  assert.equal(abuse.cleanDisplayName('"support@paypal.com"'), '');
  assert.equal(abuse.cleanDisplayName('Jane Smith'), 'Jane Smith');
  assert.equal(abuse.cleanDisplayName('a\r\nBcc: x'), 'aBcc: x');
});

test('abuse: login throttling is per account+IP', async () => {
  const e = `t${Date.now()}@x.y`;
  for (let i = 0; i < 10; i++) await abuse.loginFailed(e, '6.6.6.6');
  assert.ok(await abuse.loginBlocked(e, '6.6.6.6') > 0);
  assert.equal(await abuse.loginBlocked(e, '10.0.0.9'), 0, 'the real user on another IP is not locked out');
});

test('sessions: key rotation keeps old sealed data readable', async () => {
  const { config } = await import('../src/config.js');
  const crypto = await import('node:crypto');
  const old = seal({ secret: 'ABC' });
  const prevKey = config.sealKey;
  config.sealKeyPrevious = prevKey;
  config.sealKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from('new-secret'), Buffer.alloc(0), 'mailclient/seal/v1', 32));
  try {
    assert.equal(unseal(old).secret, 'ABC');
    const { sealedWithOldKey } = await import('../src/session.js');
    assert.equal(sealedWithOldKey(old), true);
    assert.equal(sealedWithOldKey(seal({ x: 1 })), false);
  } finally { config.sealKey = prevKey; config.sealKeyPrevious = null; }
});

test('cache: single-flight, TTL, bound, failures not cached', async () => {
  const { createCache } = await import('../src/cache.js');
  const c = createCache({ ttlMs: 50, max: 3 });
  let calls = 0;
  const load = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return calls; };
  const [a, b] = await Promise.all([c.get('k', load), c.get('k', load)]);
  assert.equal(a, 1); assert.equal(b, 1); assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await c.get('k', load), 2);
  await assert.rejects(c.get('bad', async () => { throw new Error('x'); }));
  assert.equal(c.peek('bad'), undefined);
  for (const k of ['a', 'b', 'c', 'd']) c.set(k, k);
  assert.ok(c.size <= 3);
});

test('database backup: consistent copy, keeps the last 7', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { backupDatabase } = await import('../src/ops.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbb-'));
  for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(dir, `app-2020-01-0${i}.db`), '');
  const f = backupDatabase(dir, 7);
  assert.ok(fs.statSync(f).size > 0);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 7); assert.ok(left.includes(path.basename(f))); assert.ok(!left.includes('app-2020-01-01.db'));
});

test('SQL translation to PostgreSQL', async () => {
  const { toPg, toPgSchema } = await import('../src/db.js');
  assert.equal(toPg("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?"), "SELECT * FROM t WHERE a = $1 AND b = '?' AND c = $2");
  assert.match(toPg("SELECT 1 WHERE at > datetime('now', '-1 day')"), /CAST\('-1 day' AS interval\)/);
  assert.match(toPg("DELETE FROM x WHERE at < datetime('now', ?)"), /CAST\(\$1 AS interval\)/);
  assert.match(toPg("SELECT * FROM s WHERE day = date('now')"), /'YYYY-MM-DD'\)$/);
  assert.equal(toPg('INSERT OR IGNORE INTO d(a) VALUES(?)'), 'INSERT INTO d(a) VALUES($1) ON CONFLICT DO NOTHING');
  assert.match(toPgSchema('id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER'), /BIGSERIAL PRIMARY KEY, n BIGINT/);
});
