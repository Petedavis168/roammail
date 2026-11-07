import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { clearSession, requireAuth, onRevoke } from './session.js';
import { createCache } from './cache.js';
import { sharedMailboxContext } from './sharedboxes.js';
import { ensureMailboxId } from './mailboxids.js';
import { setupState } from './setup.js';
import { count, gauge } from './ops.js';
import { getClient, closeClient, withMailbox, specialFolder, makeClient, userTransport } from './imap.js';
import { parseQuery } from './search.js';
import { rolesFor, q, twoFactorPolicy } from './db.js';
import { applyEnforcedSignature } from './signatures.js';
import { spamInfo } from './spam.js';
import { parseInvite } from './calendar.js';
import { allContacts, directory } from './contacts.js';
import { identitiesFor } from './groups.js';
import { addJob, listJobs, getJob, deleteJob } from './jobs.js';
import { checkSendQuota, cleanDisplayName } from './abuse.js';
import { config as appConfig } from './config.js';

export const api = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxAttachmentMb * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
const addr = (list) => (list || []).map((a) => ({ name: a.name || '', address: a.address || '' }));

function snippetFrom(text = '') {
  return text.replace(/\[(?:https?|cid|mailto):[^\]]*\]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function hasAttachments(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachments);
}

function summarize(msg, snippet = '') {
  const e = msg.envelope || {};
  return {
    uid: msg.uid,
    seq: msg.seq,
    messageId: e.messageId,
    inReplyTo: e.inReplyTo,
    subject: e.subject || '(no subject)',
    from: addr(e.from),
    to: addr(e.to),
    cc: addr(e.cc),
    date: (e.date || msg.internalDate)?.toISOString?.() || null,
    flags: [...(msg.flags || [])],
    seen: msg.flags?.has('\\Seen') || false,
    flagged: msg.flags?.has('\\Flagged') || false,
    answered: msg.flags?.has('\\Answered') || false,
    draft: msg.flags?.has('\\Draft') || false,
    categories: [...(msg.flags || [])].filter((f) => /^cat_/i.test(f)).map((f) => f.slice(4)),
    size: msg.size,
    hasAttachments: hasAttachments(msg.bodyStructure),
    snippet,
  };
}

// Previews never change for a given message (UID + UIDVALIDITY), so we remember them and only download
// the first few KB of messages we haven't seen before. Keyed per person, so nothing is shared between users.
const previewCache = createCache({ ttlMs: 6 * 3600e3, max: Number(process.env.PREVIEW_CACHE_ENTRIES || 50000) });
async function fetchSummaries(client, range, opts = {}) {
  const out = [];
  const owner = client.options?.auth?.user;
  if (!owner) throw new Error('mail connection has no owner');
  const mbox = `${owner}|${client.mailbox?.path}|${client.mailbox?.uidValidity}`;
  const missing = [];
  for await (const msg of client.fetch(range, { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true }, opts)) {
    const snippet = previewCache.peek(`${mbox}|${msg.uid}`);
    if (snippet === undefined) missing.push(msg.uid);
    out.push({ msg, snippet });
  }
  if (missing.length) {
    for await (const msg of client.fetch(missing.join(','), { uid: true, source: { start: 0, maxLength: 6000 } }, { uid: true })) {
      let snippet = '';
      try {
        const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true });
        snippet = snippetFrom(parsed.text || '');
      } catch { /* partial source may not parse */ }
      previewCache.set(`${mbox}|${msg.uid}`, snippet);
    }
  }
  return out.map(({ msg, snippet }) => summarize(msg, snippet ?? previewCache.peek(`${mbox}|${msg.uid}`) ?? '')).sort((a, b) => b.uid - a.uid);
}

function uidList(uids) {
  const list = (Array.isArray(uids) ? uids : [uids]).map(Number).filter(Boolean);
  if (!list.length) throw Object.assign(new Error('No messages selected'), { status: 400 });
  return list.join(',');
}

function transport(user) {
  return userTransport(nodemailer, user);
}

// ---------- auth (login lives in security.js) ----------
api.use(requireAuth);
api.use(sharedMailboxContext());

api.post('/logout', wrap(async (req, res) => {
  await closeClient(req.user.sid);
  await clearSession(req, res, { all: req.body?.all === true });
  res.json({ ok: true });
}));

api.get('/me', async (req, res) => res.json({
  email: req.user.email, name: req.user.name, ...await rolesFor(req.user.email),
  mailboxId: await ensureMailboxId(req.user.email, { name: req.user.name || undefined }),
  setup: await setupState(req.user.email),
  // every mailbox signed in on this browser (switch = change the ID in the URL)
  accounts: await Promise.all((req.accounts || []).map(async (a) => ({ email: a.email, name: a.name, mailboxId: await ensureMailboxId(a.email) }))),
  // set when the URL points at a shared mailbox this person can open
  viewing: req.delegatedMailbox ? { email: req.delegatedMailbox, mailboxId: await ensureMailboxId(req.delegatedMailbox) } : null,
  twoFactor: await twoFactorPolicy(req.user.email), adminRequires2fa: appConfig.requireAdmin2fa,
  orgDomains: (await q.all("SELECT d.domain FROM domains d WHERE d.status = 'active' AND d.org_id = (SELECT org_id FROM domains WHERE domain = ?)", req.user.email.split('@')[1])).map((d) => d.domain),
  clientSettings: { meetUrl: (process.env.MEETING_URL || 'https://meet.jit.si').replace(/\/$/, ''), imapHost: appConfig.imap.host, imapPort: appConfig.imap.port, smtpHost: appConfig.smtp.host, smtpPort: appConfig.smtp.port, smtpSecure: appConfig.smtp.secure, davEnabled: appConfig.davEnabled, davHost: appConfig.davHost },
}));

// ---------- folders ----------
api.get('/folders', wrap(async (req, res) => {
  const client = await getClient(req.user);
  const list = await client.list({ statusQuery: { messages: true, unseen: true } });
  res.json(list.map((f) => ({
    path: f.path,
    name: f.name,
    delimiter: f.delimiter,
    parent: f.parentPath || null,
    specialUse: f.specialUse || (f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null),
    flags: [...(f.flags || [])],
    total: f.status?.messages ?? 0,
    unread: f.status?.unseen ?? 0,
    subscribed: f.subscribed,
  })));
}));

api.post('/folders', wrap(async (req, res) => {
  const client = await getClient(req.user);
  const created = await client.mailboxCreate(req.body.path);
  await client.mailboxSubscribe(created.path).catch(() => {});
  res.json({ path: created.path });
}));

api.patch('/folders', wrap(async (req, res) => {
  const client = await getClient(req.user);
  const r = await client.mailboxRename(req.body.path, req.body.newPath);
  res.json({ path: r.newPath });
}));

api.delete('/folders', wrap(async (req, res) => {
  const client = await getClient(req.user);
  await client.mailboxDelete(req.query.path);
  res.json({ ok: true });
}));

// ---------- message list ----------
api.get('/messages', wrap(async (req, res) => {
  const folder = req.query.folder || 'INBOX';
  const page = Math.max(0, Number(req.query.page || 0));
  const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize || 50)));
  const filter = req.query.filter; // unread | flagged | attachments

  const result = await withMailbox(req.user, folder, async (client) => {
    const total = client.mailbox.exists;
    if (filter) {
      const crit = filter === 'unread' ? { seen: false } : filter === 'flagged' ? { flagged: true }
        : { header: { 'Content-Type': 'multipart/mixed' } };
      const uids = ((await client.search(crit, { uid: true })) || []).sort((a, b) => b - a);
      const slice = uids.slice(page * pageSize, (page + 1) * pageSize);
      const messages = slice.length ? await fetchSummaries(client, slice.join(','), { uid: true }) : [];
      return { total: uids.length, messages };
    }
    if (!total) return { total: 0, messages: [] };
    const end = total - page * pageSize;
    if (end < 1) return { total, messages: [] };
    const start = Math.max(1, end - pageSize + 1);
    return { total, messages: await fetchSummaries(client, `${start}:${end}`) };
  });
  res.json({ folder, page, pageSize, ...result });
}));

// ---------- search ----------
api.get('/search', wrap(async (req, res) => {
  const { criteria, folder: inFolder } = parseQuery(String(req.query.q || ''));
  let folder = inFolder || req.query.folder || 'INBOX';
  if (inFolder) {
    const map = { sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', spam: '\\Junk', junk: '\\Junk', archive: '\\Archive' };
    if (inFolder.toLowerCase() === 'inbox') folder = 'INBOX';
    else if (map[inFolder.toLowerCase()]) folder = (await specialFolder(req.user, map[inFolder.toLowerCase()])) || inFolder;
  }
  const result = await withMailbox(req.user, folder, async (client) => {
    const uids = ((await client.search(criteria, { uid: true })) || []).sort((a, b) => b - a).slice(0, 200);
    return uids.length ? fetchSummaries(client, uids.join(','), { uid: true }) : [];
  });
  res.json({ folder, query: req.query.q, total: result.length, messages: result });
}));

// ---------- single message ----------
async function loadMessage(user, folder, uid, { markSeen = true } = {}) {
  return withMailbox(user, folder, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true, flags: true, envelope: true, uid: true, internalDate: true, size: true, bodyStructure: true }, { uid: true });
    if (!msg) return null;
    if (markSeen && !msg.flags.has('\\Seen')) {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      msg.flags.add('\\Seen');
    }
    const parsed = await simpleParser(msg.source);
    return { msg, parsed };
  });
}

// Read SPF/DKIM/DMARC results added by mailcow (rspamd) and look for impersonation tricks.
function senderSecurity(parsed) {
  const raw = [].concat(parsed.headers.get('authentication-results') || []).map(String).join(' ').toLowerCase();
  const pick = (k) => (new RegExp(`\\b${k}=(\\w+)`).exec(raw) || [])[1] || null;
  const from = parsed.from?.value?.[0] || {};
  const nameAddr = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(from.name || '')?.[0]?.toLowerCase();
  const replyTo = parsed.replyTo?.value?.[0]?.address?.toLowerCase();
  const fromDomain = from.address?.split('@')[1]?.toLowerCase();
  const spam = parsed.headers.get('x-spam-flag') === 'YES' || /yes/i.test(String(parsed.headers.get('x-spam') || ''));
  return {
    spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc'),
    spoofedName: !!(nameAddr && nameAddr !== from.address?.toLowerCase()),
    replyToDiffers: !!(replyTo && fromDomain && replyTo.split('@')[1] !== fromDomain),
    spam,
  };
}

function fullMessage(folder, msg, parsed) {
  const base = summarize(msg, snippetFrom(parsed.text || ''));
  return {
    ...base,
    folder,
    replyTo: addr(parsed.replyTo?.value),
    bcc: addr(parsed.bcc?.value),
    references: [].concat(parsed.references || []),
    html: parsed.html || null,
    text: parsed.text || '',
    listUnsubscribe: parsed.headers.get('list-unsubscribe') || null,
    security: senderSecurity(parsed),
    spam: spamInfo(parsed.headers.get('x-spamd-result')),
    invite: (() => {
      const a = (parsed.attachments || []).find((x) => /text\/calendar|application\/ics/i.test(x.contentType));
      return a ? parseInvite(a.content.toString('utf8')) : null;
    })(),
    attachments: (parsed.attachments || []).map((a, i) => ({
      index: i,
      filename: a.filename || `attachment-${i + 1}`,
      contentType: a.contentType,
      size: a.size,
      cid: a.contentId?.replace(/[<>]/g, '') || null,
      inline: a.contentDisposition === 'inline' && !!a.contentId,
    })),
  };
}

api.get('/message', wrap(async (req, res) => {
  const { folder = 'INBOX', uid } = req.query;
  const r = await loadMessage(req.user, folder, uid, { markSeen: req.query.peek !== '1' });
  if (!r) return res.status(404).json({ error: 'Message not found' });
  res.json(fullMessage(folder, r.msg, r.parsed));
}));

// Gmail-style conversation: find related messages in this folder + Sent.
api.get('/thread', wrap(async (req, res) => {
  const { folder = 'INBOX', uid } = req.query;
  const first = await loadMessage(req.user, folder, uid);
  if (!first) return res.status(404).json({ error: 'Message not found' });
  const root = fullMessage(folder, first.msg, first.parsed);
  const ids = new Set([root.messageId, root.inReplyTo, ...root.references].filter(Boolean));

  const sent = await specialFolder(req.user, '\\Sent');
  const folders = [...new Set([folder, 'INBOX', sent].filter(Boolean))];
  const seen = new Map();
  seen.set(`${folder}:${root.uid}`, root);

  for (const f of folders) {
    try {
      await withMailbox(req.user, f, async (client) => {
        const criteria = [];
        for (const id of ids) {
          criteria.push({ header: { 'Message-ID': id } }, { header: { References: id } }, { header: { 'In-Reply-To': id } });
        }
        if (!criteria.length) return;
        const uids = (await client.search(criteria.length === 1 ? criteria[0] : { or: criteria }, { uid: true })) || [];
        for (const u of uids.slice(-50)) {
          if (seen.has(`${f}:${u}`)) continue;
          const m = await client.fetchOne(String(u), { source: true, flags: true, envelope: true, uid: true, internalDate: true, bodyStructure: true }, { uid: true });
          if (!m) continue;
          const p = await simpleParser(m.source);
          seen.set(`${f}:${u}`, fullMessage(f, m, p));
        }
      });
    } catch { /* folder may not exist */ }
  }
  // De-duplicate by Message-ID (same mail can be in Inbox and Sent)
  const byId = new Map();
  for (const m of seen.values()) {
    const k = m.messageId || `${m.folder}:${m.uid}`;
    if (!byId.has(k) || (m.folder === folder && m.uid === root.uid)) byId.set(k, m);
  }
  const messages = [...byId.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  res.json({ subject: root.subject, messages });
}));

api.get('/attachment', wrap(async (req, res) => {
  const { folder = 'INBOX', uid, index } = req.query;
  const r = await loadMessage(req.user, folder, uid, { markSeen: false });
  const att = r?.parsed.attachments?.[Number(index)];
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const name = (att.filename || 'attachment').replace(/["\r\n]/g, '');
  res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(att.content);
}));

api.get('/raw', wrap(async (req, res) => {
  const { folder = 'INBOX', uid } = req.query;
  const src = await withMailbox(req.user, folder, async (c) => (await c.fetchOne(String(uid), { source: true }, { uid: true }))?.source);
  if (!src) return res.status(404).end();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(src);
}));

// ---------- actions ----------
api.post('/flags', wrap(async (req, res) => {
  const { folder = 'INBOX', uids, add = [], remove = [] } = req.body;
  const range = uidList(uids);
  await withMailbox(req.user, folder, async (client) => {
    if (add.length) await client.messageFlagsAdd(range, add, { uid: true });
    if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true });
  });
  res.json({ ok: true });
}));

api.post('/move', wrap(async (req, res) => {
  const { folder = 'INBOX', uids, to } = req.body;
  let dest = to;
  const special = { '@archive': '\\Archive', '@trash': '\\Trash', '@junk': '\\Junk' };
  if (special[to]) dest = await specialFolder(req.user, special[to], { create: true });
  const range = uidList(uids);
  const r = await withMailbox(req.user, folder, (c) => c.messageMove(range, dest, { uid: true }));
  res.json({ ok: true, to: dest, uidMap: r?.uidMap ? Object.fromEntries(r.uidMap) : {} });
}));

api.post('/copy', wrap(async (req, res) => {
  const { folder = 'INBOX', uids, to } = req.body;
  await withMailbox(req.user, folder, (c) => c.messageCopy(uidList(uids), to, { uid: true }));
  res.json({ ok: true });
}));

api.post('/delete', wrap(async (req, res) => {
  const { folder = 'INBOX', uids, permanent } = req.body;
  const trash = await specialFolder(req.user, '\\Trash', { create: true });
  const range = uidList(uids);
  if (permanent || folder === trash) {
    await withMailbox(req.user, folder, (c) => c.messageDelete(range, { uid: true }));
    return res.json({ ok: true, permanent: true });
  }
  const r = await withMailbox(req.user, folder, (c) => c.messageMove(range, trash, { uid: true }));
  res.json({ ok: true, to: trash, uidMap: r?.uidMap ? Object.fromEntries(r.uidMap) : {} });
}));

api.post('/empty', wrap(async (req, res) => {
  await withMailbox(req.user, req.body.folder, async (c) => {
    if (c.mailbox.exists) await c.messageDelete('1:*');
  });
  res.json({ ok: true });
}));

api.post('/mark-all-read', wrap(async (req, res) => {
  await withMailbox(req.user, req.body.folder || 'INBOX', async (c) => {
    if (c.mailbox.exists) await c.messageFlagsAdd('1:*', ['\\Seen']);
  });
  res.json({ ok: true });
}));

// ---------- compose / send ----------
function buildMail(user, body, files) {
  // Display names can't contain addresses or brackets (stops "CEO <boss@bank.com>"-style spoofing)
  const fromName = cleanDisplayName(body.fromName);
  const address = body._fromAddress || user.email; // validated in the route against identitiesFor()
  const from = fromName ? { name: fromName, address } : address;
  const mail = {
    from,
    to: body.to || undefined,
    cc: body.cc || undefined,
    bcc: body.bcc || undefined,
    subject: body.subject || '',
    html: body.html || undefined,
    text: body.text || undefined,
    inReplyTo: body.inReplyTo || undefined,
    references: body.references || undefined,
    priority: body.priority || 'normal',
    attachments: (files || []).map((f) => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype })),
  };
  if (body.readReceipt === 'true') mail.headers = { 'Disposition-Notification-To': user.email };
  return mail;
}

async function compile(mail) {
  return new Promise((resolve, reject) => new MailComposer(mail).compile().build((e, m) => (e ? reject(e) : resolve(m))));
}

async function forwardedAttachments(user, body) {
  // Forwarding: re-attach the original message's attachments
  if (!body.forwardFolder || !body.forwardUid) return [];
  const r = await loadMessage(user, body.forwardFolder, body.forwardUid, { markSeen: false });
  return (r?.parsed.attachments || []).filter((a) => a.contentDisposition !== 'inline' || !a.contentId).map((a) => ({
    originalname: a.filename || 'attachment', buffer: a.content, mimetype: a.contentType,
  }));
}

async function resolveFrom(req) {
  const want = String(req.body.fromAddress || '').trim().toLowerCase();
  if (!want || want === req.user.email) return;
  const ids = await identitiesFor(req.user);
  if (!ids.some((i) => i.address === want)) throw Object.assign(new Error('You are not allowed to send from that address'), { status: 403 });
  req.body._fromAddress = want;
}

api.post('/send', upload.array('attachments'), wrap(async (req, res) => {
  await resolveFrom(req);
  const files = [...(req.files || []), ...(await forwardedAttachments(req.user, req.body))];
  let mail = buildMail(req.user, req.body, files);
  if (!mail.to && !mail.cc && !mail.bcc) return res.status(400).json({ error: 'Add at least one recipient' });
  const rcptCount = [mail.to, mail.cc, mail.bcc].filter(Boolean).flatMap((v) => addressparser(v)).filter((a) => a.address).length;
  await checkSendQuota(req.user.email, rcptCount);
  mail = await applyEnforcedSignature(req.user, mail, !!(req.body.inReplyTo || req.body.forwardUid));

  // Schedule send: store the finished message and send it later from the job worker
  const sendAt = Number(req.body.sendAt || 0);
  if (sendAt && sendAt > Date.now() + 30000) {
    if (sendAt > Date.now() + 365 * 864e5) return res.status(400).json({ error: 'Pick a time within the next year' });
    const raw = await compile({ ...mail, date: new Date(sendAt) });
    const envelope = { from: req.user.email, to: [mail.to, mail.cc, mail.bcc].filter(Boolean).flatMap((v) => addressparser(v)).map((a) => a.address).filter(Boolean) };
    const id = await addJob(req.user, 'send', sendAt, { raw: raw.toString('base64'), envelope, replyFolder: req.body.replyFolder, replyUid: req.body.replyUid },
      { subject: mail.subject, to: mail.to || mail.cc || mail.bcc });
    if (req.body.draftUid) {
      const drafts = await specialFolder(req.user, '\\Drafts');
      if (drafts) await withMailbox(req.user, drafts, (c) => c.messageDelete(String(req.body.draftUid), { uid: true })).catch(() => {});
    }
    return res.json({ ok: true, scheduled: true, id, sendAt });
  }
  const info = await transport(req.user).sendMail(mail);
  count('mail_sent');

  // mailcow (Postfix) does not store sent mail itself; append a copy to Sent.
  try {
    const sent = await specialFolder(req.user, '\\Sent', { create: true });
    const raw = await compile({ ...mail, messageId: info.messageId });
    const client = await getClient(req.user);
    await client.append(sent, raw, ['\\Seen']);
  } catch (e) { console.warn('Could not save to Sent:', e.message); }

  // Mark the original as answered, delete the draft if this came from one
  if (req.body.replyFolder && req.body.replyUid) {
    await withMailbox(req.user, req.body.replyFolder, (c) => c.messageFlagsAdd(String(req.body.replyUid), [req.body.forwardUid ? '$Forwarded' : '\\Answered'], { uid: true })).catch(() => {});
  }
  if (req.body.draftUid) {
    const drafts = await specialFolder(req.user, '\\Drafts');
    if (drafts) await withMailbox(req.user, drafts, (c) => c.messageDelete(String(req.body.draftUid), { uid: true })).catch(() => {});
  }
  res.json({ ok: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected });
}));

api.post('/drafts', upload.array('attachments'), wrap(async (req, res) => {
  await resolveFrom(req);
  const drafts = await specialFolder(req.user, '\\Drafts', { create: true });
  const raw = await compile(buildMail(req.user, req.body, req.files));
  const client = await getClient(req.user);
  const r = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
  if (req.body.draftUid) {
    await withMailbox(req.user, drafts, (c) => c.messageDelete(String(req.body.draftUid), { uid: true })).catch(() => {});
  }
  res.json({ ok: true, folder: drafts, uid: r?.uid });
}));

// ---------- contacts (autocomplete from people you've emailed) ----------
const contactCache = new Map();
const dirCache = new Map();
async function directoryCached(email) {
  const domain = email.split('@')[1]; const c = dirCache.get(domain);
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.list;
  const list = await directory(email); dirCache.set(domain, { at: Date.now(), list }); return list;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of contactCache) if (now - v.at > 30 * 60 * 1000) contactCache.delete(k); }, 10 * 60 * 1000).unref();
api.get('/contacts', wrap(async (req, res) => {
  const key = req.user.sid;
  let cached = contactCache.get(key);
  if (!cached || Date.now() - cached.at > 10 * 60 * 1000) {
    const people = new Map();
    const add = (a, w) => {
      if (!a?.address) return;
      const k = a.address.toLowerCase();
      if (k === req.user.email) return;
      const p = people.get(k) || { name: a.name || '', address: a.address, score: 0 };
      if (!p.name && a.name) p.name = a.name;
      p.score += w;
      people.set(k, p);
    };
    const sent = await specialFolder(req.user, '\\Sent');
    for (const [f, w] of [[sent, 3], ['INBOX', 1]]) {
      if (!f) continue;
      try {
        await withMailbox(req.user, f, async (c) => {
          const n = c.mailbox.exists;
          if (!n) return;
          for await (const m of c.fetch(`${Math.max(1, n - 500)}:${n}`, { envelope: true })) {
            for (const a of [...(m.envelope.to || []), ...(m.envelope.cc || [])]) add(a, w);
            if (f === 'INBOX') for (const a of m.envelope.from || []) add(a, w);
          }
        }, { readOnly: true });
      } catch { /* ignore */ }
    }
    cached = { at: Date.now(), list: [...people.values()].sort((a, b) => b.score - a.score) };
    contactCache.set(key, cached);
  }
  const q = String(req.query.q || '').toLowerCase();
  // Saved contacts and coworkers rank above people you've only emailed
  const merged = new Map();
  const add = (address, name, score) => {
    if (!address) return; const k = address.toLowerCase(); if (k === req.user.email) return;
    const cur = merged.get(k); if (!cur || cur.score < score) merged.set(k, { name: name || cur?.name || '', address, score });
  };
  for (const p of cached.list) add(p.address, p.name, p.score);
  try { for (const c of await allContacts(req.user)) for (const e of c.emails) add(e.value, c.name, 1000); } catch { /* calendar server unavailable */ }
  try { for (const p of await directoryCached(req.user.email)) add(p.email, p.name, 900); } catch { /* not a business */ }
  const match = (p) => !q || p.address.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
  res.json([...merged.values()].filter(match).sort((a, b) => b.score - a.score).slice(0, 10));
}));

// ---------- live updates (Server-Sent Events + IMAP IDLE) ----------
// One IDLE connection per person, shared by all their open tabs and devices (was one per tab).
const hubs = new Map(); // email -> { subs: Set<fn>, client, ready: Promise }
gauge('live_users', () => hubs.size);
gauge('preview_cache_entries', () => previewCache.size);
export const liveStats = () => ({ users: hubs.size, streams: [...hubs.values()].reduce((n, h) => n + h.subs.size, 0) });

function openHub(user) {
  const hub = { subs: new Set(), client: makeClient(user), closed: false };
  const emit = (event, data) => { for (const fn of hub.subs) fn(event, data); };
  const c = hub.client;
  hub.close = () => { if (hub.closed) return; hub.closed = true; hubs.delete(user.email); c.logout().catch(() => {}); };
  hub.ready = (async () => {
    await c.connect();
    await c.mailboxOpen('INBOX', { readOnly: true });
    c.on('exists', async (d) => {
      if (d.count <= d.prevCount) return emit('changed', { folder: 'INBOX' });
      try {
        const msgs = [];
        for await (const m of c.fetch(`${d.prevCount + 1}:${d.count}`, { envelope: true, uid: true })) {
          msgs.push({ uid: m.uid, subject: m.envelope.subject, from: addr(m.envelope.from) });
        }
        emit('new', { folder: 'INBOX', messages: msgs });
      } catch { emit('changed', { folder: 'INBOX' }); }
    });
    c.on('expunge', () => emit('changed', { folder: 'INBOX' }));
    c.on('flags', () => emit('changed', { folder: 'INBOX' }));
    c.on('close', () => { if (!hub.closed) { emit('reconnect', {}); hub.close(); } });
    c.idle().catch(() => {}); // start listening now instead of after imapflow's 15s auto-idle delay
  })();
  hub.ready.catch(() => hub.close());
  hubs.set(user.email, hub);
  return hub;
}

api.get('/events', wrap(async (req, res) => {
  let hub = hubs.get(req.user.email);
  if (hub && hub.subs.size >= 10) return res.status(429).json({ error: 'Too many open tabs' });
  if (!hub || hub.closed) hub = openHub(req.user);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'reconnect') res.end();
  };
  hub.subs.add(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    hub.subs.delete(send);
    if (!hub.subs.size) hub.close();
  });
  try {
    await hub.ready;
    send('ready', {});
  } catch (e) {
    send('error', { error: e.message });
    res.end();
  }
}));

/** Close a person's live connection (e.g. after a password change or sign-out everywhere). */
export function closeLive(email) {
  const hub = hubs.get(email);
  if (!hub) return;
  for (const fn of hub.subs) fn('reconnect', {}); // remaining tabs reconnect and must authenticate again
  hub.close();
}
onRevoke(closeLive);


// ---------- scheduled send ----------
api.get('/scheduled', async (req, res) => res.json(await listJobs(req.user.email, 'send')));
api.delete('/scheduled', wrap(async (req, res) => {
  const job = await getJob(req.user.email, req.query.id);
  if (!job || job.type !== 'send') return res.status(404).json({ error: 'Not found' });
  if (job.status === 'running') return res.status(409).json({ error: 'It is being sent right now' });
  // Return the message to Drafts so the user can edit it
  if (req.query.toDrafts === '1') {
    const drafts = await specialFolder(req.user, '\\Drafts', { create: true });
    const client = await getClient(req.user);
    await client.append(drafts, Buffer.from(JSON.parse(job.payload).raw, 'base64'), ['\\Draft', '\\Seen']);
  }
  await deleteJob(req.user.email, job.id);
  res.json({ ok: true });
}));

// ---------- snooze ----------
api.post('/snooze', wrap(async (req, res) => {
  const { folder = 'INBOX', uids, until } = req.body;
  const at = Number(until);
  if (!at || at < Date.now() + 60000) return res.status(400).json({ error: 'Pick a time in the future' });
  const client = await getClient(req.user);
  const list = await client.list();
  let snoozed = list.find((f) => f.path.toLowerCase() === 'snoozed')?.path;
  if (!snoozed) snoozed = (await client.mailboxCreate('Snoozed')).path;
  const range = uidList(uids);
  const info = await withMailbox(req.user, folder, async (c) => {
    const out = [];
    for await (const m of c.fetch(range, { envelope: true }, { uid: true })) out.push({ subject: m.envelope.subject, id: m.envelope.messageId });
    return out;
  });
  const r = await withMailbox(req.user, folder, (c) => c.messageMove(range, snoozed, { uid: true }));
  let newUids = r?.uidMap ? [...r.uidMap.values()] : [];
  if (!newUids.length) {
    // Server without UIDPLUS: find the moved messages by Message-ID
    newUids = await withMailbox(req.user, snoozed, async (c) => {
      const found = [];
      for (const { id } of info.filter((x) => x.id)) found.push(...((await c.search({ header: { 'Message-ID': id } }, { uid: true })) || []));
      return found;
    });
  }
  if (!newUids.length) return res.status(500).json({ error: 'Could not snooze: the messages were moved to the Snoozed folder but could not be tracked' });
  const subjects = info.map((x) => x.subject);
  const id = await addJob(req.user, 'snooze', at, { folder: snoozed, uids: newUids, back: folder }, { subject: subjects[0] || '', count: newUids.length, uids: newUids, back: folder });
  res.json({ ok: true, id, until: at, folder: snoozed });
}));
api.get('/snoozed', async (req, res) => res.json(await listJobs(req.user.email, 'snooze')));
api.post('/snoozed/wake', wrap(async (req, res) => {
  const job = await getJob(req.user.email, req.body.id);
  if (!job || job.type !== 'snooze') return res.status(404).json({ error: 'Not found' });
  await q.run("UPDATE jobs SET run_at = 0, status = 'pending' WHERE id = ?", job.id);
  const { tick } = await import('./jobs.js');
  await tick();
  res.json({ ok: true });
}));
