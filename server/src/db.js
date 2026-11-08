// App database. One server: SQLite file in DATA_DIR (default). Several servers: PostgreSQL (set DATABASE_URL).
// Everything goes through the async q.get / q.all / q.run / q.insert helpers, written in SQLite syntax;
// for PostgreSQL the few differences (placeholders, dates, upserts, auto ids) are translated automatically.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `CREATE TABLE IF NOT EXISTS orgs (
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
CREATE TABLE IF NOT EXISTS sig_assets (name TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sending_holds (
  email TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, evidence TEXT, at INTEGER NOT NULL, lifted_by TEXT
);
CREATE TABLE IF NOT EXISTS abuse_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, offender TEXT NOT NULL, reporter TEXT, details TEXT, headers TEXT, ip TEXT,
  at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS abuse_reports_offender ON abuse_reports(offender, at);
CREATE TABLE IF NOT EXISTS shared_mailboxes (
  email TEXT PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT, creds TEXT NOT NULL, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shared_access (
  mailbox TEXT NOT NULL, member TEXT NOT NULL, can_send INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (mailbox, member)
);
CREATE INDEX IF NOT EXISTS shared_access_member ON shared_access(member);
CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, creds TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_email ON push_subs(email);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
  name TEXT, creds TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_email ON passkeys(email);
CREATE TABLE IF NOT EXISTS premium (email TEXT PRIMARY KEY, customer TEXT, subscription TEXT, status TEXT NOT NULL DEFAULT 'none', billing_interval TEXT, until INTEGER, domain_org INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS ai_usage (email TEXT NOT NULL, month TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (email, month));
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, account TEXT, topic TEXT, message TEXT, ip TEXT, at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS mailbox_ids (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, kind TEXT NOT NULL, account_no TEXT, mailbox_no INTEGER,
  status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mailbox_ids_email ON mailbox_ids(email, status);
-- Stable user id, separate from the address and from the public mailbox URL ID (ready for single sign-on)
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
-- First sign-in setup state (temporary password must be replaced; 2-step verification reminders)
CREATE TABLE IF NOT EXISTS account_setup (
  email TEXT PRIMARY KEY, must_change_password INTEGER NOT NULL DEFAULT 0, twofa_snoozes INTEGER NOT NULL DEFAULT 0,
  twofa_snooze_until INTEGER NOT NULL DEFAULT 0, onboarded_at INTEGER, source TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS send_counts (email TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (email, day));
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  due_at INTEGER, remind_at INTEGER, reminded INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
  msg_key TEXT, msg_subject TEXT, msg_mailbox TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_email ON tasks(email, done_at);
CREATE INDEX IF NOT EXISTS tasks_remind ON tasks(remind_at, reminded);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, body TEXT NOT NULL, contact TEXT, thread TEXT, thread_subject TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_email ON notes(email, contact);
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, message_id TEXT NOT NULL, subject TEXT, recipients TEXT,
  creds TEXT NOT NULL, remind_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', checked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS followups_due ON followups(status, remind_at);
CREATE TABLE IF NOT EXISTS import_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT, remote_user TEXT, remote_host TEXT,
  syncjob_id TEXT, creds TEXT, state TEXT, status TEXT NOT NULL DEFAULT 'active', messages_found INTEGER, messages_copied INTEGER,
  last_error TEXT, first_done_at INTEGER, next_run INTEGER, created_at INTEGER NOT NULL, stop_at INTEGER NOT NULL, created_by TEXT
);
CREATE INDEX IF NOT EXISTS import_records_email ON import_records(email, status);
CREATE TABLE IF NOT EXISTS send_tiers (email TEXT PRIMARY KEY, tier TEXT NOT NULL, applied_at INTEGER NOT NULL);
`;

// Columns added after the first release: [table, column, definition]
const MIGRATIONS = [['orgs', 'require_2fa', 'INTEGER NOT NULL DEFAULT 0'], ['orgs', 'allow_external_forward', 'INTEGER NOT NULL DEFAULT 0'], ['signups', 'terms_version', 'TEXT'],
  ['orgs', 'plan', "TEXT NOT NULL DEFAULT 'standard'"], ['orgs', 'billing_interval', 'TEXT'], ['orgs', 'stripe_customer', 'TEXT'],
  ['orgs', 'stripe_subscription', 'TEXT'], ['orgs', 'billing_status', "TEXT NOT NULL DEFAULT 'none'"], ['orgs', 'paid_seats', 'INTEGER NOT NULL DEFAULT 0'],
  ['orgs', 'canceled_at', 'TEXT'],
  ['user_security', 'recovery_verified', 'INTEGER NOT NULL DEFAULT 0'], ['user_security', 'recovery_pending', 'TEXT'],
  ['user_security', 'recovery_code', 'TEXT'], ['user_security', 'recovery_code_exp', 'INTEGER'], ['user_security', 'recovery_code_tries', 'INTEGER NOT NULL DEFAULT 0'], ['jobs', 'claimed_at', 'INTEGER'], ['shared_mailboxes', 'kind', "TEXT NOT NULL DEFAULT 'shared'"], ['orgs', 'account_no', 'TEXT'], ['password_resets', 'kind', "TEXT NOT NULL DEFAULT 'reset'"], ['password_resets', 'invite_to', 'TEXT'], ['sessions', 'user_id', 'TEXT'], ['sessions', 'remember', 'INTEGER NOT NULL DEFAULT 0'], ['signups', 'phone_hash', 'TEXT'], ['orgs', 'comp_until', 'INTEGER'], ['orgs', 'comp_note', 'TEXT'], ['orgs', 'comp_by', 'TEXT'], ['orgs', 'comp_warned', 'INTEGER NOT NULL DEFAULT 0'], ['domains', 'owner_local', 'TEXT'], ['domains', 'owner_mailbox', 'TEXT'], ['user_security', 'birthday', 'TEXT'], ['user_security', 'phone', 'TEXT'], ['user_security', 'push_preview', 'INTEGER NOT NULL DEFAULT 1'], ['user_security', 'ai_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['user_security', 'premium_until', 'INTEGER'], ['orgs', 'ai_blocked', 'INTEGER NOT NULL DEFAULT 0']];

// Indexes on migrated columns (run after MIGRATIONS)
const AFTER = ['CREATE UNIQUE INDEX IF NOT EXISTS orgs_account_no ON orgs(account_no)'];

// ---------------------------------------------------------------- SQLite
async function sqliteDriver() {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, col, def] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  for (const sql of AFTER) db.exec(sql);
  const stmts = new Map();
  const prep = (sql) => {
    let st = stmts.get(sql);
    if (!st) { st = db.prepare(sql); if (stmts.size < 500) stmts.set(sql, st); }
    return st;
  };
  return {
    dialect: 'sqlite', raw: db,
    get: async (sql, a) => prep(sql).get(...a),
    all: async (sql, a) => prep(sql).all(...a),
    run: async (sql, a) => ({ changes: Number(prep(sql).run(...a).changes) }),
    insert: async (sql, a) => Number(prep(sql).run(...a).lastInsertRowid),
    close: async () => db.close(),
  };
}

// ---------------------------------------------------------------- PostgreSQL
const PG_NOW = "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')";
export function toPgSchema(sql) {
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bINTEGER\b/g, 'BIGINT') // millisecond timestamps don't fit in 32 bits
    .replace(/\bBLOB\b/g, 'BYTEA')
    .replace(/\(datetime\('now'\)\)/g, `(${PG_NOW})`);
}
/** Translate a SQLite-syntax query to PostgreSQL. */
export function toPg(sql) {
  let s = sql
    .replace(/datetime\('now'\s*,\s*(\?|'[^']*')\)/g, (m, x) => `to_char(timezone('UTC', now()) + CAST(${x} AS interval), 'YYYY-MM-DD HH24:MI:SS')`)
    .replace(/datetime\('now'\)/g, PG_NOW)
    .replace(/date\('now'\s*,\s*(\?|'[^']*')\)/g, (m, x) => `to_char(timezone('UTC', now()) + CAST(${x} AS interval), 'YYYY-MM-DD')`)
    .replace(/date\('now'\)/g, "to_char(timezone('UTC', now()), 'YYYY-MM-DD')");
  if (/^\s*INSERT OR IGNORE INTO/i.test(s)) s = `${s.replace(/INSERT OR IGNORE INTO/i, 'INSERT INTO')} ON CONFLICT DO NOTHING`;
  // ? placeholders -> $1, $2 ... (skipping anything inside quotes)
  let n = 0; let out = ''; let quote = null;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

async function pgDriver(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT -> number (all our values < 2^53)
  // 'pg-env': connection details come from PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE (as on ECS with RDS secrets)
  const fromEnv = url === 'pg-env';
  const host = fromEnv ? process.env.PGHOST : url;
  const local = /(^|@)(localhost|127\.0\.0\.1)([:/]|$)/.test(host) || /sslmode=disable/.test(url) || (fromEnv && process.env.PGSSLMODE === 'disable');
  const pool = new pg.Pool({
    ...(fromEnv ? {} : { connectionString: url }), max: Number(process.env.DATABASE_POOL || 20), idleTimeoutMillis: 30000,
    // Verified TLS; the image trusts Amazon RDS's certificate authority (NODE_EXTRA_CA_CERTS)
    ssl: local ? false : { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== 'true' },
  });
  // Only one app server at a time creates or upgrades the tables
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query(toPgSchema(SCHEMA));
    for (const [table, col, def] of MIGRATIONS) await c.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${toPgSchema(def)}`);
    for (const sql of AFTER) await c.query(sql);
    await c.query('SELECT pg_advisory_unlock(727001)');
  } finally { c.release(); }
  const cache = new Map();
  const tr = (sql) => {
    let t = cache.get(sql);
    if (!t) { t = toPg(sql); if (cache.size < 1000) cache.set(sql, t); }
    return t;
  };
  return {
    dialect: 'postgres', raw: pool,
    get: async (sql, a) => (await pool.query(tr(sql), a)).rows[0],
    all: async (sql, a) => (await pool.query(tr(sql), a)).rows,
    run: async (sql, a) => ({ changes: (await pool.query(tr(sql), a)).rowCount }),
    insert: async (sql, a) => Number((await pool.query(`${tr(sql)} RETURNING id`, a)).rows[0]?.id),
    close: () => pool.end(),
  };
}

const driver = config.databaseUrl ? await pgDriver(config.databaseUrl) : await sqliteDriver();
/** The underlying SQLite database (null on PostgreSQL). */
export const db = driver.dialect === 'sqlite' ? driver.raw : null;
export const dialect = driver.dialect;
const args = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
export const q = {
  get: (sql, ...a) => driver.get(sql, args(a)),
  all: (sql, ...a) => driver.all(sql, args(a)),
  run: (sql, ...a) => driver.run(sql, args(a)),
  /** INSERT into a table with an auto id; returns the new id. */
  insert: (sql, ...a) => driver.insert(sql, args(a)),
  close: () => driver.close(),
};

export async function setting(key, fallback) {
  const r = await q.get('SELECT value FROM settings WHERE key = ?', key);
  return r ? JSON.parse(r.value) : fallback;
}
export async function setSetting(key, value) {
  await q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
export async function audit(actor, orgId, action, detail = {}) {
  await q.run('INSERT INTO audit(actor, org_id, action, detail) VALUES(?, ?, ?, ?)', actor, orgId ?? null, action, JSON.stringify(detail));
}

/** The stable user id for a mailbox address (created on first use; never changes, never reused). */
export async function userIdFor(email) {
  const e = String(email).toLowerCase();
  const r = await q.get('SELECT id FROM users WHERE email = ?', e);
  if (r) return r.id;
  const { randomUUID } = await import('node:crypto');
  await q.run('INSERT INTO users(id, email, created_at) VALUES(?, ?, ?) ON CONFLICT(email) DO NOTHING', randomUUID(), e, Date.now());
  return (await q.get('SELECT id FROM users WHERE email = ?', e)).id;
}

/** Roles for an email: super admin + org memberships. */
export async function rolesFor(email) {
  const e = email.toLowerCase();
  const orgs = await q.all(`SELECT o.id, o.name, o.suspended, m.role FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.email = ?`, e);
  const domain = e.split('@')[1];
  const own = await q.get('SELECT org_id FROM domains WHERE domain = ?', domain);
  if (own && !orgs.some((o) => o.id === own.org_id)) {
    const o = await q.get('SELECT id, name, suspended FROM orgs WHERE id = ?', own.org_id);
    if (o) orgs.push({ ...o, role: 'user' });
  }
  return { superAdmin: config.superAdmins.includes(e), orgs };
}

export async function userSetting(email, key, fallback) {
  const r = await q.get('SELECT value FROM user_settings WHERE email = ? AND key = ?', email.toLowerCase(), key);
  return r ? JSON.parse(r.value) : fallback;
}
export async function setUserSetting(email, key, value) {
  await q.run('INSERT INTO user_settings(email, key, value) VALUES(?, ?, ?) ON CONFLICT(email, key) DO UPDATE SET value = excluded.value',
    email.toLowerCase(), key, JSON.stringify(value));
}
export async function security(email) {
  const e = email.toLowerCase();
  let r = await q.get('SELECT * FROM user_security WHERE email = ?', e);
  if (!r) { await q.run('INSERT OR IGNORE INTO user_security(email) VALUES(?)', e); r = await q.get('SELECT * FROM user_security WHERE email = ?', e); }
  return r;
}

/** 2-step verification policy for a user: is it on, and is it required for them? */
export async function twoFactorPolicy(email) {
  const e = email.toLowerCase();
  const sec = await q.get('SELECT totp_enabled FROM user_security WHERE email = ?', e);
  const org = await q.get("SELECT o.require_2fa FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ? AND d.status = 'active'", e.split('@')[1]);
  return { enabled: !!sec?.totp_enabled, requiredByOrg: !!org?.require_2fa };
}
