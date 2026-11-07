// Public mailbox IDs used in URLs (roammail.net/48302917/inbox, roammail.net/104582-003-PS/inbox).
// They are route names only: never a database key, never proof of identity (every request is checked against
// the session), and never contain the email address. IDs are unique forever: retired and deleted ones stay in
// the table so they are never handed to someone else.
import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';

export const ID_RE = /^(\d{8}|\d{6}-\d{3}-[A-Z]{2})$/;
const rand = (digits) => String(crypto.randomInt(10 ** (digits - 1), 10 ** digits));

/** First + last initials from a display name ("Pete Smith" -> PS, "Support" -> SU), falling back to the address. */
export function initialsFor(name, email = '') {
  const words = String(name || '').normalize('NFKD').replace(/[^A-Za-z\s'-]/g, ' ').split(/[\s'-]+/).filter(Boolean);
  let s = words.length >= 2 ? words[0][0] + words[words.length - 1][0] : (words[0] || '').slice(0, 2);
  if (s.length < 2) s = (s + String(email).split('@')[0].replace(/[^A-Za-z]/g, '')).slice(0, 2);
  return (s.toUpperCase() + 'XX').slice(0, 2);
}

async function orgForEmail(email) {
  return q.get("SELECT o.id, o.account_no FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ? AND d.status = 'active'", email.split('@')[1]);
}
/** Six-digit business account number, given once per business and never reused. */
export async function accountNo(orgId) {
  const o = await q.get('SELECT account_no FROM orgs WHERE id = ?', orgId);
  if (o?.account_no) return o.account_no;
  for (let i = 0; i < 50; i++) {
    const n = rand(6);
    if (await q.get('SELECT 1 FROM orgs WHERE account_no = ?', n)) continue;
    const r = await q.run('UPDATE orgs SET account_no = ? WHERE id = ? AND account_no IS NULL', n, orgId);
    if (r.changes === 1) return n;
    return (await q.get('SELECT account_no FROM orgs WHERE id = ?', orgId)).account_no;
  }
  throw new Error('Could not allocate an account number');
}

async function insertId(id, email, kind, acct, no) {
  try {
    await q.run("INSERT INTO mailbox_ids(id, email, kind, account_no, mailbox_no, status, created_at) VALUES(?, ?, ?, ?, ?, 'active', ?)", id, email, kind, acct, no, Date.now());
    return true;
  } catch { return false; } // taken (unique key): try another
}

/** The mailbox's current public ID, creating one if it doesn't have one yet. */
export async function ensureMailboxId(email, { name } = {}) {
  const e = String(email).toLowerCase();
  const cur = await q.get("SELECT * FROM mailbox_ids WHERE email = ? AND status = 'active'", e);
  if (cur) return cur.id;
  const org = await orgForEmail(e);
  if (org) {
    const acct = await accountNo(org.id);
    // Keep the mailbox number if this address had one before (e.g. a re-created mailbox gets a fresh number instead)
    for (let i = 0; i < 20; i++) {
      const next = (await q.get('SELECT COALESCE(MAX(mailbox_no), 0) + 1 AS n FROM mailbox_ids WHERE account_no = ?', acct)).n;
      if (next > 999) throw new Error('This business has used all 999 mailbox numbers');
      const id = `${acct}-${String(next).padStart(3, '0')}-${initialsFor(name ?? await displayName(e), e)}`;
      if (await insertId(id, e, 'business', acct, next)) return id;
    }
  } else {
    for (let i = 0; i < 50; i++) { const id = rand(8); if (await insertId(id, e, 'personal', null, null)) return id; }
  }
  throw new Error('Could not allocate a mailbox ID');
}

async function displayName(email) {
  const p = await q.get('SELECT name FROM profiles WHERE email = ?', email);
  if (p?.name) return p.name;
  const s = await q.get('SELECT name FROM shared_mailboxes WHERE email = ?', email);
  return s?.name || '';
}

/** Business mailbox renamed: if the initials change, issue a new ID and keep the old one as a redirect. */
export async function renameMailboxId(email, name) {
  const e = String(email).toLowerCase();
  const cur = await q.get("SELECT * FROM mailbox_ids WHERE email = ? AND status = 'active'", e);
  if (!cur || cur.kind !== 'business') return cur?.id || null;
  const ini = initialsFor(name, e);
  if (cur.id.endsWith(`-${ini}`)) return cur.id;
  const id = `${cur.account_no}-${String(cur.mailbox_no).padStart(3, '0')}-${ini}`;
  const taken = await q.get('SELECT email FROM mailbox_ids WHERE id = ?', id);
  if (taken && taken.email !== e) return cur.id; // never reuse someone else's ID
  await q.run("UPDATE mailbox_ids SET status = 'retired' WHERE id = ?", cur.id);
  if (taken) await q.run("UPDATE mailbox_ids SET status = 'active' WHERE id = ?", id); // changed back to old initials
  else await insertId(id, e, 'business', cur.account_no, cur.mailbox_no);
  return id;
}

/** Mailbox deleted: its IDs stay reserved forever but stop resolving. */
export async function retireMailboxIds(email) {
  await q.run("UPDATE mailbox_ids SET status = 'deleted' WHERE email = ?", String(email).toLowerCase());
}

/** id -> { email, active, current } (current = the active ID for that mailbox, for redirects). */
export async function resolveMailboxId(id) {
  if (!ID_RE.test(String(id))) return null;
  const row = await q.get('SELECT * FROM mailbox_ids WHERE id = ?', id);
  if (!row || row.status === 'deleted') return null;
  if (row.status === 'active') return { email: row.email, current: row.id, active: true };
  const cur = await q.get("SELECT id FROM mailbox_ids WHERE email = ? AND status = 'active'", row.email);
  return cur ? { email: row.email, current: cur.id, active: false } : null;
}

export const appBase = () => (config.rootDomain ? `https://${config.rootDomain}` : '');
export const inboxUrl = (id) => `${appBase()}/${id}/inbox`;
