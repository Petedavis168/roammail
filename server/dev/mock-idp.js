// Stand-in for Microsoft and Google sign-in (tests only). Tests choose who "signs in" next with POST /test/next
// { claims }; /authorize sends the browser straight back with a code, /token trades it for an ID token.
//   Microsoft: http://127.0.0.1:8095/ms     Google: http://127.0.0.1:8095/google
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_IDP_PORT || 8095);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRETS = { 'ms-client': 'ms-secret', 'google-client': 'google-secret' };
let next = null;
const unsubs = [];
const cfState = {};
const codes = new Map();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    const u = new URL(req.url, BASE);
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname.startsWith('/unsub/') && req.method === 'POST') { unsubs.push({ path: u.pathname, body }); return json(200, { ok: true }); } // one-click unsubscribe stand-in
    if (u.pathname === '/test/unsubs') return json(200, unsubs);
    // Slack/Teams webhook stand-in (chat alerts)
    if (u.pathname.startsWith('/services/') && req.method === 'POST') { unsubs.push({ path: u.pathname, body, hook: true }); return json(200, { ok: true }); }
    if (u.pathname === '/test/hooks') return json(200, unsubs.filter((x) => x.hook));
    // Cloudflare API stand-in (one-click DNS)
    if (u.pathname.startsWith('/cf/')) {
      if (req.headers.authorization !== 'Bearer cf_test_token_abcdefghijklmnopqrstuvwxyz0123') return json(403, { success: false, errors: [{ message: 'Invalid API token' }] });
      cfState.records ||= [{ id: 'old-mx', type: 'MX', name: u.searchParams.get('name') || 'example.test', content: 'mx.oldhost.example', priority: 10 }];
      if (u.pathname === '/cf/zones') { if (cfState.zone !== u.searchParams.get('name')) cfState.records = [{ id: 'old-mx', type: 'MX', name: u.searchParams.get('name'), content: 'mx.oldhost.example', priority: 10 }, { id: 'web', type: 'A', name: u.searchParams.get('name'), content: '203.0.113.5' }]; cfState.zone = u.searchParams.get('name'); return json(200, { success: true, result: [{ id: 'z1', name: cfState.zone }] }); }
      if (u.pathname === '/cf/zones/z1/dns_records' && req.method === 'GET') return json(200, { success: true, result: cfState.records });
      if (u.pathname === '/cf/zones/z1/dns_records' && req.method === 'POST') { const r = { id: `r${cfState.records.length}`, ...JSON.parse(body) }; cfState.records.push(r); return json(200, { success: true, result: r }); }
      if (u.pathname.startsWith('/cf/zones/z1/dns_records/') && req.method === 'DELETE') { const id = u.pathname.split('/').pop(); cfState.records = cfState.records.filter((x) => x.id !== id); return json(200, { success: true, result: { id } }); }
    }
    if (u.pathname === '/test/cf') return json(200, cfState);
    if (u.pathname === '/test/next' && req.method === 'POST') { next = JSON.parse(body || '{}').claims || null; return json(200, { ok: true }); }
    const ms = u.pathname.startsWith('/ms/');
    if (u.pathname === '/ms/organizations/oauth2/v2.0/authorize' || u.pathname === '/google/o/oauth2/v2/auth') {
      const back = new URL(u.searchParams.get('redirect_uri'));
      if (!next) { back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', u.searchParams.get('state')); res.writeHead(302, { Location: back.toString() }); return res.end(); }
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { claims: next, nonce: u.searchParams.get('nonce'), client: u.searchParams.get('client_id'), redirect: u.searchParams.get('redirect_uri'), ms });
      back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if ((u.pathname === '/ms/organizations/oauth2/v2.0/token' || u.pathname === '/google/token') && req.method === 'POST') {
      const p = new URLSearchParams(body);
      const c = codes.get(p.get('code')); codes.delete(p.get('code'));
      if (!c || SECRETS[p.get('client_id')] !== p.get('client_secret') || c.client !== p.get('client_id') || c.redirect !== p.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
      const iss = c.ms ? `${BASE}/ms/${c.claims.tid}/v2.0` : `${BASE}/google`;
      const claims = { iss, aud: c.client, exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), nonce: c.nonce, ...c.claims };
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig` });
    }
    json(404, {});
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock idp on ${PORT}`));
