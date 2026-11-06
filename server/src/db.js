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
