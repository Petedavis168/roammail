// Minimal in-memory stand-in for the mailcow REST API, for local development only.
// Usage: node dev/mock-mailcow.js   (listens on :8099, API key "dev-key")
import http from 'node:http';

const domains = new Map();
const mailboxes = new Map();
const aliases = new Map();
const filters = new Map();
const syncjobs = new Map();
let nextId = 1;
const policies = []; // { prefid, object, option: 'whitelist_from'|'blacklist_from', value }
const spamScores = new Map();
const quarantine = new Map();
const sources = new Map();
const notify = new Map();
// Seed quarantine with demo items (rcpt filled in on first signup of that address)
const seedQuarantine = (rcpt) => {
  for (const [subject, sender, score, virus] of [['You WON a $1000 gift card!!!', 'promo@win-big.test', 22.5, 0], ['Invoice overdue - open attachment', 'billing@paypa1-secure.test', 31.2, 1], ['Re: our meeting (could be real)', 'colleague@partner.test', 15.8, 0]]) {
    const id = nextId++;
    quarantine.set(id, { id, qid: `Q${id}`, subject, sender, rcpt, score, virus_flag: virus, action: 'reject', created: Math.floor(Date.now() / 1000) - id * 3600, notified: 0,
      msg: `From: ${sender}\r\nTo: ${rcpt}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\nClick here http://evil.test to claim. This is a test quarantined message.`,
      symbols: JSON.stringify([{ name: 'BAYES_SPAM', score: 5.1 }, { name: 'URIBL_BLACK', score: 7.5 }, { name: 'RBL_SPAMHAUS_SBL', score: 4 }]) });
  }
};
// Mirror mailboxes into GreenMail (run it WITHOUT -Dgreenmail.auth.disabled) so passwords are real
const GM = process.env.GREENMAIL_API || 'http://127.0.0.1:8080';
const gmUser = (email, password) => fetch(`${GM}/api/user`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, login: email, password }) }).catch(() => {});
const gmDelete = (email) => fetch(`${GM}/api/user/${encodeURIComponent(email)}`, { method: 'DELETE' }).catch(() => {});
let aliasId = 1;
const ok = (msg) => [{ type: 'success', msg }];
const bad = (msg) => [{ type: 'danger', msg }];

for (const d of (process.env.MOCK_DOMAINS || 'free.test').split(',')) domains.set(d, { domain_name: d, active: 1 });

http.createServer(async (req, res) => {
  const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.headers['x-api-key'] !== 'dev-key') return send(401, { type: 'error', msg: 'authentication failed' });
  let body = '';
  for await (const c of req) body += c;
  const b = body ? JSON.parse(body) : {};
  const p = decodeURIComponent(req.url.replace(/^\/api\/v1\//, ''));
  const [verb, what, ...rest] = p.split('/');
  const arg = rest.join('/');
  if (verb === 'get') {
    if (what === 'domain') return send(200, arg === 'all' ? [...domains.values()] : domains.get(arg) || {});
    if (what === 'mailbox') {
      if (arg.startsWith('all/')) return send(200, [...mailboxes.values()].filter((m) => m.domain === arg.slice(4)));
      return send(200, mailboxes.get(arg) || {});
    }
    if (what === 'dkim') return send(200, domains.get(arg)?.dkim || {});
    if (what === 'alias') return send(200, [...aliases.values()]);
    if (what === 'filters') return send(200, [...filters.values()]);
    if (what === 'syncjob_source') return send(200, [...sources.values()]);
    if (what === 'spam-score') return send(200, { score: spamScores.get(arg) || '5,15' });
    if (what === 'quarantine') return send(200, arg === 'all' ? [...quarantine.values()].map(({ msg, symbols, ...x }) => x) : quarantine.get(Number(arg)) || {});
    if (/^policy_(wl|bl)_(mailbox|domain)$/.test(what)) {
      const [, l, t] = /^policy_(wl|bl)_(mailbox|domain)$/.exec(what);
      const opt = l === 'wl' ? 'whitelist_from' : 'blacklist_from';
      const dom = t === 'mailbox' ? arg.split('@')[1] : arg;
      return send(200, policies.filter((p) => p.option === opt && (t === 'mailbox' ? (p.object === arg || p.object === dom) : (p.object === dom || p.object.endsWith(`@${dom}`)))));
    }
    if (what === 'syncjobs') return send(200, [...syncjobs.values()]);
  }
  if (verb === 'add') {
    if (what === 'domain') { if (domains.has(b.domain)) return send(200, bad('domain_exists')); domains.set(b.domain, { domain_name: b.domain, active: 1, ...b }); return send(200, ok(['domain_added', b.domain])); }
    if (what === 'dkim') { const d = domains.get(b.domains); d.dkim = { dkim_selector: 'dkim', dkim_txt: 'v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmockkey' }; return send(200, ok('dkim_added')); }
    if (what === 'mailbox') {
      const u = `${b.local_part}@${b.domain}`;
      if (!domains.has(b.domain)) return send(200, bad('domain_not_found'));
      if (mailboxes.has(u)) return send(200, bad(['object_exists', u]));
      mailboxes.set(u, { username: u, name: b.name, domain: b.domain, local_part: b.local_part, quota: b.quota * 1048576, quota_used: 0, active: 1, messages: 0, password: b.password });
      await gmUser(u, b.password);
      seedQuarantine(u);
      return send(200, ok(['mailbox_added', u]));
    }
    if (what === 'mailbox-policy' || what === 'domain-policy') {
      policies.push({ prefid: nextId++, object: (b.username || b.domain).toLowerCase(), option: b.object_list === 'bl' ? 'blacklist_from' : 'whitelist_from', value: b.object_from.toLowerCase() });
      return send(200, ok('object_modified'));
    }
    if (what === 'syncjob_source') { const id = nextId++; sources.set(id, { id, ...b }); return send(200, ok(['imapsync_source_added', b.name])); }
    if (what === 'syncjob' && !b.source_id && !b.host1) return send(200, bad('source_id missing'));
    if (what === 'filter') { const id = nextId++; filters.set(id, { id, ...b }); return send(200, ok('filter_added')); }
    if (what === 'syncjob') { const id = nextId++; syncjobs.set(id, { id, user2: b.username, ...b, is_running: 0, last_run: null, success: null }); return send(200, ok('syncjob_added')); }
    if (what === 'alias') { const id = aliasId++; aliases.set(id, { id, address: b.address, goto: b.goto, active: 1, domain: b.address.split('@')[1] }); return send(200, ok('alias_added')); }
  }
  if (verb === 'edit' && what === 'spam-score') { for (const k of b.items) b.attr.spam_score === 'default' ? spamScores.delete(k) : spamScores.set(k, b.attr.spam_score); return send(200, ok('mailbox_modified')); }
  if (verb === 'edit' && (what === 'quarantine_notification' || what === 'quarantine_category')) { for (const k of b.items) notify.set(`${what}:${k}`, Object.values(b.attr)[0]); return send(200, ok('mailbox_modified')); }
  if (verb === 'edit' && what === 'qitem') {
    for (const k of b.items) { const it = quarantine.get(Number(k)); if (!it) return send(200, bad('item not found')); if (b.attr.action === 'release') quarantine.delete(Number(k)); }
    return send(200, ok(b.attr.action === 'release' ? 'item_released' : 'item_learned'));
  }
  if (verb === 'edit') {
    const store = { mailbox: mailboxes, filter: filters, syncjob: syncjobs }[what] || domains;
    for (const k of b.items) {
      const key = store === filters || store === syncjobs ? Number(k) : k;
      Object.assign(store.get(key) || {}, b.attr);
      if (what === 'mailbox' && b.attr.password) { await gmDelete(k); await gmUser(k, b.attr.password); }
    }
    return send(200, ok('edited'));
  }
  if (verb === 'delete' && (what === 'mailbox-policy' || what === 'domain-policy')) {
    for (const k of b) { const i = policies.findIndex((p) => String(p.prefid) === String(k)); if (i >= 0) policies.splice(i, 1); }
    return send(200, ok('item_deleted'));
  }
  if (verb === 'delete' && what === 'qitem') { for (const k of b) quarantine.delete(Number(k)); return send(200, ok('item_deleted')); }
  if (verb === 'delete') {
    const store = { mailbox: mailboxes, domain: domains, alias: aliases, filter: filters, syncjob: syncjobs }[what];
    for (const k of b) store?.delete(['alias', 'filter', 'syncjob'].includes(what) ? Number(k) : k);
    return send(200, ok('deleted'));
  }
  send(404, { type: 'error', msg: 'route not found' });
}).listen(8099, () => console.log('mock mailcow API on :8099'));
