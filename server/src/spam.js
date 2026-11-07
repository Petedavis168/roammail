// Junk & spam, the way mailcow does it:
//   score < low            -> Inbox
//   low <= score < high    -> delivered with X-Spam-Flag, filed into "Junk" by mailcow's sieve   (Junk Email folder)
//   score >= high          -> rejected at the door; held in mailcow's quarantine if enabled      (Spam quarantine)
// Moving mail into / out of Junk trains rspamd (mailcow's IMAPSieve learning).
import express from 'express';
import { simpleParser } from 'mailparser';
import { q, rolesFor, userSetting, setUserSetting, audit } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });

export const PRESETS = {
  relaxed: { label: 'Relaxed', score: '10,25', help: 'Only obvious spam goes to Junk. Choose this if real mail ends up in Junk.' },
  standard: { label: 'Standard', score: 'default', help: 'Your server\'s recommended balance.' },
  strict: { label: 'Strict', score: '4,12', help: 'Catches more spam, but check Junk now and then for real mail.' },
};
const SENDER_RE = /^(\*@)?[a-z0-9._%+-]*@?[a-z0-9.-]+\.[a-z]{2,}$/;
function cleanSender(v) {
  let s = String(v || '').trim().toLowerCase();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) s = `*@${s}`; // "example.com" -> whole domain
  if (!SENDER_RE.test(s) || !s.includes('@')) throw fail(400, 'Enter an email address (name@example.com) or a domain (example.com)');
  return s;
}
const splitPolicy = (rows, email) => rows.map((r) => ({ id: Number(r.prefid), value: r.value, byAdmin: String(r.object).toLowerCase() !== email }));

// Spam reasons from rspamd's X-Spamd-Result header, translated for humans
const REASONS = [
  [/^BAYES_SPAM/, 'Looks like messages you and others reported as junk'],
  [/^(RBL_|RECEIVED_SPAMHAUS|RCVD_IN_|SPAMHAUS)/, 'Sent from a server on a spam blocklist'],
  [/^(URIBL|DBL|SURBL|URIBL_)/, 'Contains links to known spam or scam websites'],
  [/^(PHISHING|PHISHED)/, 'Looks like a phishing attempt'],
  [/^(DMARC_POLICY_REJECT|DMARC_POLICY_QUARANTINE)/, "Failed the sender domain's authenticity check (DMARC)"],
  [/^R_SPF_FAIL/, "Not sent from a server the sender's domain allows (SPF)"],
  [/^R_DKIM_REJECT/, 'Signature check failed (DKIM)'],
  [/^(FUZZY_DENIED|FUZZY_)/, 'Matches known bulk spam'],
  [/^(SUBJ_ALL_CAPS|SUBJECT_HAS_EXCLAIM|UPPERCASE)/, 'Shouting subject line'],
  [/^(FORGED_|FAKE_|SPOOF)/, 'The sender looks forged'],
  [/^(MIME_BAD|MIME_HTML_ONLY|HTML_SHORT_LINK_IMG|R_PARTS_DIFFER)/, 'Unusual message structure often used by spammers'],
  [/^(FREEMAIL_REPLYTO|REPLYTO_DOM_NEQ)/, 'Replies would go to a different address than the sender'],
  [/^(SUSPICIOUS_RECIPS|HFILTER_|ONCE_RECEIVED)/, 'Suspicious sending pattern'],
  [/^(MV_CASE|NEURAL_SPAM)/, 'Looks like spam to the content filter'],
];
export function spamInfo(headerValue) {
  const raw = [].concat(headerValue || []).map(String).join(' ');
  const m = /\[\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*\]/.exec(raw);
  if (!m) return null;
  const symbols = [...raw.matchAll(/([A-Z0-9_]+)\((-?[\d.]+)\)/g)].map((x) => ({ name: x[1], score: Number(x[2]) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const reasons = [];
  for (const s of symbols) {
    const hit = REASONS.find(([re]) => re.test(s.name));
    if (hit && !reasons.includes(hit[1])) reasons.push(hit[1]);
    if (reasons.length >= 4) break;
  }
  return { score: Number(m[1]), threshold: Number(m[2]), reasons };
}

function canSeeQuarantineItem(user, item) {
  if (item.rcpt === user.email) return true;
  const r = rolesFor(user.email);
  if (r.superAdmin) return true;
  const org = q.get("SELECT org_id FROM domains WHERE domain = ? AND status = 'active'", item.rcpt.split('@')[1]);
  return !!org && r.orgs.some((o) => o.id === org.org_id && o.role === 'admin');
}
function adminDomain(req, domain) {
  const d = q.get("SELECT d.domain, d.org_id FROM domains d WHERE d.domain = ? AND d.status = 'active'", String(domain || '').toLowerCase());
  if (!d) throw fail(404, 'Domain not found');
  const r = rolesFor(req.user.email);
  if (!r.superAdmin && !r.orgs.some((o) => o.id === d.org_id && o.role === 'admin')) throw fail(403, 'You are not an admin of this domain');
  return d;
}

export const spam = express.Router();
spam.use(requireAuth);

// ---------------------------------------------------------------- user settings
spam.get('/spam', wrap(async (req, res) => {
  const e = req.user.email;
  const [score, policy, quarantine] = await Promise.all([
    mailcow.getSpamScore(e).catch(() => null),
    mailcow.getMailboxPolicy(e).catch(() => ({ wl: [], bl: [] })),
    mailcow.listQuarantine().catch(() => []),
  ]);
  res.json({
    preset: userSetting(e, 'spamPreset', 'standard'), presets: PRESETS, score,
    safe: splitPolicy(policy.wl, e), blocked: splitPolicy(policy.bl, e),
    notifications: userSetting(e, 'quarantineNotify', 'daily'),
    quarantineCount: quarantine.filter((x) => x.rcpt === e).length,
  });
}));

spam.put('/spam/sensitivity', wrap(async (req, res) => {
  let value; let preset = req.body.preset;
  if (PRESETS[preset]) value = PRESETS[preset].score;
  else {
    const low = Number(req.body.low); const high = Number(req.body.high);
    if (!(low >= 1 && low <= 50 && high > low && high <= 100)) throw fail(400, 'Junk level must be between 1 and 50, and the block level higher than it');
    value = `${low},${high}`; preset = 'custom';
  }
  await mailcow.setSpamScore(req.user.email, value);
  setUserSetting(req.user.email, 'spamPreset', preset);
  audit(req.user.email, null, 'spam.sensitivity', { preset, value });
  res.json({ ok: true, preset, score: await mailcow.getSpamScore(req.user.email).catch(() => null) });
}));

spam.post('/spam/senders', wrap(async (req, res) => {
  const kind = req.body.list === 'blocked' ? 'bl' : 'wl';
  const value = cleanSender(req.body.value);
  if (value.endsWith(`@${req.user.email.split('@')[1]}`) && kind === 'bl' && value.startsWith('*@')) throw fail(400, "You can't block your own domain");
  const pol = await mailcow.getMailboxPolicy(req.user.email);
  const other = kind === 'bl' ? pol.wl : pol.bl;
  // Moving a sender from one list to the other
  const clash = other.find((r) => r.value === value && String(r.object).toLowerCase() === req.user.email);
  if (clash) await mailcow.deleteMailboxPolicy(clash.prefid);
  if (!(kind === 'bl' ? pol.bl : pol.wl).some((r) => r.value === value)) await mailcow.addMailboxPolicy(req.user.email, kind, value);
  audit(req.user.email, null, kind === 'bl' ? 'spam.block' : 'spam.trust', { value });
  res.json({ ok: true, value });
}));

spam.delete('/spam/senders', wrap(async (req, res) => {
  const pol = await mailcow.getMailboxPolicy(req.user.email);
  const row = [...pol.wl, ...pol.bl].find((r) => String(r.prefid) === String(req.query.id));
  if (!row) throw fail(404, 'Not found');
  if (String(row.object).toLowerCase() !== req.user.email) throw fail(403, 'This entry was set by your administrator');
  await mailcow.deleteMailboxPolicy(row.prefid);
  res.json({ ok: true });
}));

spam.put('/spam/notifications', wrap(async (req, res) => {
  const f = ['hourly', 'daily', 'weekly', 'never'].includes(req.body.frequency) ? req.body.frequency : 'daily';
  await mailcow.setQuarantineNotification(req.user.email, f);
  await mailcow.setQuarantineCategory(req.user.email, 'reject').catch(() => {});
  setUserSetting(req.user.email, 'quarantineNotify', f);
  res.json({ ok: true, frequency: f });
}));

// Block sender from the reading pane: mailcow blocklist (works in every app)
spam.post('/block', wrap(async (req, res) => {
  const value = cleanSender(req.body.address);
  const pol = await mailcow.getMailboxPolicy(req.user.email);
  const trusted = pol.wl.find((r) => r.value === value && String(r.object).toLowerCase() === req.user.email);
  if (trusted) await mailcow.deleteMailboxPolicy(trusted.prefid);
  if (!pol.bl.some((r) => r.value === value)) await mailcow.addMailboxPolicy(req.user.email, 'bl', value);
  audit(req.user.email, null, 'spam.block', { value });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- quarantine
spam.get('/quarantine', wrap(async (req, res) => {
  const all = await mailcow.listQuarantine();
  const scope = req.query.domain ? adminDomain(req, req.query.domain).domain : null;
  const items = all.filter((x) => (scope ? x.rcpt.endsWith(`@${scope}`) : x.rcpt === req.user.email)).sort((a, b) => b.created - a.created);
  res.json(items);
}));

spam.get('/quarantine/:id', wrap(async (req, res) => {
  const item = (await mailcow.listQuarantine()).find((x) => String(x.id) === String(req.params.id));
  if (!item || !canSeeQuarantineItem(req.user, item)) throw fail(404, 'Not found');
  const d = await mailcow.quarantineItem(item.id);
  const raw = d?.msg || '';
  let parsed = {};
  try { parsed = raw ? await simpleParser(raw) : {}; } catch { /* unparsable */ }
  const symbols = d?.symbols ? (typeof d.symbols === 'string' ? (() => { try { return JSON.parse(d.symbols); } catch { return []; } })() : d.symbols) : [];
  const reasons = [];
  for (const sym of [].concat(symbols).sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const hit = REASONS.find(([re]) => re.test(sym.name || ''));
    if (hit && !reasons.includes(hit[1])) reasons.push(hit[1]);
    if (reasons.length >= 4) break;
  }
  res.json({
    ...item, reasons,
    from: parsed.from?.value?.[0] || { address: item.sender },
    // Text only: quarantined mail is likely malicious, so no HTML, images or links are rendered
    text: (parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '') || '').slice(0, 20000),
    attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || 'attachment', size: a.size, contentType: a.contentType })),
  });
}));

spam.post('/quarantine/release', wrap(async (req, res) => {
  const all = await mailcow.listQuarantine();
  const items = [].concat(req.body.ids || []).map((id) => all.find((x) => String(x.id) === String(id))).filter((x) => x && canSeeQuarantineItem(req.user, x));
  if (!items.length) throw fail(404, 'Nothing to release');
  if (items.some((x) => x.virus) && !req.body.confirmVirus) throw fail(400, 'One of these messages contains a virus. Confirm to release it anyway.');
  if (req.body.notSpam) await mailcow.quarantineAction(items.map((x) => x.id), 'learnham').catch(() => {});
  await mailcow.quarantineAction(items.map((x) => x.id), 'release');
  if (req.body.trustSender) {
    for (const x of items.filter((i) => i.rcpt === req.user.email && i.sender)) {
      await mailcow.addMailboxPolicy(req.user.email, 'wl', x.sender.toLowerCase()).catch(() => {});
    }
  }
  audit(req.user.email, null, 'quarantine.release', { count: items.length, notSpam: !!req.body.notSpam });
  res.json({ ok: true, released: items.length });
}));

spam.post('/quarantine/delete', wrap(async (req, res) => {
  const all = await mailcow.listQuarantine();
  const items = [].concat(req.body.ids || []).map((id) => all.find((x) => String(x.id) === String(id))).filter((x) => x && canSeeQuarantineItem(req.user, x));
  if (!items.length) throw fail(404, 'Nothing to delete');
  await mailcow.deleteQuarantine(items.map((x) => x.id));
  res.json({ ok: true, deleted: items.length });
}));

// ---------------------------------------------------------------- business admin: domain-wide spam policy
spam.get('/admin/spam', wrap(async (req, res) => {
  const d = adminDomain(req, req.query.domain);
  const pol = await mailcow.getDomainPolicy(d.domain);
  res.json({
    safe: pol.wl.map((r) => ({ id: Number(r.prefid), value: r.value })), blocked: pol.bl.map((r) => ({ id: Number(r.prefid), value: r.value })),
    preset: q.get("SELECT value FROM settings WHERE key = ?", `spamPreset:${d.domain}`) ? JSON.parse(q.get("SELECT value FROM settings WHERE key = ?", `spamPreset:${d.domain}`).value) : 'standard',
    presets: PRESETS,
  });
}));

spam.post('/admin/spam/senders', wrap(async (req, res) => {
  const d = adminDomain(req, req.body.domain);
  const value = cleanSender(req.body.value);
  await mailcow.addDomainPolicy(d.domain, req.body.list === 'blocked' ? 'bl' : 'wl', value);
  audit(req.user.email, d.org_id, req.body.list === 'blocked' ? 'spam.domain_block' : 'spam.domain_trust', { domain: d.domain, value });
  res.json({ ok: true });
}));

spam.delete('/admin/spam/senders', wrap(async (req, res) => {
  const d = adminDomain(req, req.query.domain);
  const pol = await mailcow.getDomainPolicy(d.domain);
  const row = [...pol.wl, ...pol.bl].find((r) => String(r.prefid) === String(req.query.id) && String(r.object).toLowerCase() === d.domain);
  if (!row) throw fail(404, 'Not found');
  await mailcow.deleteDomainPolicy(row.prefid);
  res.json({ ok: true });
}));

// Apply a sensitivity + digest setting to every user on the domain (new users get it too)
spam.post('/admin/spam/apply', wrap(async (req, res) => {
  const d = adminDomain(req, req.body.domain);
  const preset = PRESETS[req.body.preset] ? req.body.preset : 'standard';
  const users = (await mailcow.listMailboxes(d.domain)).map((m) => m.email);
  if (users.length) {
    await mailcow.setSpamScore(users, PRESETS[preset].score);
    if (req.body.notifications) await mailcow.setQuarantineNotification(users, req.body.notifications).catch(() => {});
  }
  for (const u of users) setUserSetting(u, 'spamPreset', preset);
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `spamPreset:${d.domain}`, JSON.stringify(preset));
  if (req.body.notifications) q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `quarantineNotify:${d.domain}`, JSON.stringify(req.body.notifications));
  audit(req.user.email, d.org_id, 'spam.apply_all', { domain: d.domain, preset, users: users.length });
  res.json({ ok: true, users: users.length });
}));

/** New mailboxes inherit the domain's spam settings. */
export async function applyDomainSpamDefaults(email) {
  const domain = email.split('@')[1];
  const get = (k) => { const r = q.get('SELECT value FROM settings WHERE key = ?', `${k}:${domain}`); return r ? JSON.parse(r.value) : null; };
  const preset = get('spamPreset'); const notify = get('quarantineNotify');
  if (preset && preset !== 'standard') { await mailcow.setSpamScore(email, PRESETS[preset].score).catch(() => {}); setUserSetting(email, 'spamPreset', preset); }
  if (notify) await mailcow.setQuarantineNotification(email, notify).catch(() => {});
}
