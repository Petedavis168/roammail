import { ensureMailboxId } from './mailboxids.js';
// Billing: Friendly Web Services customer codes (first mailbox free) and Stripe subscriptions ($ per user).
// Card details never touch this server: payment happens on Stripe Checkout and the Stripe customer portal.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, rolesFor, audit, twoFactorPolicy } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import { rateLimit } from './shared.js';

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
// Complimentary (fee waiver, item 2): a super-admin can make every mailbox of a business free, forever or until a date.
export const COMP_FOREVER = 32503680000000; // year 3000
export const COMP_GRACE_DAYS = 7;
const compActive = (o) => Number(o.comp_until || 0) > Date.now();
export async function orgBilling(orgId) {
  const o = await q.get('SELECT id, name, owner_email, plan, billing_interval, billing_status, paid_seats, stripe_customer, stripe_subscription, canceled_at, comp_until, comp_note FROM orgs WHERE id = ?', orgId);
  if (!o) return null;
  const comped = compActive(o);
  const free = comped ? 100000 : o.plan === 'friendly' ? B.friendlyFreeMailboxes : B.standardFreeMailboxes;
  return { ...o, free, friendly: o.plan === 'friendly', comped, compForever: Number(o.comp_until || 0) >= COMP_FOREVER, enabled: B.enabled };
}
async function mailboxCount(orgId) {
  let n = 0;
  const shared = new Set((await q.all('SELECT email FROM shared_mailboxes WHERE org_id = ?', orgId)).map((r) => r.email));
  for (const d of await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", orgId)) {
    n += (await mailcow.listMailboxes(d.domain).catch(() => [])).filter((m) => !shared.has(m.email.toLowerCase())).length; // shared mailboxes are free
  }
  return n;
}
export function price(interval) { return interval === 'year' ? B.perUserYearly : B.perUserMonthly; }

/** Does activating this org's domain require payment first? (non-Friendly customers pay at the end of setup) */
export async function needsPaymentToActivate(orgId) {
  if (!B.enabled) return false;
  const b = await orgBilling(orgId);
  return b.free < 1 && b.billing_status !== 'active' && b.billing_status !== 'past_due';
}

/** Before adding a mailbox: is a paid seat available? Returns { ok } or info for the UI. */
export async function seatCheck(orgId) {
  if (!B.enabled) return { ok: true };
  const b = await orgBilling(orgId);
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
  const b = await orgBilling(orgId);
  if (!b.stripe_subscription) throw fail(402, 'No subscription yet', 'checkout_required');
  const { item } = await subscriptionItem(b.stripe_subscription);
  if (!item) throw fail(502, 'Subscription has no items');
  if (seats < 1) seats = 1; // keep the subscription alive; Stripe needs quantity >= 1 (reduce to 0 = cancel in portal)
  await stripe('POST', `subscription_items/${encodeURIComponent(item.id)}`, { quantity: seats, proration_behavior: seats > item.quantity ? 'always_invoice' : 'create_prorations' }, `${orgId}-${seats}-${reason}-${Date.now() / 60000 | 0}`);
  await q.run('UPDATE orgs SET paid_seats = ? WHERE id = ?', seats, orgId);
  await audit('billing', orgId, 'billing.seats', { seats, reason });
}

/** After a user is removed, drop unneeded paid seats (credit is applied by Stripe). */
export async function shrinkSeats(orgId) {
  if (!B.enabled) return;
  const b = await orgBilling(orgId);
  if (!b.stripe_subscription || b.billing_status === 'canceled') return;
  const needed = Math.max(1, (await mailboxCount(orgId)) - b.free);
  if (needed < b.paid_seats) await setSeats(orgId, needed, 'user-removed').catch((e) => console.warn('shrink seats failed', e.message));
}

// ---------------------------------------------------------------- activation after payment
let activateHook = async () => {};
export const onPaid = (fn) => { activateHook = fn; };

async function markPaid(orgId, { subscription, customer, seats, interval, status = 'active' }) {
  await q.run('UPDATE orgs SET stripe_subscription = COALESCE(?, stripe_subscription), stripe_customer = COALESCE(?, stripe_customer), paid_seats = ?, billing_interval = ?, billing_status = ?, canceled_at = NULL WHERE id = ?',
    subscription || null, customer || null, seats, interval, status, orgId);
  await audit('billing', orgId, 'billing.paid', { seats, interval });
  await activateHook(orgId);
}

// ---------------------------------------------------------------- admin guard
async function requireOrgAdmin(req, orgId) {
  const id = Number(orgId);
  if (!await q.get('SELECT 1 FROM orgs WHERE id = ?', id)) throw fail(404, 'Organization not found');
  const r = await rolesFor(req.user.email);
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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'usd') => new Intl.NumberFormat('en-US', { style: 'currency', currency: String(cur || 'usd').toUpperCase() }).format(Number(cents || 0) / 100);
/** Email every admin of a business (billing receipts, failed payments, trial reminders). */
async function tellAdmins(orgId, subject, html) {
  if (!B.emails) return;
  const admins = (await q.all("SELECT email FROM members WHERE org_id = ? AND role = 'admin'", orgId)).map((r) => r.email);
  const owner = (await q.get('SELECT owner_email FROM orgs WHERE id = ?', orgId))?.owner_email;
  const to = [...new Set([...admins, owner].filter(Boolean))];
  if (!to.length) return;
  const { sendSystemMail } = await import('./recovery.js');
  await sendSystemMail(to, subject, `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#242424;max-width:560px">${html}<p style="color:#888;font-size:12px">${esc(config.legal.company)} · Billing questions: ${esc(config.legal.contact || '')}</p></div>`).catch((e) => console.error('APP_ERROR billing email', e.message));
}

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
  if (await q.get('SELECT 1 FROM billing_events WHERE id = ?', event.id)) return res.json({ received: true, duplicate: true });
  // Personal Premium subscriptions (premium.js)
  if (await (await import('./premium.js')).premiumWebhook(event)) {
    await q.run('INSERT INTO billing_events(id, type, org_id) VALUES(?, ?, ?)', event.id, event.type, null);
    return res.json({ received: true });
  }
  const obj = event.data?.object || {};
  const orgId = Number(obj.metadata?.org_id || obj.subscription_details?.metadata?.org_id || 0) || (await q.get('SELECT id FROM orgs WHERE stripe_customer = ?', obj.customer || ''))?.id;
  await q.run('INSERT INTO billing_events(id, type, org_id) VALUES(?, ?, ?)', event.id, event.type, orgId || null);
  if (!orgId) return res.json({ received: true });
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required')) {
        await markPaid(orgId, { subscription: obj.subscription, customer: obj.customer, seats: Number(obj.metadata?.seats || 1), interval: obj.metadata?.interval || 'month' });
      }
      break;
    case 'customer.subscription.updated': {
      const qty = obj.items?.data?.[0]?.quantity; const status = obj.status;
      await q.run('UPDATE orgs SET billing_status = ?, paid_seats = COALESCE(?, paid_seats), billing_interval = COALESCE(?, billing_interval) WHERE id = ?',
        status === 'active' || status === 'trialing' ? 'active' : status === 'past_due' || status === 'unpaid' ? 'past_due' : status === 'canceled' ? 'canceled' : status,
        qty ?? null, obj.items?.data?.[0]?.price?.recurring?.interval || null, orgId);
      break;
    }
    case 'customer.subscription.deleted':
      await q.run("UPDATE orgs SET billing_status = 'canceled', canceled_at = datetime('now') WHERE id = ?", orgId);
      await audit('billing', orgId, 'billing.canceled');
      break;
    case 'invoice.payment_failed':
      await q.run("UPDATE orgs SET billing_status = 'past_due' WHERE id = ?", orgId);
      await tellAdmins(orgId, 'Payment failed: please update your card', `<p>We couldn't take payment of <b>${money(obj.amount_due, obj.currency)}</b> for ${esc(obj.customer_name || 'your business')}'s ${esc(config.appName)} plan.</p>
<p>We'll try again over the next few days. To avoid any interruption, update your card: Admin → Billing → <b>Manage billing</b>${obj.hosted_invoice_url ? `, or <a href="${esc(obj.hosted_invoice_url)}">pay this invoice now</a>` : ''}.</p>
<p>If payment still fails, email accounts stay on for ${B.graceDays} days after the subscription ends, then are paused (nothing is deleted).</p>`);
      break;
    case 'invoice.paid':
      await q.run("UPDATE orgs SET billing_status = 'active' WHERE id = ? AND billing_status = 'past_due'", orgId);
      if (Number(obj.amount_paid) > 0) {
        await tellAdmins(orgId, `Receipt: ${money(obj.amount_paid, obj.currency)} paid`, `<p>Thank you! We received <b>${money(obj.amount_paid, obj.currency)}</b> for your ${esc(config.appName)} plan${obj.number ? ` (invoice ${esc(obj.number)})` : ''}.</p>
${obj.hosted_invoice_url ? `<p><a href="${esc(obj.hosted_invoice_url)}">View invoice and receipt</a>${obj.invoice_pdf ? ` · <a href="${esc(obj.invoice_pdf)}">Download PDF</a>` : ''}</p>` : ''}
<p>Invoices are always available in Admin → Billing → Manage billing.</p>`);
      }
      break;
    case 'customer.subscription.trial_will_end':
      await tellAdmins(orgId, 'Your free trial ends in 3 days', `<p>Your ${esc(config.appName)} trial ends on <b>${esc(new Date(Number(obj.trial_end) * 1000).toDateString())}</b>. Your card will be charged then and everything keeps working.</p>
<p>Changed your mind? Cancel any time before then in Admin → Billing → Manage billing.</p>`);
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
  const id = await requireOrgAdmin(req, req.params.orgId);
  const b = await orgBilling(id);
  const used = await mailboxCount(id);
  res.json({ plan: b.plan, friendly: b.friendly, comp: b.comped ? { until: b.compForever ? null : Number(b.comp_until), forever: b.compForever } : null,
    status: b.billing_status, interval: b.billing_interval, paidSeats: b.paid_seats, free: b.comped ? used : b.free,
    used, billable: Math.max(0, used - b.free), perUser: price(b.billing_interval || 'month'), currency: B.currency, enabled: B.enabled,
    needsPayment: await needsPaymentToActivate(id), canceledAt: b.canceled_at });
}));

// Friendly Web Services customers: apply a code (single use)
billing.post('/billing/:orgId/friendly', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.orgId);
  const code = String(req.body.code || '').trim().toUpperCase().replace(/\s+/g, '');
  const row = code && await q.get('SELECT * FROM friendly_codes WHERE code_hash = ?', sha(code));
  if (!row || row.used_by_org) { await audit(req.user.email, id, 'billing.friendly_code_failed'); throw fail(400, "That code isn't valid. Check it with Friendly Web Services."); }
  await q.run("UPDATE friendly_codes SET used_by_org = ?, used_at = datetime('now') WHERE code_hash = ?", id, row.code_hash);
  await q.run("UPDATE orgs SET plan = 'friendly' WHERE id = ?", id);
  await audit(req.user.email, id, 'billing.friendly', { hint: row.hint });
  res.json({ ok: true, plan: 'friendly' });
}));

// Start Stripe Checkout for N seats (monthly or yearly)
billing.post('/billing/:orgId/checkout', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.orgId);
  if (!B.enabled) throw fail(400, 'Billing is not enabled');
  const interval = req.body.interval === 'year' ? 'year' : 'month';
  const priceId = interval === 'year' ? B.priceYearly : B.priceMonthly;
  if (!priceId) throw fail(503, 'Prices are not configured on this server yet');
  const b = await orgBilling(id);
  if (b.stripe_subscription && b.billing_status !== 'canceled') throw fail(400, 'You already have a subscription. Use Manage billing.');
  const seats = Math.max(1, Math.min(10000, Number(req.body.seats) || Math.max(1, (await mailboxCount(id)) + (Number(req.body.adding) || 0) - b.free)));
  let customer = b.stripe_customer;
  if (!customer) {
    customer = (await stripe('POST', 'customers', { email: req.user.email, name: b.name, metadata: { org_id: id } }, `cust-${id}`)).id;
    await q.run('UPDATE orgs SET stripe_customer = ? WHERE id = ?', customer, id);
  }
  const session = await stripe('POST', 'checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: String(id),
    line_items: { 0: { price: priceId, quantity: seats } },
    // back to the admin's own mailbox URL (roammail.net/{id}/inbox), never the marketing home page
    success_url: `${base(req)}/${await ensureMailboxId(req.user.email)}/inbox?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base(req)}/${await ensureMailboxId(req.user.email)}/inbox?billing=canceled`,
    metadata: { org_id: id, seats, interval }, subscription_data: { metadata: { org_id: id } },
    allow_promotion_codes: 'true',
    // Sales tax / VAT worked out by Stripe Tax (turn it on in the Stripe dashboard first, then STRIPE_TAX=true)
    ...(B.tax ? { automatic_tax: { enabled: 'true' }, billing_address_collection: 'required', customer_update: { address: 'auto', name: 'auto' }, tax_id_collection: { enabled: 'true' } }
      : { billing_address_collection: 'auto' }),
    // Free trial for a business's first subscription (TRIAL_DAYS); the card is collected now and charged when it ends
    ...(B.trialDays && !b.canceled_at ? { subscription_data: { metadata: { org_id: id }, trial_period_days: B.trialDays } } : {}),
  });
  await audit(req.user.email, id, 'billing.checkout', { seats, interval });
  res.json({ url: session.url });
}));

// Return from Checkout: confirm with Stripe directly (in case the webhook is delayed). Never trusts the browser.
billing.post('/billing/confirm', wrap(async (req, res) => {
  const sid = String(req.body.sessionId || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw fail(400, 'Invalid session');
  const s = await stripe('GET', `checkout/sessions/${sid}`);
  const id = await requireOrgAdmin(req, Number(s.metadata?.org_id));
  if (s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required')) {
    if ((await orgBilling(id)).billing_status !== 'active') await markPaid(id, { subscription: s.subscription, customer: s.customer, seats: Number(s.metadata?.seats || 1), interval: s.metadata?.interval || 'month' });
    return res.json({ ok: true, orgId: id });
  }
  res.json({ ok: false, status: s.status });
}));

// Add paid seats to an existing subscription (admin confirmed the charge in the UI)
billing.post('/billing/:orgId/seats', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.orgId);
  const check = await seatCheck(id);
  if (check.ok) return res.json({ ok: true });
  if (!check.hasSubscription) throw fail(402, 'Choose a plan first', 'checkout_required');
  await setSeats(id, check.billable, 'user-added');
  res.json({ ok: true, seats: check.billable });
}));

// Stripe customer portal: cards, invoices, switch monthly/yearly, cancel
billing.post('/billing/:orgId/portal', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.orgId);
  const b = await orgBilling(id);
  if (!b.stripe_customer) throw fail(400, 'No billing account yet');
  const p = await stripe('POST', 'billing_portal/sessions', { customer: b.stripe_customer, return_url: `${base(req)}/${await ensureMailboxId(req.user.email)}/inbox?billing=portal` });
  res.json({ url: p.url });
}));

// ---------------------------------------------------------------- super-admin: Friendly customer codes
async function requireSuper(req) {
  if (!(await rolesFor(req.user.email)).superAdmin) throw fail(403, 'Super-admin only');
  if (config.requireAdmin2fa && !(await twoFactorPolicy(req.user.email)).enabled) throw fail(403, 'Admins must turn on 2-step verification first');
}
billing.get('/super/friendly-codes', wrap(async (req, res) => {
  await requireSuper(req);
  res.json(await q.all('SELECT f.hint, f.note, f.created_at, f.used_at, o.name AS org FROM friendly_codes f LEFT JOIN orgs o ON o.id = f.used_by_org ORDER BY f.created_at DESC LIMIT 500'));
}));
billing.post('/super/friendly-codes', wrap(async (req, res) => {
  await requireSuper(req);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
  const code = `FWS-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  await q.run('INSERT INTO friendly_codes(code_hash, hint, note, created_by) VALUES(?, ?, ?, ?)', sha(code.replace(/\s+/g, '')), code.slice(-4), String(req.body.note || '').slice(0, 200), req.user.email);
  await audit(req.user.email, null, 'billing.code_created', { note: req.body.note });
  res.json({ code }); // shown once; only a hash is stored
}));
billing.patch('/super/orgs/:id/plan', wrap(async (req, res) => {
  await requireSuper(req);
  const plan = req.body.plan === 'friendly' ? 'friendly' : 'standard';
  await q.run('UPDATE orgs SET plan = ? WHERE id = ?', plan, Number(req.params.id));
  await audit(req.user.email, Number(req.params.id), 'billing.plan_set', { plan });
  res.json({ ok: true });
}));

// Super-admin: complimentary account (same provisioning path; billing just treats every mailbox as free)
billing.put('/super/orgs/:id/comp', wrap(async (req, res) => {
  await requireSuper(req);
  const id = Number(req.params.id);
  if (!(await q.get('SELECT 1 FROM orgs WHERE id = ?', id))) throw fail(404, 'Organization not found');
  const mode = String(req.body.mode || '');
  const note = String(req.body.note || '').trim().slice(0, 500);
  let until = null;
  if (mode === 'forever') until = COMP_FOREVER;
  else if (mode === 'until') {
    until = new Date(String(req.body.until || '')).getTime();
    if (!Number.isFinite(until) || until <= Date.now()) throw fail(400, 'Pick a date in the future');
  } else if (mode === 'months') {
    const n = Number(req.body.months);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw fail(400, 'Months must be 1 to 120');
    const d = new Date(); d.setMonth(d.getMonth() + n); until = d.getTime();
  } else if (mode !== 'off') throw fail(400, 'Choose forever, until a date, a number of months, or off');
  if (mode !== 'off' && note.length < 3) throw fail(400, 'Add a short note saying why (kept in the audit log)');
  await q.run('UPDATE orgs SET comp_until = ?, comp_note = ?, comp_by = ?, comp_warned = 0 WHERE id = ?', until, mode === 'off' ? null : note, req.user.email, id);
  await audit(req.user.email, id, mode === 'off' ? 'billing.comp_removed' : 'billing.comp_set', { mode, until, note });
  res.json({ ok: true, comp: until ? { until: until >= COMP_FOREVER ? null : until, forever: until >= COMP_FOREVER, note } : null });
}));

// ---------------------------------------------------------------- canceled subscriptions: pause after the grace period
export function startBillingChecks(suspendOrg) {
  if (!config.runsBackground) return;
  const run = async () => {
    if (!B.enabled) return;
    // Complimentary period ending: warn admins a week before; after it ends, a 7-day grace before unpaid mailboxes pause
    const now = Date.now();
    for (const o of await q.all('SELECT id, comp_until FROM orgs WHERE comp_until IS NOT NULL AND comp_until < ? AND comp_until > ? AND comp_warned = 0', COMP_FOREVER, now)) {
      if (Number(o.comp_until) - now > 7 * 864e5) continue;
      const claim = await q.run('UPDATE orgs SET comp_warned = 1 WHERE id = ? AND comp_warned = 0', o.id);
      if (claim.changes !== 1) continue;
      await tellAdmins(o.id, 'Your complimentary Roammail plan ends soon', `<p>Your complimentary plan ends on <b>${esc(new Date(Number(o.comp_until)).toDateString())}</b>.</p><p>To keep every mailbox working, add a payment method in <b>Admin → Billing</b> before then. After it ends you have ${COMP_GRACE_DAYS} more days before mailboxes over the free allowance are paused. Nothing is deleted.</p>`);
      await audit('billing', o.id, 'billing.comp_warning');
    }
    for (const o of await q.all("SELECT id FROM orgs WHERE comp_until IS NOT NULL AND comp_until < ? AND suspended = 0 AND (billing_status IS NULL OR billing_status NOT IN ('active', 'past_due', 'trialing'))", now - COMP_GRACE_DAYS * 864e5)) {
      const b = await orgBilling(o.id);
      if ((await mailboxCount(o.id)) <= b.free) continue;
      await suspendOrg(o.id).catch((e) => console.warn('suspend failed', e.message));
      await audit('billing', o.id, 'billing.suspended_comp_ended');
    }
    const due = await q.all("SELECT id FROM orgs WHERE billing_status = 'canceled' AND suspended = 0 AND canceled_at < datetime('now', ?)", `-${B.graceDays} days`);
    for (const o of due) {
      // Friendly customers whose mailboxes all fit in the free allowance keep working
      const b = await orgBilling(o.id);
      if ((await mailboxCount(o.id)) <= b.free) continue;
      await suspendOrg(o.id).catch((e) => console.warn('suspend failed', e.message));
      await audit('billing', o.id, 'billing.suspended_unpaid');
    }
  };
  setInterval(() => run().catch(() => {}), 6 * 3600e3).unref();
}
