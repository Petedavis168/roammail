// Tiny stand-in for the Stripe API (local development only). Sends signed webhooks like Stripe does.
//   STRIPE_API_BASE=http://127.0.0.1:12111 STRIPE_SECRET_KEY=sk_test_mock STRIPE_WEBHOOK_SECRET=whsec_mock
import http from 'node:http';
import crypto from 'node:crypto';

const APP = process.env.APP_URL || 'http://127.0.0.1:3000';
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_mock';
const db = { customers: new Map(), sessions: new Map(), subs: new Map(), items: new Map(), idv: new Map() };
const id = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
const parseForm = (body) => {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const path = k.replace(/\]/g, '').split('['); let o = out;
    path.forEach((p, i) => { if (i === path.length - 1) o[p] = v; else o = o[p] ||= {}; });
  }
  return out;
};
async function webhook(type, object) {
  const payload = JSON.stringify({ id: id('evt'), type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
  await fetch(`${APP}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: payload }).catch((e) => console.warn('webhook failed', e.message));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = ''; for await (const c of req) body += c;
  const send = (code, data, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };

  // Fake Stripe Identity page: pick an outcome (the real one scans the license and a selfie)
  if (url.pathname === '/identity') {
    const v = db.idv.get(url.searchParams.get('s'));
    if (!v) return send(404, 'no session', 'text/html');
    if (req.method === 'POST') {
      const outcome = new URLSearchParams(body).get('outcome') || 'us';
      const person = { first_name: 'Jamie', last_name: new URLSearchParams(body).get('last') || 'Rivera', dob: { year: 1990, month: 1, day: 15 } };
      if (outcome === 'mismatch') Object.assign(v, { status: 'requires_input', last_error: { code: 'selfie_face_mismatch' } });
      else Object.assign(v, { status: 'verified', last_error: null, verified_outputs: person,
        last_verification_report: { document: { type: outcome === 'passport' ? 'passport' : 'driving_license', issuing_country: outcome === 'foreign' ? 'CA' : 'US', ...person } } });
      await webhook(v.status === 'verified' ? 'identity.verification_session.verified' : 'identity.verification_session.requires_input', { id: v.id, object: 'identity.verification_session', status: v.status, metadata: v.metadata });
      res.writeHead(303, { Location: v.return_url }); return res.end();
    }
    return send(200, `<!doctype html><title>Mock Stripe Identity</title><body style="font-family:sans-serif;padding:40px"><h2>Verify your identity</h2><form method="post"><select name="outcome"><option value="us">US driver's license</option><option value="foreign">Canadian license</option><option value="passport">Passport</option><option value="mismatch">Selfie doesn't match</option></select><input name="last" value="Rivera"><button id="verify">Submit</button></form></body>`, 'text/html');
  }
  // Fake hosted checkout page
  if (url.pathname === '/pay') {
    const s = db.sessions.get(url.searchParams.get('s'));
    if (!s) return send(404, 'no session', 'text/html');
    if (req.method === 'POST') {
      const subId = id('sub'); const itemId = id('si');
      db.items.set(itemId, { id: itemId, quantity: Number(s.line_items[0].quantity), price: { id: s.line_items[0].price, recurring: { interval: s.metadata.interval } } });
      db.subs.set(subId, { id: subId, status: 'active', customer: s.customer, metadata: s.metadata, items: { data: [db.items.get(itemId)] } });
      Object.assign(s, { status: 'complete', payment_status: 'paid', subscription: subId });
      if (url.searchParams.get('webhook') !== '0') {
        await webhook('checkout.session.completed', s);
        await webhook('invoice.paid', { id: id('in'), object: 'invoice', customer: s.customer, subscription: subId, number: `MOCK-${db.subs.size}`, currency: 'usd',
          amount_paid: Number(s.line_items[0].quantity) * (s.metadata.interval === 'year' ? 4400 : 400), hosted_invoice_url: 'http://127.0.0.1:12111/invoice', subscription_details: { metadata: s.metadata } });
      }
      res.writeHead(303, { Location: s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) }); return res.end();
    }
    return send(200, `<!doctype html><title>Mock Stripe Checkout</title><body style="font-family:sans-serif;padding:40px"><h2>Mock checkout</h2><p>${s.line_items[0].quantity} user(s), ${s.metadata.interval}ly</p><form method="post"><button id="pay">Pay</button></form></body>`, 'text/html');
  }
  if (req.headers.authorization !== `Bearer ${process.env.STRIPE_SECRET_KEY || 'sk_test_mock'}`) return send(401, { error: { message: 'Invalid API key' } });
  const b = parseForm(body);
  const p = url.pathname.replace(/^\/v1\//, '');
  if (req.method === 'POST' && p === 'customers') { const c = { id: id('cus'), ...b }; db.customers.set(c.id, c); return send(200, c); }
  if (req.method === 'POST' && p === 'checkout/sessions') {
    const s = { id: id('cs_test'), object: 'checkout.session', status: 'open', payment_status: 'unpaid', mode: b.mode, customer: b.customer, metadata: b.metadata, success_url: b.success_url,
      line_items: Object.values(b.line_items), params: b };
    s.url = `http://127.0.0.1:12111/pay?s=${s.id}`;
    db.sessions.set(s.id, s); return send(200, s);
  }
  if (req.method === 'POST' && p === 'identity/verification_sessions') {
    const v = { id: id('vs_test'), object: 'identity.verification_session', status: 'requires_input', type: b.type, options: b.options, metadata: b.metadata, return_url: b.return_url, last_error: null };
    v.url = `http://127.0.0.1:12111/identity?s=${v.id}`; db.idv.set(v.id, v); return send(200, v);
  }
  if (req.method === 'GET' && p === 'invoices') {
    const cust = url.searchParams.get('customer');
    const subs = [...db.subs.values()].filter((x) => x.customer === cust);
    const data = subs.flatMap((x, n) => [
      { id: `in_paid_${x.id}`, number: `MOCK-${n + 1}-1`, created: Math.floor(Date.now() / 1000) - 86400 * 30, amount_due: 400 * x.items.data[0].quantity, amount_paid: 400 * x.items.data[0].quantity, currency: 'usd', status: 'paid', hosted_invoice_url: 'http://127.0.0.1:12111/invoice', invoice_pdf: 'http://127.0.0.1:12111/invoice.pdf' },
      { id: `in_open_${x.id}`, number: `MOCK-${n + 1}-2`, created: Math.floor(Date.now() / 1000), due_date: Math.floor(Date.now() / 1000) + 86400 * 7, amount_due: 400 * x.items.data[0].quantity, amount_paid: 0, currency: 'usd', status: 'open', hosted_invoice_url: 'http://127.0.0.1:12111/invoice?open=1', invoice_pdf: null },
    ]);
    return send(200, { object: 'list', data });
  }
  let m;
  if (req.method === 'GET' && (m = /^identity\/verification_sessions\/([^?]+)$/.exec(p))) return db.idv.has(m[1]) ? send(200, db.idv.get(m[1])) : send(404, { error: { message: 'No such verification session' } });
  if (req.method === 'GET' && (m = /^checkout\/sessions\/(.+)$/.exec(p))) return db.sessions.has(m[1]) ? send(200, db.sessions.get(m[1])) : send(404, { error: { message: 'No such session' } });
  if (req.method === 'GET' && (m = /^subscriptions\/(.+)$/.exec(p))) return db.subs.has(m[1]) ? send(200, db.subs.get(m[1])) : send(404, { error: { message: 'No such subscription' } });
  if (req.method === 'POST' && (m = /^subscription_items\/(.+)$/.exec(p))) {
    const it = db.items.get(m[1]); if (!it) return send(404, { error: { message: 'No such item' } });
    it.quantity = Number(b.quantity); return send(200, it);
  }
  if (req.method === 'POST' && p === 'billing_portal/sessions') return send(200, { url: `http://127.0.0.1:12111/portal?c=${b.customer}` });
  if (req.method === 'POST' && p === 'test/fail') { // test helper: a renewal payment fails
    const sub = db.subs.get(b.subscription);
    await webhook('invoice.payment_failed', { id: id('in'), object: 'invoice', customer: sub.customer, subscription: sub.id, currency: 'usd', amount_due: 400, hosted_invoice_url: 'http://127.0.0.1:12111/invoice', subscription_details: { metadata: sub.metadata } });
    return send(200, { ok: true });
  }
  if (req.method === 'GET' && p === 'test/last-session') return send(200, [...db.sessions.values()].pop()?.params || {});
  if (req.method === 'POST' && p === 'test/cancel') { // test helper: cancel a subscription
    const sub = db.subs.get(b.subscription); sub.status = 'canceled'; await webhook('customer.subscription.deleted', sub); return send(200, sub);
  }
  send(404, { error: { message: `mock: ${req.method} ${p} not implemented` } });
}).listen(12111, () => console.log('mock Stripe on :12111'));
