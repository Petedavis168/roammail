// Stand-in for https://provision.fwdapps.cloud in development and tests: checks the HMAC signature and the
// allowlist exactly like the real provisioner must, then forwards to the (mock) mailcow API with its key.
import http from 'node:http';
import { verify, allowedCall } from '../src/provisioner.js';

const SECRET = process.env.PROVISIONER_SECRET || 'dev-provisioner-secret';
const MAILCOW = process.env.MOCK_MAILCOW_URL || 'http://127.0.0.1:8099';
const KEY = process.env.MOCK_MAILCOW_KEY || 'dev-key';
let calls = 0; let refused = 0;

http.createServer(async (req, res) => {
  const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, calls, refused });
  if (req.method !== 'POST' || url.pathname !== '/mailcow/api') return send(404, { error: 'not found' });
  if (!verify(SECRET, { ts: req.headers['x-fwd-timestamp'], signature: req.headers['x-fwd-signature'], path: url.pathname, body })) { refused++; return send(401, { error: 'bad signature' }); }
  let p; try { p = JSON.parse(body); } catch { return send(400, { error: 'bad json' }); }
  if (!allowedCall(p.method, String(p.path || ''))) { refused++; return send(403, { error: 'not allowed' }); }
  calls++;
  const r = await fetch(`${MAILCOW}/api/v1/${p.path}`, { method: p.method, headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' }, body: p.body !== undefined ? JSON.stringify(p.body) : undefined });
  res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(await r.text());
}).listen(8098, () => console.log('mock provisioner on :8098'));
