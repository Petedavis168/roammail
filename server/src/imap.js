// Per-session IMAP connection pool. Opening TLS + LOGIN on every request is slow,
// so each signed-in session keeps one connection that is closed after idling.
import { ImapFlow } from 'imapflow';
import { config } from './config.js';

const pool = new Map(); // sid -> { client, timer, connecting }
const IDLE_CLOSE_MS = 5 * 60 * 1000;

export function makeClient(user) {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: user.email, pass: user.password },
    logger: false,
    tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
    emitLogs: false,
  });
}

function touch(sid, entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pool.delete(sid);
    entry.client.logout().catch(() => {});
  }, IDLE_CLOSE_MS);
}

export async function getClient(user) {
  let entry = pool.get(user.sid);
  if (entry && entry.client.usable) {
    touch(user.sid, entry);
    return entry.client;
  }
  if (entry?.connecting) return entry.connecting;

  const client = makeClient(user);
  entry = { client, timer: null };
  entry.connecting = client.connect().then(() => {
    entry.connecting = null;
    return client;
  });
  pool.set(user.sid, entry);
  client.on('close', () => {
    if (pool.get(user.sid) === entry) pool.delete(user.sid);
  });
  client.on('error', () => {});
  try {
    await entry.connecting;
  } catch (err) {
    pool.delete(user.sid);
    throw err;
  }
  touch(user.sid, entry);
  return client;
}

export async function closeClient(sid) {
  const entry = pool.get(sid);
  if (!entry) return;
  pool.delete(sid);
  clearTimeout(entry.timer);
  await entry.client.logout().catch(() => {});
}

/** Run fn with the given mailbox selected (locks are queued per connection). */
export async function withMailbox(user, path, fn, { readOnly = false } = {}) {
  const client = await getClient(user);
  const lock = await client.getMailboxLock(path, { readOnly });
  try {
    return await fn(client);
  } finally {
    lock.release();
  }
}

/** Find the folder path for a special-use flag, e.g. \\Sent, falling back to common names. */
const FALLBACK_NAMES = {
  '\\Sent': ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent'],
  '\\Drafts': ['Drafts', 'INBOX.Drafts'],
  '\\Trash': ['Trash', 'Deleted Items', 'Deleted Messages', 'INBOX.Trash'],
  '\\Junk': ['Junk', 'Spam', 'Junk E-mail', 'INBOX.Junk'],
  '\\Archive': ['Archive', 'Archives', 'INBOX.Archive'],
};

export async function specialFolder(user, use, { create = false } = {}) {
  const client = await getClient(user);
  const list = await client.list();
  const hit = list.find((f) => f.specialUse === use) ||
    list.find((f) => FALLBACK_NAMES[use]?.some((n) => n.toLowerCase() === f.path.toLowerCase()));
  if (hit) return hit.path;
  if (!create) return null;
  const name = FALLBACK_NAMES[use][0];
  await client.mailboxCreate(name);
  return name;
}
