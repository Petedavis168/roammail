// Personal Premium: $5 a month (or $50 a year) for a personal account: 100 GB of mail, unlimited AI help and the
// person's own domain (you@yourname.com). Paid through Stripe like business plans; hidden until the two Stripe
// prices are configured (STRIPE_PRICE_PREMIUM_MONTHLY / _YEARLY). Not offered in the iPhone app (App Store rules).
import express from 'express';
import { config } from './config.js';
import { q, audit } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import { rateLimit } from './shared.js';
import { stripe, COMP_FOREVER } from './billing.js'; // COMP_FOREVER: the personal domain is free while Premium lasts
import { ensureMailboxId } from './mailboxids.js';
import { checkNewDomain, createOrgWithDomain } from './accounts.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const B = config.billing;
const GRACE_MS = 3 * 864e5; // a late renewal webhook doesn't switch anything off
export const premiumEnabled = () => !!(B.enabled && B.premiumMonthly && B.premiumYearly);
const base = (req) => config.publicUrl || (process.env.NODE_ENV === 'production' ? '' : `${req.protocol}://${req.get('host')}`);
const isPersonal = (email) => email.split('@')[1] === config.signup.domain; // Premium is for free (@roammail.net) accounts

export async function premiumState(email) {
  const p = await q.get('SELECT * FROM premium WHERE email = ?', email);
  const active = !!p && (p.status === 'active' || p.status === 'trialing' || p.status === 'past_due') && Number(p.until || 0) + GRACE_MS > Date.now();
  return { active, status: p?.status || 'none', interval: p?.billing_interval || null, until: p?.until || null, domainOrg: p?.domain_org || null, row: p };
}

/** Turn Premium on or off for a person (from Stripe events). */
async function apply(email, { status, subscription, customer, interval, until }) {
  const prev = await premiumState(email);
  await q.run(`INSERT INTO premium(email, customer, subscription, status, billing_interval, until, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET customer = COALESCE(excluded.customer, premium.customer), subscription = COALESCE(excluded.subscription, premium.subscription),
    status = excluded.status, billing_interval = COALESCE(excluded.billing_interval, premium.billing_interval), until = COALESCE(excluded.until, premium.until), updated_at = excluded.updated_at`,
  email, customer || null, subscription || null, status, interval || null, until || null, Date.now());
  const now = await premiumState(email);
  await q.run('INSERT INTO user_security(email) VALUES(?) ON CONFLICT(email) DO NOTHING', email);
  await q.run('UPDATE user_security SET premium_until = ? WHERE email = ?', now.active ? Number(now.until || Date.now() + 31 * 864e5) + GRACE_MS : null, email); // AI help reads this
  if (now.active && !prev.active) {
    await mailcow.editMailbox(email, { quota: B.premiumQuotaMb }).catch((e) => console.error('APP_ERROR premium quota', e.message));
    if (now.domainOrg) await q.run('UPDATE orgs SET comp_until = ? WHERE id = ?', COMP_FOREVER, now.domainOrg);
    await audit(email, null, 'premium.started', { interval: now.interval });
  }
  if (!now.active && prev.active) {
    await mailcow.editMailbox(email, { quota: config.signup.quotaMb }).catch((e) => console.error('APP_ERROR premium quota', e.message));
    if (now.domainOrg) await q.run('UPDATE orgs SET comp_until = ? WHERE id = ?', Date.now() + 30 * 864e5, now.domainOrg); // 30 days to move or subscribe
    await audit(email, null, 'premium.ended');
  }
}

/** Stripe webhook events for Premium subscriptions (called from billing.js). Returns true if handled. */
export async function premiumWebhook(event) {
  const obj = event.data?.object || {};
  let email = obj.metadata?.premium_email || obj.subscription_details?.metadata?.premium_email || obj.parent?.subscription_details?.metadata?.premium_email;
  if (!email && (obj.customer || obj.subscription || obj.id)) {
    email = (await q.get('SELECT email FROM premium WHERE customer = ? OR subscription = ? OR subscription = ?', obj.customer || '-', obj.subscription || '-', obj.id || '-'))?.email;
  }
  if (!email) return false;
  email = String(email).toLowerCase();
  const end = (s) => (s?.current_period_end || s?.items?.data?.[0]?.current_period_end ? Number(s.current_period_end || s.items.data[0].current_period_end) * 1000 : null);
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && (obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required')) {
        await apply(email, { status: 'active', subscription: obj.subscription, customer: obj.customer, interval: obj.metadata?.interval, until: Date.now() + (obj.metadata?.interval === 'year' ? 366 : 31) * 864e5 });
      }
      break;
    case 'customer.subscription.updated':
      await apply(email, { status: obj.status, subscription: obj.id, interval: obj.items?.data?.[0]?.price?.recurring?.interval, until: end(obj) });
      break;
    case 'customer.subscription.deleted':
      await apply(email, { status: 'canceled', subscription: obj.id, until: Date.now() - GRACE_MS });
      break;
    case 'invoice.payment_failed':
      await apply(email, { status: 'past_due' });
      break;
    default: break;
  }
  return true;
}

// ---------------------------------------------------------------- routes
export const premiumApi = express.Router();
premiumApi.use('/premium', requireAuth);

premiumApi.get('/premium', wrap(async (req, res) => {
  const s = await premiumState(req.user.email);
  const domain = s.domainOrg ? (await q.get('SELECT domain, status FROM domains WHERE org_id = ?', s.domainOrg)) : null;
  res.json({ available: premiumEnabled() && isPersonal(req.user.email), active: s.active, status: s.status, interval: s.interval, until: s.until,
    perMonth: B.premiumPerMonth, perYear: B.premiumPerYear, currency: B.currency, quotaGb: Math.round(B.premiumQuotaMb / 1024), domain });
}));

premiumApi.post('/premium/checkout', rateLimit({ windowMs: 3600e3, limit: 10 }), wrap(async (req, res) => {
  if (!premiumEnabled() || !isPersonal(req.user.email)) throw fail(400, 'Premium isn’t available for this account');
  const s = await premiumState(req.user.email);
  if (s.active) throw fail(400, 'You already have Premium. Use Manage subscription.');
  const interval = req.body.interval === 'year' ? 'year' : 'month';
  let customer = s.row?.customer;
  if (!customer) {
    customer = (await stripe('POST', 'customers', { email: req.user.email, name: req.user.name || req.user.email, metadata: { premium_email: req.user.email } }, `premium-cust-${req.user.email}`)).id;
    await q.run('INSERT INTO premium(email, customer, updated_at) VALUES(?, ?, ?) ON CONFLICT(email) DO UPDATE SET customer = excluded.customer', req.user.email, customer, Date.now());
  }
  const id = await ensureMailboxId(req.user.email);
  const session = await stripe('POST', 'checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: req.user.email,
    line_items: { 0: { price: interval === 'year' ? B.premiumYearly : B.premiumMonthly, quantity: 1 } },
    success_url: `${base(req)}/${id}/settings?premium=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base(req)}/${id}/settings?premium=canceled`,
    metadata: { premium_email: req.user.email, interval }, subscription_data: { metadata: { premium_email: req.user.email } },
    allow_promotion_codes: 'true',
    ...(B.tax ? { automatic_tax: { enabled: 'true' }, billing_address_collection: 'required', customer_update: { address: 'auto', name: 'auto' } } : { billing_address_collection: 'auto' }),
  });
  await audit(req.user.email, null, 'premium.checkout', { interval });
  res.json({ url: session.url });
}));

// Back from Stripe: confirm with Stripe directly in case the webhook is late (never trusts the browser)
premiumApi.post('/premium/confirm', wrap(async (req, res) => {
  const sid = String(req.body.sessionId || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw fail(400, 'Invalid session');
  const s = await stripe('GET', `checkout/sessions/${sid}`);
  if (String(s.metadata?.premium_email || '').toLowerCase() !== req.user.email) throw fail(403, 'This payment belongs to another account');
  if (s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') && !(await premiumState(req.user.email)).active) {
    await apply(req.user.email, { status: 'active', subscription: s.subscription, customer: s.customer, interval: s.metadata?.interval, until: Date.now() + (s.metadata?.interval === 'year' ? 366 : 31) * 864e5 });
  }
  res.json({ active: (await premiumState(req.user.email)).active });
}));

premiumApi.post('/premium/portal', wrap(async (req, res) => {
  const s = await premiumState(req.user.email);
  if (!s.row?.customer) throw fail(400, 'No subscription yet');
  const p = await stripe('POST', 'billing_portal/sessions', { customer: s.row.customer, return_url: `${base(req)}/${await ensureMailboxId(req.user.email)}/settings?premium=portal` });
  res.json({ url: p.url });
}));

// Your own domain: a one-person "business" that's free while Premium lasts; set up with the usual domain checklist
premiumApi.post('/premium/domain', rateLimit({ windowMs: 3600e3, limit: 10 }), wrap(async (req, res) => {
  const s = await premiumState(req.user.email);
  if (!s.active) throw fail(402, 'Your own domain comes with Premium');
  if (s.domainOrg) throw fail(400, 'You already added a domain. Remove it first to use a different one.');
  const domain = await checkNewDomain(req.body.domain);
  const local = String(req.body.local || req.user.email.split('@')[0]).trim().toLowerCase().slice(0, 64);
  const { orgId } = await createOrgWithDomain(req.user.email, domain, req.user.name || domain, local);
  await q.run('UPDATE orgs SET max_mailboxes = 1, comp_until = ?, comp_note = ? WHERE id = ?', COMP_FOREVER, 'Premium personal domain', orgId);
  await q.run('UPDATE premium SET domain_org = ? WHERE email = ?', orgId, req.user.email);
  await audit(req.user.email, orgId, 'premium.domain', { domain });
  res.json({ ok: true, domain, orgId });
}));
