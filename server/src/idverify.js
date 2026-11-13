// ID verification for free accounts: a US driver's license, checked by Stripe Identity.
// The person scans the front of their license and takes a selfie in Stripe's page (phone camera or webcam). Stripe
// detects the document automatically, reads it, checks it's genuine and matches the face to the photo.
// We keep only the outcome: verified or not, the country and document type, and a keyed fingerprint of the person
// (name + date of birth) so one license can't unlock unlimited accounts. Never the images, the license number or the
// person's details. Verified free accounts have no monthly sending cap (abuse.js, monthlyCap).
// Needs Stripe Identity enabled on the Stripe account (same STRIPE_SECRET_KEY and webhook as billing); the webhook
// must also send identity.verification_session.* events.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, audit } from './db.js';
import { requireAuth } from './session.js';
import { rateLimit } from './shared.js';
import { stripe } from './billing.js';
import { monthlyCap, monthlySent } from './abuse.js';
import { applyRate, rateFor } from './outbound.js';
import { ensureMailboxId } from './mailboxids.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const MAX_ACCOUNTS_PER_PERSON = Number(process.env.ID_MAX_ACCOUNTS_PER_PERSON || 3);
const isFree = (email) => !!config.signup.domain && email.endsWith(`@${config.signup.domain}`);
const personHash = (o) => crypto.createHmac('sha256', config.sealKey).update(`id-person|${String(o.first_name || '').trim().toLowerCase()}|${String(o.last_name || '').trim().toLowerCase()}|${o.dob ? `${o.dob.year}-${o.dob.month}-${o.dob.day}` : ''}`).digest('hex');
const base = (req) => (config.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

async function setStatus(email, fields) {
  const cur = await q.get('SELECT * FROM id_verifications WHERE email = ?', email);
  const v = { status: 'pending', session_id: null, country: null, doc_type: null, person_hash: null, reason: null, verified_at: null, ...(cur || {}), ...fields, updated_at: Date.now() };
  await q.run(`INSERT INTO id_verifications(email, status, session_id, country, doc_type, person_hash, reason, verified_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET status = excluded.status, session_id = excluded.session_id, country = excluded.country, doc_type = excluded.doc_type,
      person_hash = excluded.person_hash, reason = excluded.reason, verified_at = excluded.verified_at, updated_at = excluded.updated_at`,
  email, v.status, v.session_id, v.country, v.doc_type, v.person_hash, v.reason, v.verified_at, v.updated_at);
}

/** Decide from Stripe's finished session (and its report) whether this person counts as verified. */
export async function settleSession(sessionId) {
  const s = await stripe('GET', `identity/verification_sessions/${encodeURIComponent(sessionId)}?expand[]=last_verification_report&expand[]=verified_outputs`);
  const email = String(s.metadata?.email || '').toLowerCase();
  const row = email && await q.get('SELECT * FROM id_verifications WHERE email = ?', email);
  if (!row || row.session_id !== s.id) return null; // not ours, or an older attempt
  if (s.status === 'processing') { await setStatus(email, { status: 'processing' }); return 'processing'; }
  if (s.status === 'canceled') { await setStatus(email, { status: 'canceled', reason: null }); return 'canceled'; }
  if (s.status === 'requires_input') {
    const why = { document_expired: 'That license has expired.', document_type_not_supported: 'Only a driver’s license can be used.', document_unverified_other: 'We couldn’t confirm that license. Try again in good light with the whole card in view.', selfie_face_mismatch: 'The selfie didn’t match the photo on the license.', selfie_unverified_other: 'We couldn’t confirm the selfie. Try again in good light.', consent_declined: 'You didn’t give permission to check your ID.', under_supported_age: 'You must be 18 or older.' };
    await setStatus(email, { status: s.last_error ? 'failed' : 'pending', reason: why[s.last_error?.code] || (s.last_error ? 'We couldn’t verify that. Please try again.' : null) });
    return s.last_error ? 'failed' : 'pending';
  }
  if (s.status !== 'verified') return null;
  const doc = s.last_verification_report?.document || {};
  if (doc.type !== 'driving_license' || doc.issuing_country !== 'US') {
    await setStatus(email, { status: 'failed', reason: 'Only a US driver’s license can be used.', country: doc.issuing_country || null, doc_type: doc.type || null });
    return 'failed';
  }
  const hash = personHash(s.verified_outputs || doc);
  const others = Number((await q.get("SELECT COUNT(*) AS n FROM id_verifications WHERE person_hash = ? AND status = 'verified' AND email <> ?", hash, email)).n);
  if (others >= MAX_ACCOUNTS_PER_PERSON) {
    await setStatus(email, { status: 'failed', reason: `This license already verified ${MAX_ACCOUNTS_PER_PERSON} Roammail accounts.`, person_hash: hash });
    await audit('system', null, 'idverify.too_many', { email });
    return 'failed';
  }
  await setStatus(email, { status: 'verified', reason: null, country: 'US', doc_type: 'driving_license', person_hash: hash, verified_at: Date.now() });
  await audit(email, null, 'idverify.verified', {});
  await applyRate(email, await rateFor(email)).catch(() => {}); // lift the monthly cap in phone/desktop mail apps too
  return 'verified';
}

/** Stripe webhook events for ID checks (called by the billing webhook after it checked the signature). */
export async function idWebhook(event) {
  if (!String(event.type || '').startsWith('identity.verification_session.')) return false;
  await settleSession(event.data?.object?.id).catch((e) => console.error('APP_ERROR id verification', e.message));
  return true;
}

export const idVerifyApi = express.Router();
idVerifyApi.use('/id-verify', requireAuth);
idVerifyApi.get('/id-verify', wrap(async (req, res) => {
  const e = req.user.email;
  let row = await q.get('SELECT status, reason, verified_at, session_id, updated_at FROM id_verifications WHERE email = ?', e);
  // back from Stripe before the webhook arrived: ask Stripe directly
  if (row?.session_id && ['pending', 'processing'].includes(row.status) && Date.now() - Number(row.updated_at) > 3000) {
    await settleSession(row.session_id).catch(() => {});
    row = await q.get('SELECT status, reason, verified_at, session_id FROM id_verifications WHERE email = ?', e);
  }
  const cap = isFree(e) ? config.limits.freePerMonth || null : null;
  res.json({
    available: isFree(e) && !!config.billing.stripeKey,
    status: row?.status || 'none', reason: row?.reason || null, verifiedAt: row?.verified_at ? Number(row.verified_at) : null,
    sentThisMonth: await monthlySent(e), cap, capApplies: (await monthlyCap(e)) !== null,
  });
}));
idVerifyApi.post('/id-verify/start', rateLimit({ windowMs: 864e5, limit: 5 }), wrap(async (req, res) => {
  const e = req.user.email;
  if (req.delegatedMailbox) throw fail(403, 'Verify from your own account');
  if (!isFree(e)) throw fail(400, 'Business accounts don’t need ID verification');
  const cur = await q.get('SELECT status FROM id_verifications WHERE email = ?', e);
  if (cur?.status === 'verified') return res.json({ ok: true, verified: true });
  const s = await stripe('POST', 'identity/verification_sessions', {
    type: 'document',
    options: { document: { allowed_types: ['driving_license'], require_live_capture: true, require_matching_selfie: true } },
    metadata: { email: e },
    return_url: `${base(req)}/${await ensureMailboxId(e)}/inbox?idv=done`,
  }, `idv-${e}-${Math.floor(Date.now() / 60000)}`);
  await setStatus(e, { status: 'pending', session_id: s.id, reason: null });
  await audit(e, null, 'idverify.started', {});
  res.json({ ok: true, url: s.url });
}));
