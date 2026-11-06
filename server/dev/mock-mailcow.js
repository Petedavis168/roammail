// Minimal in-memory stand-in for the mailcow REST API, for local development only.
// Usage: node dev/mock-mailcow.js   (listens on :8099, API key "dev-key")
import http from 'node:http';

const domains = new Map();
const mailboxes = new Map();
const aliases = new Map();
const filters = new Map();
const syncjobs = new Map();
let nextId = 1;
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
      return send(200, ok(['mailbox_added', u]));
    }
    if (what === 'filter') { const id = nextId++; filters.set(id, { id, ...b }); return send(200, ok('filter_added')); }
    if (what === 'syncjob') { const id = nextId++; syncjobs.set(id, { id, user2: b.username, ...b, is_running: 0, last_run: null, success: null }); return send(200, ok('syncjob_added')); }
    if (what === 'alias') { const id = aliasId++; aliases.set(id, { id, address: b.address, goto: b.goto, active: 1, domain: b.address.split('@')[1] }); return send(200, ok('alias_added')); }
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
  if (verb === 'delete') {
    const store = { mailbox: mailboxes, domain: domains, alias: aliases, filter: filters, syncjob: syncjobs }[what];
    for (const k of b) store?.delete(['alias', 'filter', 'syncjob'].includes(what) ? Number(k) : k);
    return send(200, ok('deleted'));
  }
  send(404, { type: 'error', msg: 'route not found' });
}).listen(8099, () => console.log('mock mailcow API on :8099'));
