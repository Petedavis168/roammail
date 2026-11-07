import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  max_mailboxes INTEGER NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  verify_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | suspended
  dkim_txt TEXT,
  dkim_selector TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT
);
CREATE TABLE IF NOT EXISTS members (
  email TEXT NOT NULL,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user',        -- admin | user
  PRIMARY KEY (email, org_id)
);
CREATE TABLE IF NOT EXISTS signups (
  email TEXT PRIMARY KEY,
  ip TEXT,
  recovery_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS user_security (
  email TEXT PRIMARY KEY,
  totp_secret TEXT,                 -- sealed (encrypted) base32 secret
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  backup_codes TEXT NOT NULL DEFAULT '[]', -- JSON array of sha256 hashes
  session_epoch INTEGER NOT NULL DEFAULT 0,
  recovery_email TEXT,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the cookie token (the token itself is never stored)
  email TEXT NOT NULL,
  creds TEXT NOT NULL,               -- sealed (AES-256-GCM) mailbox password
  name TEXT,
  ip TEXT, ua TEXT,
  created INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions(email);
CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, ip TEXT, ua TEXT, ok INTEGER NOT NULL, reason TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS login_events_email ON login_events(email, id);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  type TEXT NOT NULL,               -- send | snooze
  creds TEXT NOT NULL,              -- sealed credentials, deleted with the job
  payload TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | failed
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
CREATE TABLE IF NOT EXISTS user_settings (
  email TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (email, key)
);
CREATE TABLE IF NOT EXISTS setup_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  creds TEXT,                       -- sealed password (optional) so the profile needs no typing
  expires INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'static',   -- static | department | everyone
  department TEXT,
  members TEXT NOT NULL DEFAULT '[]',    -- JSON list of addresses (static groups)
  internal INTEGER NOT NULL DEFAULT 1,   -- only people in the organization can email the group
  send_as INTEGER NOT NULL DEFAULT 1,    -- members can send as the group address
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS departments (
  org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (org_id, name)
);
CREATE TABLE IF NOT EXISTS friendly_codes (
  code_hash TEXT PRIMARY KEY,
  hint TEXT NOT NULL,                 -- last 4 characters, for display
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_by_org INTEGER, used_at TEXT
);
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY, type TEXT, org_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS twofa_resets (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  execute_after INTEGER NOT NULL,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending'    -- pending | canceled | done
);
CREATE TABLE IF NOT EXISTS profiles (
  email TEXT PRIMARY KEY,
  name TEXT, title TEXT, department TEXT, phone TEXT, mobile TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_signatures (
  email TEXT PRIMARY KEY,
  data TEXT NOT NULL               -- JSON { signatures:[{id,name,html}], defaultNew, defaultReply }
);
CREATE TABLE IF NOT EXISTS org_signatures (
  org_id INTEGER PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  html TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'off', -- off | default | enforced
  on_replies INTEGER NOT NULL DEFAULT 1,
  vars TEXT NOT NULL DEFAULT '{}',  -- JSON { company, website, address, logo }
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, org_id INTEGER, action TEXT, detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrations for columns added after first release
for (const [table, col, def] of [['orgs', 'require_2fa', 'INTEGER NOT NULL DEFAULT 0'], ['orgs', 'allow_external_forward', 'INTEGER NOT NULL DEFAULT 0'], ['signups', 'terms_version', 'TEXT'],
  ['orgs', 'plan', "TEXT NOT NULL DEFAULT 'standard'"], ['orgs', 'billing_interval', 'TEXT'], ['orgs', 'stripe_customer', 'TEXT'],
  ['orgs', 'stripe_subscription', 'TEXT'], ['orgs', 'billing_status', "TEXT NOT NULL DEFAULT 'none'"], ['orgs', 'paid_seats', 'INTEGER NOT NULL DEFAULT 0'],
  ['orgs', 'canceled_at', 'TEXT'],
  ['user_security', 'recovery_verified', 'INTEGER NOT NULL DEFAULT 0'], ['user_security', 'recovery_pending', 'TEXT'],
  ['user_security', 'recovery_code', 'TEXT'], ['user_security', 'recovery_code_exp', 'INTEGER'], ['user_security', 'recovery_code_tries', 'INTEGER NOT NULL DEFAULT 0']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

export const q = {
  get: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
};

export function setting(key, fallback) {
  const r = q.get('SELECT value FROM settings WHERE key = ?', key);
  return r ? JSON.parse(r.value) : fallback;
}
export function setSetting(key, value) {
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
export function audit(actor, orgId, action, detail = {}) {
  q.run('INSERT INTO audit(actor, org_id, action, detail) VALUES(?, ?, ?, ?)', actor, orgId ?? null, action, JSON.stringify(detail));
}

/** Roles for an email: super admin + org memberships. */
export function rolesFor(email) {
  const e = email.toLowerCase();
  const orgs = q.all(`SELECT o.id, o.name, o.suspended, m.role FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.email = ?`, e);
  const domain = e.split('@')[1];
  const own = q.get('SELECT org_id FROM domains WHERE domain = ?', domain);
  if (own && !orgs.some((o) => o.id === own.org_id)) {
    const o = q.get('SELECT id, name, suspended FROM orgs WHERE id = ?', own.org_id);
    if (o) orgs.push({ ...o, role: 'user' });
  }
  return { superAdmin: config.superAdmins.includes(e), orgs };
}

export function userSetting(email, key, fallback) {
  const r = q.get('SELECT value FROM user_settings WHERE email = ? AND key = ?', email.toLowerCase(), key);
  return r ? JSON.parse(r.value) : fallback;
}
export function setUserSetting(email, key, value) {
  q.run('INSERT INTO user_settings(email, key, value) VALUES(?, ?, ?) ON CONFLICT(email, key) DO UPDATE SET value = excluded.value',
    email.toLowerCase(), key, JSON.stringify(value));
}
export function security(email) {
  const e = email.toLowerCase();
  let r = q.get('SELECT * FROM user_security WHERE email = ?', e);
  if (!r) { q.run('INSERT OR IGNORE INTO user_security(email) VALUES(?)', e); r = q.get('SELECT * FROM user_security WHERE email = ?', e); }
  return r;
}

/** 2-step verification policy for a user: is it on, and is it required for them? */
export function twoFactorPolicy(email) {
  const e = email.toLowerCase();
  const sec = q.get('SELECT totp_enabled FROM user_security WHERE email = ?', e);
  const org = q.get("SELECT o.require_2fa FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ? AND d.status = 'active'", e.split('@')[1]);
  return { enabled: !!sec?.totp_enabled, requiredByOrg: !!org?.require_2fa };
}
