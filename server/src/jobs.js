// Background jobs: scheduled sending and snooze.
// Credentials are sealed (AES-256-GCM) inside the job and deleted with it.
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { q } from './db.js';
import { seal, unseal } from './session.js';
import { makeClient } from './imap.js';

export async function addJob(user, type, runAt, payload, summary = {}) {
  const creds = seal({ email: user.email, password: user.password, exp: runAt + 30 * 864e5 });
  return await q.insert('INSERT INTO jobs(email, type, creds, payload, summary, run_at) VALUES(?, ?, ?, ?, ?, ?)',
    user.email, type, creds, JSON.stringify(payload), JSON.stringify(summary), runAt);
}

export async function listJobs(email, type) {
  return (await q.all('SELECT id, type, summary, run_at, status, error FROM jobs WHERE email = ? AND type = ? ORDER BY run_at', email, type))
    .map((j) => ({ ...j, summary: JSON.parse(j.summary) }));
}

export const getJob = async (email, id) => await q.get('SELECT * FROM jobs WHERE id = ? AND email = ?', Number(id), email);
export const deleteJob = async (email, id) => await q.run('DELETE FROM jobs WHERE id = ? AND email = ?', Number(id), email);

async function findFolder(client, use, fallback) {
  const list = await client.list();
  return list.find((f) => f.specialUse === use)?.path || list.find((f) => f.path.toLowerCase() === fallback.toLowerCase())?.path || null;
}

async function runSend(job, user, p) {
  const t = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: { user: user.email, pass: user.password }, tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
  });
  const raw = Buffer.from(p.raw, 'base64');
  await t.sendMail({ envelope: p.envelope, raw });
  const c = makeClient(user);
  await c.connect();
  try {
    const sent = (await findFolder(c, '\\Sent', 'Sent')) || (await c.mailboxCreate('Sent')).path;
    await c.append(sent, raw, ['\\Seen']);
    if (p.replyFolder && p.replyUid) {
      const lock = await c.getMailboxLock(p.replyFolder);
      try { await c.messageFlagsAdd(String(p.replyUid), ['\\Answered'], { uid: true }); } finally { lock.release(); }
    }
  } catch (e) { console.warn('scheduled send: post-send step failed', e.message); } finally { await c.logout().catch(() => {}); }
}

async function runSnooze(job, user, p) {
  const c = makeClient(user);
  await c.connect();
  try {
    const lock = await c.getMailboxLock(p.folder);
    try {
      const uids = p.uids.join(',');
      await c.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      await c.messageMove(uids, p.back || 'INBOX', { uid: true });
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => {}); }
}

let running = false;
export async function tick() {
  if (running) return;
  running = true;
  try {
    const due = await q.all("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 20", Date.now());
    for (const job of due) {
      const claim = await q.run("UPDATE jobs SET status = 'running', claimed_at = ? WHERE id = ? AND status = 'pending'", Date.now(), job.id);
      if (claim.changes !== 1) continue; // another worker took it
      const user = unseal(job.creds);
      try {
        if (!user) throw new Error('Saved sign-in expired');
        const p = JSON.parse(job.payload);
        if (job.type === 'send') await runSend(job, user, p);
        if (job.type === 'snooze') await runSnooze(job, user, p);
        await q.run('DELETE FROM jobs WHERE id = ?', job.id);
      } catch (e) {
        const auth = e.authenticationFailed || /auth/i.test(e.message);
        await q.run("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?",
          auth ? 'Your password changed since this was scheduled. Open it and schedule again.' : String(e.message).slice(0, 300), job.id);
      }
    }
  } finally { running = false; }
}

export async function startJobs() {
  // Recover jobs a crashed worker left half-done (only old ones: another worker may be running the rest right now)
  await q.run("UPDATE jobs SET status = 'pending' WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at < ?)", Date.now() - 10 * 60 * 1000);
  setInterval(() => tick().catch((e) => console.error('jobs', e)), 15000).unref();
}
