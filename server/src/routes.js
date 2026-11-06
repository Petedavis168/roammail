import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { setSession, clearSession, requireAuth } from './session.js';
import { getClient, closeClient, withMailbox, specialFolder, makeClient } from './imap.js';
import { parseQuery } from './search.js';
import { rolesFor } from './db.js';

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

async function fetchSummaries(client, range, opts = {}) {
  const out = [];
  for await (const msg of client.fetch(range, {
    uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true,
    source: { start: 0, maxLength: 6000 },
  }, opts)) {
    let snippet = '';
    try {
      const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true });
      snippet = snippetFrom(parsed.text || '');
    } catch { /* partial source may not parse */ }
    out.push(summarize(msg, snippet));
  }
  return out.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function uidList(uids) {
  const list = (Array.isArray(uids) ? uids : [uids]).map(Number).filter(Boolean);
  if (!list.length) throw Object.assign(new Error('No messages selected'), { status: 400 });
  return list.join(',');
}

function transport(user) {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: user.email, pass: user.password },
    tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
  });
}

// ---------- auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

api.post('/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const domain = email.split('@')[1];
  if (config.allowedDomains.length && !config.allowedDomains.includes(domain)) {
    return res.status(403).json({ error: 'This email domain is not allowed on this server' });
  }
  const client = makeClient({ email, password });
  try {
    await client.connect();
    await client.logout();
  } catch (err) {
    const authFail = err.authenticationFailed || /auth/i.test(err.responseText || err.message);
    return res.status(authFail ? 401 : 502).json({
      error: authFail ? 'Wrong email or password' : `Could not reach mail server (${err.code || err.message})`,
    });
  }
  setSession(res, { email, password, name: String(req.body?.name || '') });
  res.json({ email });
}));

api.use(requireAuth);

api.post('/logout', wrap(async (req, res) => {
  await closeClient(req.user.sid);
  clearSession(res);
  res.json({ ok: true });
}));

api.get('/me', (req, res) => res.json({ email: req.user.email, name: req.user.name, ...rolesFor(req.user.email) }));

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
  const from = body.fromName ? { name: body.fromName, address: user.email } : user.email;
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

api.post('/send', upload.array('attachments'), wrap(async (req, res) => {
  const files = [...(req.files || []), ...(await forwardedAttachments(req.user, req.body))];
  const mail = buildMail(req.user, req.body, files);
  if (!mail.to && !mail.cc && !mail.bcc) return res.status(400).json({ error: 'Add at least one recipient' });
  const info = await transport(req.user).sendMail(mail);

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
  res.json(cached.list.filter((p) => !q || p.address.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)).slice(0, 10));
}));

// ---------- live updates (Server-Sent Events + IMAP IDLE) ----------
api.get('/events', wrap(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const client = makeClient(req.user); // dedicated connection that sits in IDLE
  let closed = false;
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    client.logout().catch(() => {});
  };
  req.on('close', cleanup);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    client.on('exists', async (d) => {
      if (d.count <= d.prevCount) return send('changed', { folder: 'INBOX' });
      try {
        const msgs = [];
        for await (const m of client.fetch(`${d.prevCount + 1}:${d.count}`, { envelope: true, uid: true })) {
          msgs.push({ uid: m.uid, subject: m.envelope.subject, from: addr(m.envelope.from) });
        }
        send('new', { folder: 'INBOX', messages: msgs });
      } catch { send('changed', { folder: 'INBOX' }); }
    });
    client.on('expunge', () => send('changed', { folder: 'INBOX' }));
    client.on('flags', () => send('changed', { folder: 'INBOX' }));
    client.on('close', () => { if (!closed) { send('reconnect', {}); res.end(); cleanup(); } });
    send('ready', {});
  } catch (e) {
    send('error', { error: e.message });
    res.end();
    cleanup();
  }
}));

