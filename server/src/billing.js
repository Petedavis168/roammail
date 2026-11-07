// Billing: Friendly Web Services customer codes (first mailbox free) and Stripe subscriptions ($ per user).
// Card details never touch this server: payment happens on Stripe Checkout and the Stripe customer portal.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, rolesFor, audit, twoFactorPolicy } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import rateLimit from 'express-rate-limit';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const B = config.billing;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------------------------------------------------------------- Stripe REST (form-encoded, no SDK)
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
export async function stripe(method, path, body, idempotencyKey) {
  if (!B.stripeKey) throw fail(503, 'Payments are not set up on this server yet');
  const res = await fetch(`${B.apiBase}/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${B.stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: body ? form(body).toString() : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(502, `Payment provider error: ${data?.error?.message || res.status}`);
  return data;
}

// ---------------------------------------------------------------- plan math
export function orgBilling(orgId) {
  const o = q.get('SELECT id, name, owner_email, plan, billing_interval, billing_status, paid_seats, stripe_customer, stripe_subscription, canceled_at FROM orgs WHERE id = ?', orgId);
  if (!o) return null;
  const free = o.plan === 'friendly' ? B.friendlyFreeMailboxes : B.standardFreeMailboxes;
  return { ...o, free, friendly: o.plan === 'friendly', enabled: B.enabled };
}
async function mailboxCount(orgId) {
  let n = 0;
  for (const d of q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", orgId)) n += (await mailcow.listMailboxes(d.domain).catch(() => [])).length;
  return n;
}
export function price(interval) { return interval === 'year' ? B.perUserYearly : B.perUserMonthly; }

/** Does activating this org's domain require payment first? (non-Friendly customers pay at the end of setup) */
export function needsPaymentToActivate(orgId) {
  if (!B.enabled) return false;
  const b = orgBilling(orgId);
  return b.free < 1 && b.billing_status !== 'active' && b.billing_status !== 'past_due';
}

/** Before adding a mailbox: is a paid seat available? Returns { ok } or info for the UI. */
export async function seatCheck(orgId) {
  if (!B.enabled) return { ok: true };
  const b = orgBilling(orgId);
  const after = (await mailboxCount(orgId)) + 1;
  const billable = Math.max(0, after - b.free);
  if (billable <= b.paid_seats) return { ok: true };
  return { ok: false, billable, hasSubscription: !!b.stripe_subscription && b.billing_status !== 'canceled', interval: b.billing_interval || 'month', perUser: price(b.billing_interval || 'month') };
}

async function subscriptionItem(subId) {
  const sub = await stripe('GET', `subscriptions/${encodeURIComponent(subId)}`);
  return { sub, item: sub.items?.data?.[0] };
}

/** Change the number of paid seats on an existing subscription (prorated, charged now). */
export async function setSeats(orgId, seats, reason) {
  const b = orgBilling(orgId);
  if (!b.stripe_subscription) throw fail(402, 'No subscription yet', 'checkout_required');
  const { item } = await subscriptionItem(b.stripe_subscription);
  if (!item) throw fail(502, 'Subscription has no items');
  if (seats < 1) seats = 1; // keep the subscription alive; Stripe needs quantity >= 1 (reduce to 0 = cancel in portal)
  await stripe('POST', `subscription_items/${encodeURIComponent(item.id)}`, { quantity: seats, proration_behavior: seats > item.quantity ? 'always_invoice' : 'create_prorations' }, `${orgId}-${seats}-${reason}-${Date.now() / 60000 | 0}`);
  q.run('UPDATE orgs SET paid_seats = ? WHERE id = ?', seats, orgId);
  audit('billing', orgId, 'billing.seats', { seats, reason });
}

/** After a user is removed, drop unneeded paid seats (credit is applied by Stripe). */
export async function shrinkSeats(orgId) {
  if (!B.enabled) return;
  const b = orgBilling(orgId);
  if (!b.stripe_subscription || b.billing_status === 'canceled') return;
  const needed = Math.max(1, (await mailboxCount(orgId)) - b.free);
  if (needed < b.paid_seats) await setSeats(orgId, needed, 'user-removed').catch((e) => console.warn('shrink seats failed', e.message));
}

// ---------------------------------------------------------------- activation after payment
let activateHook = async () => {};
export const onPaid = (fn) => { activateHook = fn; };

async function markPaid(orgId, { subscription, customer, seats, interval, status = 'active' }) {
  q.run('UPDATE orgs SET stripe_subscription = COALESCE(?, stripe_subscription), stripe_customer = COALESCE(?, stripe_customer), paid_seats = ?, billing_interval = ?, billing_status = ?, canceled_at = NULL WHERE id = ?',
    subscription || null, customer || null, seats, interval, status, orgId);
  audit('billing', orgId, 'billing.paid', { seats, interval });
  await activateHook(orgId);
}

// ---------------------------------------------------------------- admin guard
function requireOrgAdmin(req, orgId) {
  const id = Number(orgId);
  if (!q.get('SELECT 1 FROM orgs WHERE id = ?', id)) throw fail(404, 'Organization not found');
  const r = rolesFor(req.user.email);
  if (!r.superAdmin && !r.orgs.some((o) => o.id === id && o.role === 'admin')) throw fail(403, 'You are not an admin of this organization');
  return id;
}
// Payment return links must point at our real address (not whatever Host header a request carries)
const base = (req) => {
  if (config.publicUrl) return config.publicUrl;
  if (process.env.NODE_ENV === 'production') throw fail(503, 'PUBLIC_URL must be set before taking payments');
  return `${req.protocol}://${req.get('host')}`;
};

// ---------------------------------------------------------------- API
export const billing = express.Router();

// Stripe webhook: raw body + signature check (mounted before the JSON parser in index.js)
export const billingWebhook = express.Router();
billingWebhook.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), wrap(async (req, res) => {
  if (!B.webhookSecret) return res.status(503).end();
  const sig = String(req.get('stripe-signature') || '');
  const t = /t=(\d+)/.exec(sig)?.[1];
  const v1s = [...sig.matchAll(/v1=([0-9a-f]+)/g)].map((m) => m[1]);
  const expected = crypto.createHmac('sha256', B.webhookSecret).update(`${t}.${req.body.toString('utf8')}`).digest('hex');
  const valid = t && Math.abs(Date.now() / 1000 - Number(t)) < 300 && v1s.some((v) => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
  if (!valid) { console.warn('SECURITY_BAD_WEBHOOK signature'); return res.status(400).json({ error: 'bad signature' }); }
  const event = JSON.parse(req.body.toString('utf8'));
  if (q.get('SELECT 1 FROM billing_events WHERE id = ?', event.id)) return res.json({ received: true, duplicate: true });
  const obj = event.data?.object || {};
  const orgId = Number(obj.metadata?.org_id || obj.subscription_details?.metadata?.org_id || 0) || q.get('SELECT id FROM orgs WHERE stripe_customer = ?', obj.customer || '')?.id;
  q.run('INSERT INTO billing_events(id, type, org_id) VALUES(?, ?, ?)', event.id, event.type, orgId || null);
  if (!orgId) return res.json({ received: true });
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required')) {
        await markPaid(orgId, { subscription: obj.subscription, customer: obj.customer, seats: Number(obj.metadata?.seats || 1), interval: obj.metadata?.interval || 'month' });
      }
      break;
    case 'customer.subscription.updated': {
      const qty = obj.items?.data?.[0]?.quantity; const status = obj.status;
      q.run('UPDATE orgs SET billing_status = ?, paid_seats = COALESCE(?, paid_seats), billing_interval = COALESCE(?, billing_interval) WHERE id = ?',
        status === 'active' || status === 'trialing' ? 'active' : status === 'past_due' || status === 'unpaid' ? 'past_due' : status === 'canceled' ? 'canceled' : status,
        qty ?? null, obj.items?.data?.[0]?.price?.recurring?.interval || null, orgId);
      break;
    }
    case 'customer.subscription.deleted':
      q.run("UPDATE orgs SET billing_status = 'canceled', canceled_at = datetime('now') WHERE id = ?", orgId);
      audit('billing', orgId, 'billing.canceled');
      break;
    case 'invoice.payment_failed':
      q.run("UPDATE orgs SET billing_status = 'past_due' WHERE id = ?", orgId);
      break;
    case 'invoice.paid':
      q.run("UPDATE orgs SET billing_status = 'active' WHERE id = ? AND billing_status = 'past_due'", orgId);
      break;
    default: break;
  }
  res.json({ received: true });
}));

billing.use('/billing', requireAuth);
billing.use('/super/friendly-codes', requireAuth);

billing.get('/billing/config', (req, res) => res.json({
  enabled: B.enabled, perUserMonthly: B.perUserMonthly, perUserYearly: B.perUserYearly, currency: B.currency,
  friendlyFree: B.friendlyFreeMailboxes, standardFree: B.standardFreeMailboxes,
}));

billing.get('/billing/:orgId', wrap(async (req, res) => {
  const id = requireOrgAdmin(req, req.params.orgId);
  const b = orgBilling(id);
  const used = await mailboxCount(id);
  res.json({ plan: b.plan, friendly: b.friendly, status: b.billing_status, interval: b.billing_interval, paidSeats: b.paid_seats, free: b.free,
    used, billable: Math.max(0, used - b.free), perUser: price(b.billing_interval || 'month'), currency: B.currency, enabled: B.enabled,
    needsPayment: needsPaymentToActivate(id), canceledAt: b.canceled_at });
}));

// Friendly Web Services customers: apply a code (single use)
billing.post('/billing/:orgId/friendly', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), wrap(async (req, res) => {
  const id = requireOrgAdmin(req, req.params.orgId);
  const code = String(req.body.code || '').trim().toUpperCase().replace(/\s+/g, '');
  const row = code && q.get('SELECT * FROM friendly_codes WHERE code_hash = ?', sha(code));
  if (!row || row.used_by_org) { audit(req.user.email, id, 'billing.friendly_code_failed'); throw fail(400, "That code isn't valid. Check it with Friendly Web Services."); }
  q.run("UPDATE friendly_codes SET used_by_org = ?, used_at = datetime('now') WHERE code_hash = ?", id, row.code_hash);
  q.run("UPDATE orgs SET plan = 'friendly' WHERE id = ?", id);
  audit(req.user.email, id, 'billing.friendly', { hint: row.hint });
  res.json({ ok: true, plan: 'friendly' });
}));

// Start Stripe Checkout for N seats (monthly or yearly)
billing.post('/billing/:orgId/checkout', wrap(async (req, res) => {
  const id = requireOrgAdmin(req, req.params.orgId);
  if (!B.enabled) throw fail(400, 'Billing is not enabled');
  const interval = req.body.interval === 'year' ? 'year' : 'month';
  const priceId = interval === 'year' ? B.priceYearly : B.priceMonthly;
  if (!priceId) throw fail(503, 'Prices are not configured on this server yet');
  const b = orgBilling(id);
  if (b.stripe_subscription && b.billing_status !== 'canceled') throw fail(400, 'You already have a subscription. Use Manage billing.');
  const seats = Math.max(1, Math.min(10000, Number(req.body.seats) || Math.max(1, (await mailboxCount(id)) + (Number(req.body.adding) || 0) - b.free)));
  let customer = b.stripe_customer;
  if (!customer) {
    customer = (await stripe('POST', 'customers', { email: req.user.email, name: b.name, metadata: { org_id: id } }, `cust-${id}`)).id;
    q.run('UPDATE orgs SET stripe_customer = ? WHERE id = ?', customer, id);
  }
  const session = await stripe('POST', 'checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: String(id),
    line_items: { 0: { price: priceId, quantity: seats } },
    success_url: `${base(req)}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base(req)}/?billing=canceled`,
    metadata: { org_id: id, seats, interval }, subscription_data: { metadata: { org_id: id } },
    allow_promotion_codes: 'true', billing_address_collection: 'auto',
  });
  audit(req.user.email, id, 'billing.checkout', { seats, interval });
  res.json({ url: session.url });
}));

// Return from Checkout: confirm with Stripe directly (in case the webhook is delayed). Never trusts the browser.
billing.post('/billing/confirm', wrap(async (req, res) => {
  const sid = String(req.body.sessionId || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw fail(400, 'Invalid session');
  const s = await stripe('GET', `checkout/sessions/${sid}`);
  const id = requireOrgAdmin(req, Number(s.metadata?.org_id));
  if (s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required')) {
    if (orgBilling(id).billing_status !== 'active') await markPaid(id, { subscription: s.subscription, customer: s.customer, seats: Number(s.metadata?.seats || 1), interval: s.metadata?.interval || 'month' });
    return res.json({ ok: true, orgId: id });
  }
  res.json({ ok: false, status: s.status });
}));

// Add paid seats to an existing subscription (admin confirmed the charge in the UI)
billing.post('/billing/:orgId/seats', wrap(async (req, res) => {
  const id = requireOrgAdmin(req, req.params.orgId);
  const check = await seatCheck(id);
  if (check.ok) return res.json({ ok: true });
  if (!check.hasSubscription) throw fail(402, 'Choose a plan first', 'checkout_required');
  await setSeats(id, check.billable, 'user-added');
  res.json({ ok: true, seats: check.billable });
}));

// Stripe customer portal: cards, invoices, switch monthly/yearly, cancel
billing.post('/billing/:orgId/portal', wrap(async (req, res) => {
  const id = requireOrgAdmin(req, req.params.orgId);
  const b = orgBilling(id);
  if (!b.stripe_customer) throw fail(400, 'No billing account yet');
  const p = await stripe('POST', 'billing_portal/sessions', { customer: b.stripe_customer, return_url: `${base(req)}/?billing=portal` });
  res.json({ url: p.url });
}));

// ---------------------------------------------------------------- super-admin: Friendly customer codes
function requireSuper(req) {
  if (!rolesFor(req.user.email).superAdmin) throw fail(403, 'Super-admin only');
  if (config.requireAdmin2fa && !twoFactorPolicy(req.user.email).enabled) throw fail(403, 'Admins must turn on 2-step verification first');
}
billing.get('/super/friendly-codes', wrap(async (req, res) => {
  requireSuper(req);
  res.json(q.all('SELECT f.hint, f.note, f.created_at, f.used_at, o.name AS org FROM friendly_codes f LEFT JOIN orgs o ON o.id = f.used_by_org ORDER BY f.created_at DESC LIMIT 500'));
}));
billing.post('/super/friendly-codes', wrap(async (req, res) => {
  requireSuper(req);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
  const code = `FWS-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  q.run('INSERT INTO friendly_codes(code_hash, hint, note, created_by) VALUES(?, ?, ?, ?)', sha(code.replace(/\s+/g, '')), code.slice(-4), String(req.body.note || '').slice(0, 200), req.user.email);
  audit(req.user.email, null, 'billing.code_created', { note: req.body.note });
  res.json({ code }); // shown once; only a hash is stored
}));
billing.patch('/super/orgs/:id/plan', wrap(async (req, res) => {
  requireSuper(req);
  const plan = req.body.plan === 'friendly' ? 'friendly' : 'standard';
  q.run('UPDATE orgs SET plan = ? WHERE id = ?', plan, Number(req.params.id));
  audit(req.user.email, Number(req.params.id), 'billing.plan_set', { plan });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- canceled subscriptions: pause after the grace period
export function startBillingChecks(suspendOrg) {
  const run = async () => {
    if (!B.enabled) return;
    const due = q.all("SELECT id FROM orgs WHERE billing_status = 'canceled' AND suspended = 0 AND canceled_at < datetime('now', ?)", `-${B.graceDays} days`);
    for (const o of due) {
      // Friendly customers whose mailboxes all fit in the free allowance keep working
      const b = orgBilling(o.id);
      if ((await mailboxCount(o.id)) <= b.free) continue;
      await suspendOrg(o.id).catch((e) => console.warn('suspend failed', e.message));
      audit('billing', o.id, 'billing.suspended_unpaid');
    }
  };
  setInterval(() => run().catch(() => {}), 6 * 3600e3).unref();
}
