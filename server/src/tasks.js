// Tasks, notes and follow-ups (punch list item 9).
//   Tasks: a to-do list, optionally linked to a message, with a due date and a reminder.
//   Notes: private notes attached to a contact (email address) or a conversation (Message-ID).
//   Follow-ups: "remind me if nobody replies by …" on a message you sent. The worker checks the inbox for a reply
//   (In-Reply-To / References) when it is due, and only reminds you if there is none.
// Everything is per mailbox and private; it is included in the account export and removed with the account.
import express from 'express';
import { config } from './config.js';
import { q, audit } from './db.js';
import { requireAuth, seal, unseal } from './session.js';
import { makeClient } from './imap.js';
import { authFailed, isAuthError } from './authguard.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_ITEMS = 2000; // per mailbox and kind
// Shortest follow-up delay (tests shorten it; production keeps a minute)
const MIN_DELAY = process.env.NODE_ENV === 'production' ? 60e3 : Number(process.env.FOLLOWUP_MIN_DELAY_MS ?? 60e3);
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const when = (v) => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > Date.now() + 10 * 365 * 864e5) throw fail(400, 'Invalid date');
  return Math.round(n);
};
const addr = (v) => { const a = str(v, 254).toLowerCase(); if (a && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)) throw fail(400, 'Invalid email address'); return a || null; };
const msgId = (v) => { const m = str(v, 998); if (m && !/^<?[^\s<>]+>?$/.test(m)) throw fail(400, 'Invalid message id'); return m ? `<${m.replace(/^<|>$/g, '')}>` : null; };
async function belowLimit(table, email) {
  const r = await q.get(`SELECT COUNT(*) AS n FROM ${table} WHERE email = ?`, email);
  if (Number(r.n) >= MAX_ITEMS) throw fail(400, 'You have too many items here. Delete some old ones first.');
}

export const tasksApi = express.Router();
tasksApi.use(['/tasks', '/notes', '/followups', '/export-items'], requireAuth);

// ---------------------------------------------------------------- tasks
const taskOut = (t) => ({ id: t.id, title: t.title, details: t.details, dueAt: t.due_at, remindAt: t.remind_at, done: !!t.done_at, doneAt: t.done_at,
  message: t.msg_key ? { key: t.msg_key, subject: t.msg_subject, mailboxId: t.msg_mailbox } : null, createdAt: t.created_at });
tasksApi.get('/tasks', wrap(async (req, res) => {
  const open = await q.all('SELECT * FROM tasks WHERE email = ? AND done_at IS NULL ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, id DESC', req.user.email);
  const done = await q.all('SELECT * FROM tasks WHERE email = ? AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT 50', req.user.email);
  res.json({ open: open.map(taskOut), done: done.map(taskOut) });
}));
tasksApi.post('/tasks', wrap(async (req, res) => {
  const title = str(req.body.title, 300);
  if (!title) throw fail(400, 'Give the task a title');
  await belowLimit('tasks', req.user.email);
  const m = req.body.message || null;
  const now = Date.now();
  const id = await q.insert(`INSERT INTO tasks(email, title, details, due_at, remind_at, msg_key, msg_subject, msg_mailbox, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.user.email, title, str(req.body.details, 5000), when(req.body.dueAt), when(req.body.remindAt),
  m ? str(m.key, 600) : null, m ? str(m.subject, 300) : null, m ? str(m.mailboxId, 20) : null, now, now);
  res.json(taskOut(await q.get('SELECT * FROM tasks WHERE id = ?', id)));
}));
tasksApi.patch('/tasks/:id', wrap(async (req, res) => {
  const t = await q.get('SELECT * FROM tasks WHERE id = ? AND email = ?', Number(req.params.id), req.user.email);
  if (!t) throw fail(404, 'Not found');
  const b = req.body;
  const title = 'title' in b ? str(b.title, 300) : t.title;
  if (!title) throw fail(400, 'Give the task a title');
  const remindAt = 'remindAt' in b ? when(b.remindAt) : t.remind_at;
  await q.run('UPDATE tasks SET title = ?, details = ?, due_at = ?, remind_at = ?, reminded = ?, done_at = ?, updated_at = ? WHERE id = ?',
    title, 'details' in b ? str(b.details, 5000) : t.details, 'dueAt' in b ? when(b.dueAt) : t.due_at, remindAt,
    remindAt !== t.remind_at ? 0 : t.reminded, 'done' in b ? (b.done ? t.done_at || Date.now() : null) : t.done_at, Date.now(), t.id);
  res.json(taskOut(await q.get('SELECT * FROM tasks WHERE id = ?', t.id)));
}));
tasksApi.delete('/tasks/:id', wrap(async (req, res) => {
  await q.run('DELETE FROM tasks WHERE id = ? AND email = ?', Number(req.params.id), req.user.email);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- notes
const noteOut = (n) => ({ id: n.id, body: n.body, contact: n.contact, thread: n.thread, threadSubject: n.thread_subject, createdAt: n.created_at, updatedAt: n.updated_at });
tasksApi.get('/notes', wrap(async (req, res) => {
  const contact = addr(req.query.contact); const thread = msgId(req.query.thread);
  let rows;
  if (contact || thread) {
    rows = await q.all('SELECT * FROM notes WHERE email = ? AND (contact = ? OR thread = ?) ORDER BY updated_at DESC LIMIT 200', req.user.email, contact || '', thread || '');
  } else rows = await q.all('SELECT * FROM notes WHERE email = ? ORDER BY updated_at DESC LIMIT 200', req.user.email);
  res.json(rows.map(noteOut));
}));
tasksApi.post('/notes', wrap(async (req, res) => {
  const body = str(req.body.body, 20000);
  if (!body) throw fail(400, 'Write something first');
  await belowLimit('notes', req.user.email);
  const now = Date.now();
  const id = await q.insert('INSERT INTO notes(email, body, contact, thread, thread_subject, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
    req.user.email, body, addr(req.body.contact), msgId(req.body.thread), str(req.body.threadSubject, 300) || null, now, now);
  res.json(noteOut(await q.get('SELECT * FROM notes WHERE id = ?', id)));
}));
tasksApi.patch('/notes/:id', wrap(async (req, res) => {
  const body = str(req.body.body, 20000);
  if (!body) throw fail(400, 'Write something first');
  const r = await q.run('UPDATE notes SET body = ?, updated_at = ? WHERE id = ? AND email = ?', body, Date.now(), Number(req.params.id), req.user.email);
  if (!r.changes) throw fail(404, 'Not found');
  res.json(noteOut(await q.get('SELECT * FROM notes WHERE id = ?', Number(req.params.id))));
}));
tasksApi.delete('/notes/:id', wrap(async (req, res) => {
  await q.run('DELETE FROM notes WHERE id = ? AND email = ?', Number(req.params.id), req.user.email);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- follow-ups
const fuOut = (f) => ({ id: f.id, messageId: f.message_id, subject: f.subject, recipients: f.recipients, remindAt: f.remind_at, status: f.status, createdAt: f.created_at });
tasksApi.get('/followups', wrap(async (req, res) => {
  const rows = await q.all("SELECT * FROM followups WHERE email = ? AND (status IN ('waiting', 'due') OR created_at > ?) ORDER BY remind_at", req.user.email, Date.now() - 30 * 864e5);
  res.json(rows.map(fuOut));
}));
tasksApi.post('/followups', wrap(async (req, res) => {
  const id = msgId(req.body.messageId);
  if (!id) throw fail(400, 'This message has no Message-ID, so replies can\'t be matched');
  const remindAt = when(req.body.remindAt);
  if (!remindAt || remindAt < Date.now() + MIN_DELAY) throw fail(400, 'Pick a time in the future');
  await belowLimit('followups', req.user.email);
  if (req.delegatedMailbox) throw fail(403, 'Follow-ups work on your own mailbox only');
  // The worker needs to look in the inbox when it is due: keep the sign-in sealed, only until then (+1 day)
  const creds = seal({ email: req.user.email, password: req.user.password, exp: remindAt + 864e5 });
  await q.run("DELETE FROM followups WHERE email = ? AND message_id = ? AND status = 'waiting'", req.user.email, id);
  const fid = await q.insert('INSERT INTO followups(email, message_id, subject, recipients, creds, remind_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
    req.user.email, id, str(req.body.subject, 300), str(req.body.recipients, 1000), creds, remindAt, Date.now());
  res.json(fuOut(await q.get('SELECT * FROM followups WHERE id = ?', fid)));
}));
tasksApi.patch('/followups/:id', wrap(async (req, res) => {
  const f = await q.get('SELECT * FROM followups WHERE id = ? AND email = ?', Number(req.params.id), req.user.email);
  if (!f) throw fail(404, 'Not found');
  if (req.body.status === 'done') await q.run("UPDATE followups SET status = 'done', creds = '' WHERE id = ?", f.id);
  else if (req.body.remindAt) {
    const at = when(req.body.remindAt);
    if (!at || at < Date.now()) throw fail(400, 'Pick a time in the future');
    await q.run("UPDATE followups SET remind_at = ?, status = 'waiting', creds = ? WHERE id = ?", at, seal({ email: req.user.email, password: req.user.password, exp: at + 864e5 }), f.id);
  }
  res.json(fuOut(await q.get('SELECT * FROM followups WHERE id = ?', f.id)));
}));
tasksApi.delete('/followups/:id', wrap(async (req, res) => {
  await q.run('DELETE FROM followups WHERE id = ? AND email = ?', Number(req.params.id), req.user.email);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- export / delete
export async function exportItems(email) {
  return {
    tasks: (await q.all('SELECT * FROM tasks WHERE email = ? ORDER BY id', email)).map(taskOut),
    notes: (await q.all('SELECT * FROM notes WHERE email = ? ORDER BY id', email)).map(noteOut),
    followups: (await q.all('SELECT * FROM followups WHERE email = ? ORDER BY id', email)).map(fuOut),
  };
}
export async function deleteItems(email) {
  for (const t of ['tasks', 'notes', 'followups']) await q.run(`DELETE FROM ${t} WHERE email = ?`, email);
}
tasksApi.get('/export-items', wrap(async (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="tasks-notes-${new Date().toISOString().slice(0, 10)}.json"`);
  await audit(req.user.email, null, 'privacy.export_items', { ip: req.ip });
  res.json({ mailbox: req.user.email, exportedAt: new Date().toISOString(), ...(await exportItems(req.user.email)) });
}));

// ---------------------------------------------------------------- worker: reminders and follow-up checks
let notifier = null; // (email, { title, body, url }) => sends a push and/or an email
export const setReminderNotifier = (fn) => { notifier = fn; };

async function remindTasks() {
  const due = await q.all('SELECT * FROM tasks WHERE remind_at IS NOT NULL AND remind_at <= ? AND reminded = 0 AND done_at IS NULL LIMIT 100', Date.now());
  for (const t of due) {
    const claim = await q.run('UPDATE tasks SET reminded = 1 WHERE id = ? AND reminded = 0', t.id);
    if (claim.changes !== 1) continue; // another worker has it
    await notifier?.(t.email, { title: `Reminder: ${t.title}`, body: t.msg_subject ? `About "${t.msg_subject}"` : (t.details || '').slice(0, 140), url: '/app?panel=tasks', kind: 'task' }).catch(() => {});
  }
}

/** Has anyone replied to messageId? Looks in INBOX (and Archive) for In-Reply-To / References. */
async function hasReply(user, messageId) {
  const c = makeClient(user);
  await c.connect();
  try {
    const boxes = (await c.list()).filter((b) => b.path.toUpperCase() === 'INBOX' || b.specialUse === '\\Archive').map((b) => b.path);
    for (const box of boxes) {
      const lock = await c.getMailboxLock(box, { readOnly: true });
      try {
        for (const header of ['In-Reply-To', 'References']) {
          const uids = await c.search({ header: { [header]: messageId } }, { uid: true });
          if (uids?.length) return true;
        }
      } finally { lock.release(); }
    }
    return false;
  } finally { await c.logout().catch(() => {}); }
}

async function checkFollowups() {
  const due = await q.all("SELECT * FROM followups WHERE status = 'waiting' AND remind_at <= ? LIMIT 50", Date.now());
  for (const f of due) {
    const claim = await q.run("UPDATE followups SET status = 'checking', checked_at = ? WHERE id = ? AND status = 'waiting'", Date.now(), f.id);
    if (claim.changes !== 1) continue;
    const user = unseal(f.creds);
    try {
      if (!user) throw new Error('expired');
      if (await hasReply(user, f.message_id)) { await q.run("UPDATE followups SET status = 'replied', creds = '' WHERE id = ?", f.id); continue; }
      await q.run("UPDATE followups SET status = 'due', creds = '' WHERE id = ?", f.id);
      await notifier?.(f.email, { title: 'No reply yet', body: `${f.recipients ? `${f.recipients}: ` : ''}"${f.subject || '(no subject)'}"`, url: '/app?panel=followups', kind: 'followup' }).catch(() => {});
    } catch (e) {
      if (isAuthError(e)) await authFailed(user?.email || f.email, user?.password); // never retried
      // Can't check (password changed, server down): remind anyway rather than stay silent
      await q.run("UPDATE followups SET status = 'due', creds = '' WHERE id = ?", f.id);
      await notifier?.(f.email, { title: 'Follow up?', body: `"${f.subject || '(no subject)'}" — we couldn't check for a reply`, url: '/app?panel=followups', kind: 'followup' }).catch(() => {});
    }
  }
}

export function startReminders() {
  if (!config.runsBackground) return;
  const run = () => Promise.all([remindTasks(), checkFollowups()]).catch((e) => console.error('APP_ERROR reminders', e.message));
  setTimeout(run, 10_000).unref();
  setInterval(run, Number(process.env.REMINDER_INTERVAL_MS || 60_000)).unref();
}
