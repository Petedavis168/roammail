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
const codes = new Map();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    const u = new URL(req.url, BASE);
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname.startsWith('/unsub/') && req.method === 'POST') { unsubs.push({ path: u.pathname, body }); return json(200, { ok: true }); } // one-click unsubscribe stand-in
    if (u.pathname === '/test/unsubs') return json(200, unsubs);
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
