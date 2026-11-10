// Delivery and read receipts.
//
// Asking for them (when sending):
//  - delivery receipt: the standard SMTP "DSN" request; the receiving mail server reports back when it delivered it
//  - read receipt: the standard "Disposition-Notification-To" header; the reader's mail app asks them to send one
// Neither can be forced (people and mail servers can decline), so we say "requested" until a receipt arrives.
//
// Receipts that come back are matched to the email they belong to, shown on that email in Sent ("Delivered",
// "Read") and moved out of the inbox into a "Receipts" folder.
//
// Answering them (when someone asks you): the app asks, always sends, or never sends, depending on your setting.
// We send at most one per email (the standard $MDNSent flag records it).
import express from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { q } from './db.js';
import { requireAuth } from './session.js';
import { withMailbox, userTransport, getClient } from './imap.js';
import { checkSendQuota } from './abuse.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>".]{1,63}(?:\.[^\s@<>".]{1,63}){1,8}$/; // no backtracking blow-up on long input
const RECEIPTS_FOLDER = 'Receipts';
const lastScan = new Map(); // email -> time
const bare = (id) => String(id || '').trim().replace(/^<|>$/g, '');

/** Called by /api/send: add the requests to the email and remember it. Returns the mail with headers/DSN set. */
export function requestReceipts(user, mail, { read, delivery }) {
  if (!read && !delivery) return { mail, track: null };
  const domain = user.email.split('@')[1];
  const messageId = mail.messageId || `<${crypto.randomUUID()}@${domain}>`;
  const envid = crypto.randomBytes(9).toString('hex');
  const next = { ...mail, messageId };
  if (read) next.headers = { ...(mail.headers || {}), 'Disposition-Notification-To': user.email };
  if (delivery) next.dsn = { id: envid, return: 'headers', notify: ['success', 'failure', 'delay'], recipient: user.email };
  return { mail: next, track: { messageId: bare(messageId), envid, read: !!read, delivery: !!delivery } };
}
export async function saveTracked(user, mail, track, recipients) {
  if (!track) return;
  await q.run(`INSERT INTO receipts(owner, message_id, envid, subject, recipients, read_requested, delivery_requested, sent_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner, message_id) DO NOTHING`, user.email, track.messageId, track.envid, String(mail.subject || '').slice(0, 300),
  JSON.stringify(recipients.slice(0, 100)), track.read ? 1 : 0, track.delivery ? 1 : 0, Date.now());
}

// ---------------------------------------------------------------- reading receipts that came back
function parseReport(parsed, raw) {
  const text = raw.toString('utf8');
  const field = (name, src = text) => (new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(src) || [])[1]?.trim() || '';
  const out = [];
  if (/report-type="?disposition-notification/i.test(text)) {
    const disp = field('Disposition').toLowerCase();
    const who = field('Final-Recipient').replace(/^rfc822;\s*/i, '').toLowerCase();
    out.push({ kind: /displayed/.test(disp) ? 'read' : /deleted/.test(disp) ? 'deleted' : 'other', messageId: bare(field('Original-Message-ID')), recipient: who });
  } else if (/report-type="?delivery-status/i.test(text)) {
    const envid = field('Original-Envelope-Id');
    const msgId = bare((/^Message-ID:\s*(.+)$/im.exec(text.split(/report-type="?delivery-status/i)[1] || '') || [])[1]);
    // one block per recipient: Final-Recipient + Action
    for (const block of text.split(/\r?\n\r?\n/)) {
      const fr = field('Final-Recipient', block); const action = field('Action', block).toLowerCase();
      if (!fr || !action) continue;
      const kind = action.startsWith('delivered') || action.startsWith('relayed') || action.startsWith('expanded') ? 'delivered' : action.startsWith('failed') ? 'failed' : action.startsWith('delayed') ? 'delayed' : null;
      if (kind) out.push({ kind, envid, messageId: msgId, recipient: fr.replace(/^rfc822;\s*/i, '').toLowerCase() });
    }
  }
  return out;
}

/** Look for receipts in the inbox, record them, and move them to the Receipts folder. At most every few seconds. */
export async function collectReceipts(user, { force = false } = {}) {
  const prev = lastScan.get(user.email) || 0;
  if (!force && Date.now() - prev < 3000) return; // the inbox search is cheap; just not on every keystroke
  lastScan.set(user.email, Date.now());
  const found = [];
  await withMailbox(user, 'INBOX', async (client) => {
    const uids = ((await client.search({ header: { 'content-type': 'multipart/report' } }, { uid: true })) || []).slice(-200);
    for (const uid of uids) {
      const m = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      if (!m?.source) continue;
      let parsed = null;
      try { parsed = await simpleParser(m.source); } catch { /* raw text is enough */ }
      found.push({ uid, reports: parseReport(parsed, m.source) });
    }
  });
  if (!found.length) return;
  const moveUids = [];
  for (const f of found) {
    let matched = false;
    for (const r of f.reports) {
      const row = r.envid ? await q.get('SELECT id FROM receipts WHERE owner = ? AND envid = ?', user.email, r.envid) : null;
      const row2 = row || (r.messageId ? await q.get('SELECT id FROM receipts WHERE owner = ? AND message_id = ?', user.email, r.messageId) : null);
      if (!row2) continue;
      matched = true;
      await q.run(`INSERT INTO receipt_events(receipt_id, recipient, kind, at) VALUES(?, ?, ?, ?) ON CONFLICT(receipt_id, recipient, kind) DO NOTHING`, row2.id, r.recipient || '', r.kind, Date.now());
    }
    if (matched) moveUids.push(f.uid);
  }
  if (moveUids.length) {
    await (await getClient(user)).mailboxCreate(RECEIPTS_FOLDER).catch(() => {}); // already there is fine
    await withMailbox(user, 'INBOX', (c) => c.messageMove(moveUids.join(','), RECEIPTS_FOLDER, { uid: true })).catch(() => {});
  }
}

// ---------------------------------------------------------------- API
export const receiptsApi = express.Router();
receiptsApi.use('/receipts', requireAuth);

const statusOf = async (row) => {
  const evs = await q.all('SELECT recipient, kind, at FROM receipt_events WHERE receipt_id = ? ORDER BY at', row.id);
  const people = JSON.parse(row.recipients || '[]');
  return {
    messageId: row.message_id, readRequested: !!row.read_requested, deliveryRequested: !!row.delivery_requested, sentAt: Number(row.sent_at),
    recipients: people.map((p) => {
      const mine = evs.filter((e) => e.recipient === p || (people.length === 1 && !e.recipient));
      const at = (k) => Number(mine.find((e) => e.kind === k)?.at || 0) || null;
      return { address: p, delivered: at('delivered'), read: at('read'), failed: at('failed'), delayed: at('delayed') };
    }),
  };
};

// Status of one sent email (by its Message-ID), or of the most recent ones (for ticks in the Sent list)
receiptsApi.get('/receipts', wrap(async (req, res) => {
  await collectReceipts(req.user).catch((e) => console.warn('receipts scan failed', e.message));
  if (req.query.messageId) {
    const row = await q.get('SELECT * FROM receipts WHERE owner = ? AND message_id = ?', req.user.email, bare(req.query.messageId));
    return res.json(row ? await statusOf(row) : null);
  }
  const rows = await q.all('SELECT * FROM receipts WHERE owner = ? ORDER BY sent_at DESC LIMIT 100', req.user.email);
  res.json(await Promise.all(rows.map(statusOf)));
}));

// Send a read receipt for a message someone asked about
receiptsApi.post('/receipts/send', wrap(async (req, res) => {
  if (req.delegatedMailbox) throw fail(403, 'Read receipts are sent from your own mailbox');
  const folder = String(req.body.folder || 'INBOX'); const uid = String(req.body.uid || '');
  const result = await withMailbox(req.user, folder, async (client) => {
    const m = await client.fetchOne(uid, { source: true, flags: true, envelope: true, uid: true }, { uid: true });
    if (!m) throw fail(404, 'Message not found');
    if (m.flags?.has('$MDNSent')) return { already: true };
    const parsed = await simpleParser(m.source);
    const to = String(parsed.headers.get('disposition-notification-to')?.value?.[0]?.address || (/<?([^\s<>]+@[^\s<>]+)>?/.exec(String(parsed.headers.get('disposition-notification-to')?.text || parsed.headers.get('disposition-notification-to') || '')) || [])[1] || '').toLowerCase();
    if (!EMAIL_RE.test(to)) throw fail(400, 'This email didn’t ask for a read receipt');
    if (req.body.decline !== true) {
      await checkSendQuota(req.user.email, 1);
      const boundary = `rm-${crypto.randomBytes(8).toString('hex')}`;
      const when = new Date().toUTCString();
      const subject = String(m.envelope?.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
      const raw = [
        `From: ${req.user.name ? `"${String(req.user.name).replace(/["\r\n]/g, '')}" ` : ''}<${req.user.email}>`, `To: <${to}>`, `Subject: Read: ${subject}`, `Date: ${when}`,
        `Message-ID: <${crypto.randomUUID()}@${req.user.email.split('@')[1]}>`, 'MIME-Version: 1.0',
        `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`, '',
        `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', `Your email "${subject}" was read by ${req.user.email} on ${when}.`, '',
        `--${boundary}`, 'Content-Type: message/disposition-notification', '',
        'Reporting-UA: Roammail', `Final-Recipient: rfc822; ${req.user.email}`, `Original-Message-ID: ${m.envelope?.messageId || ''}`,
        'Disposition: manual-action/MDN-sent-manually; displayed', '', `--${boundary}--`, '',
      ].join('\r\n');
      await userTransport(nodemailer, req.user).sendMail({ envelope: { from: req.user.email, to: [to] }, raw });
    }
    await client.messageFlagsAdd(uid, ['$MDNSent'], { uid: true }); // asked once, never again (sent or declined)
    return { sent: req.body.decline !== true };
  });
  res.json({ ok: true, ...result });
}));
