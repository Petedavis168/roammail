// Operations: request metrics (Prometheus /metrics + CloudWatch embedded metrics in the logs),
// a public status page, and a super-admin status notice.
import express from 'express';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, rolesFor, audit, setting, setSetting } from './db.js';
import { requireAuth } from './session.js';

const started = Date.now();
const counters = { requests: 0, s2: 0, s3: 0, s4: 0, s5: 0, logins_ok: 0, logins_failed: 0, mail_sent: 0 };
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const hist = new Array(BUCKETS.length + 1).fill(0); let latSum = 0;
let window = { requests: 0, errors: 0, latencies: [] };
const gauges = new Map(); // name -> () => number

export const count = (name, n = 1) => { counters[name] = (counters[name] || 0) + n; };
export const gauge = (name, fn) => gauges.set(name, fn);

export function metricsMiddleware(req, res, next) {
  if (!req.path.startsWith('/api/') || req.path === '/api/events') return next();
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const s = Number(process.hrtime.bigint() - t0) / 1e9;
    counters.requests++; counters[`s${String(res.statusCode)[0]}`] = (counters[`s${String(res.statusCode)[0]}`] || 0) + 1;
    let i = BUCKETS.findIndex((b) => s <= b); if (i < 0) i = BUCKETS.length; hist[i]++; latSum += s;
    window.requests++; if (res.statusCode >= 500) window.errors++;
    if (window.latencies.length < 20000) window.latencies.push(s * 1000);
  });
  next();
}

function prometheus() {
  const lines = [];
  const m = (name, type, value, help) => { lines.push(`# HELP roammail_${name} ${help}`, `# TYPE roammail_${name} ${type}`, `roammail_${name} ${value}`); };
  m('uptime_seconds', 'gauge', Math.round((Date.now() - started) / 1000), 'Seconds since start');
  lines.push('# HELP roammail_http_requests_total API requests by status class', '# TYPE roammail_http_requests_total counter');
  for (const c of ['2', '3', '4', '5']) lines.push(`roammail_http_requests_total{class="${c}xx"} ${counters[`s${c}`] || 0}`);
  lines.push('# HELP roammail_http_request_seconds API latency', '# TYPE roammail_http_request_seconds histogram');
  let cum = 0;
  BUCKETS.forEach((b, i) => { cum += hist[i]; lines.push(`roammail_http_request_seconds_bucket{le="${b}"} ${cum}`); });
  cum += hist[BUCKETS.length];
  lines.push(`roammail_http_request_seconds_bucket{le="+Inf"} ${cum}`, `roammail_http_request_seconds_sum ${latSum.toFixed(3)}`, `roammail_http_request_seconds_count ${cum}`);
  for (const k of ['logins_ok', 'logins_failed', 'mail_sent']) m(`${k}_total`, 'counter', counters[k] || 0, k.replace('_', ' '));
  for (const [k, fn] of gauges) { try { m(k, 'gauge', Number(fn()) || 0, k); } catch { /* skip */ } }
  const mem = process.memoryUsage();
  m('memory_rss_bytes', 'gauge', mem.rss, 'Resident memory');
  m('heap_used_bytes', 'gauge', mem.heapUsed, 'Heap in use');
  return `${lines.join('\n')}\n`;
}

// Every minute, write one CloudWatch "embedded metric format" log line. CloudWatch turns it into metrics
// automatically (no agent or extra permissions), which the dashboard and alarms in template.yaml use.
export function startMetricsLog() {
  if (process.env.METRICS_LOG === 'false') return;
  setInterval(() => {
    const w = window; window = { requests: 0, errors: 0, latencies: [] };
    const lat = w.latencies.sort((a, b) => a - b);
    const p = (x) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * x))] : 0);
    const g = {}; for (const [k, fn] of gauges) { try { g[k] = Number(fn()) || 0; } catch { g[k] = 0; } }
    const metrics = { Requests: w.requests, ServerErrors: w.errors, LatencyP50: p(0.5), LatencyP95: p(0.95), LatencyP99: p(0.99), MemoryMB: Math.round(process.memoryUsage().rss / 1048576), ...g };
    console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: process.env.METRICS_NAMESPACE || 'Roammail', Dimensions: [[]], Metrics: Object.keys(metrics).map((Name) => ({ Name, Unit: Name.startsWith('Latency') ? 'Milliseconds' : 'Count' })) }] },
      ...metrics,
    }));
  }, 60_000).unref();
}

// ---------------------------------------------------------------- health checks for the status page
function tcpCheck(host, port, secure, timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (ok) => { try { sock.destroy(); } catch { /* */ } resolve({ ok, ms: Date.now() - t0 }); };
    const sock = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized: config.tlsRejectUnauthorized }) : net.connect({ host, port });
    sock.setTimeout(timeout, () => done(false));
    sock.once('error', () => done(false));
    sock.once('data', (d) => done(/^(\* OK|220)/.test(String(d))));
  });
}
async function mailcowCheck() {
  const t0 = Date.now();
  try {
    const r = await fetch(`${config.mailcow.url}/api/v1/get/status/version`, { headers: { 'X-API-Key': config.mailcow.apiKey }, signal: AbortSignal.timeout(5000) });
    return { ok: r.ok, ms: Date.now() - t0 };
  } catch { return { ok: false, ms: Date.now() - t0 }; }
}
let statusCache = { at: 0, value: null };
export async function systemStatus() {
  if (Date.now() - statusCache.at < 30_000 && statusCache.value) return statusCache.value;
  const [imap, smtp, admin] = await Promise.all([
    tcpCheck(config.imap.host, config.imap.port, config.imap.secure),
    tcpCheck(config.smtp.host, config.smtp.port, config.smtp.secure),
    mailcowCheck(),
  ]);
  let db = true; try { await q.get('SELECT 1'); } catch { db = false; }
  const components = [
    { name: 'Web app', ok: db },
    { name: 'Receiving and reading mail', ok: imap.ok },
    { name: 'Sending mail', ok: smtp.ok },
    { name: 'Sign-up and account management', ok: admin.ok },
  ];
  let notice = null; try { notice = JSON.parse(await setting('status_notice') || 'null'); } catch { /* */ }
  const value = { ok: components.every((c) => c.ok), components, notice, checked: new Date().toISOString() };
  statusCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- routes
export const ops = express.Router();

ops.get('/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.get('X-Forwarded-For');
  const given = String(req.get('Authorization') || '').replace(/^Bearer /, '');
  const ok = token ? given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token)) : local;
  if (!ok) return res.status(404).end();
  res.type('text/plain; version=0.0.4').send(prometheus());
});

ops.get('/api/status', async (req, res) => { const s = await systemStatus(); res.set('Cache-Control', 'public, max-age=30').status(s.ok ? 200 : 503).json(s); });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
ops.get('/status', async (req, res) => {
  const s = await systemStatus();
  res.set('Cache-Control', 'public, max-age=30').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>${esc(config.appName)} status</title><link rel="icon" href="/favicon.png">
<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:6vh auto;padding:0 20px;color:#242424}h1{color:#244960;display:flex;align-items:center;gap:10px}.b{padding:14px 18px;border-radius:10px;color:#fff;font-weight:600;margin:18px 0}.ok{background:#1e7d4f}.bad{background:#b3261e}.n{background:#fff4ce;border:1px solid #e8d48a;padding:12px 16px;border-radius:8px;margin:12px 0}ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;padding:12px 4px;border-bottom:1px solid #eee}.g{color:#1e7d4f}.r{color:#b3261e}small{color:#888}</style></head>
<body><h1><img src="/roammail-mark.png" alt="" height="36"> ${esc(config.appName)} status</h1>
<div class="b ${s.ok ? 'ok' : 'bad'}">${s.ok ? 'All systems are working normally' : 'Some services are having problems. We\'re on it.'}</div>
${s.notice ? `<div class="n"><b>${esc(s.notice.title)}</b><br>${esc(s.notice.body)}<br><small>Updated ${esc(new Date(s.notice.at).toUTCString())}</small></div>` : ''}
<ul>${s.components.map((c) => `<li>${esc(c.name)}<span class="${c.ok ? 'g' : 'r'}">${c.ok ? 'Working' : 'Problem'}</span></li>`).join('')}</ul>
<small>Checked ${esc(new Date(s.checked).toUTCString())}. This page refreshes every minute.</small></body></html>`);
});

ops.put('/api/super/status-notice', requireAuth, async (req, res) => {
  if (!(await rolesFor(req.user.email)).superAdmin) return res.status(403).json({ error: 'Super-admin only' });
  const title = String(req.body.title || '').trim().slice(0, 120); const body = String(req.body.body || '').trim().slice(0, 2000);
  await setSetting('status_notice', title ? JSON.stringify({ title, body, at: Date.now() }) : 'null');
  statusCache.at = 0;
  await audit(req.user.email, null, 'status.notice', { title });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- nightly consistent copy of the app database
// EBS snapshots capture the disk, but a snapshot taken mid-write can catch SQLite half-way; this keeps a
// clean copy (VACUUM INTO is atomic and consistent) for the last 7 days next to it.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
export function backupDatabase(dir = path.join(config.dataDir, 'backups'), keep = 7) {
  if (!db) return null; // PostgreSQL: use the database service's own backups (RDS automated backups)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `app-${new Date().toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(file)) return file;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);
  const old = fs.readdirSync(dir).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return file;
}
export function startDbBackups() {
  const run = () => { try { backupDatabase(); } catch (e) { console.error('APP_ERROR database backup failed', e.message); } };
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 3600e3).unref();
}
