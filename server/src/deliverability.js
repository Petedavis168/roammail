// Deliverability dashboard (super-admins): are our emails reaching inboxes?
//  - our own numbers: delivered / bounced / deferred by provider, complaints, paused accounts (daily, 90 days kept)
//  - blocklists for the mail server IPs
//  - DNS health of the sending domain: SPF, DKIM, DMARC, MTA-STS, TLS reporting, reverse DNS
//  - Google Postmaster Tools (spam rate and reputation as Gmail sees us), when connected:
//      GOOGLE_POSTMASTER_CLIENT_ID, GOOGLE_POSTMASTER_CLIENT_SECRET, GOOGLE_POSTMASTER_REFRESH_TOKEN
//  - Microsoft SNDS (how Outlook.com sees our IPs), when connected: SNDS_KEY (the "automated data access" key)
import express from 'express';
import { Resolver } from 'node:dns/promises';
import { config } from './config.js';
import { q, rolesFor } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import { buildReport } from './reputation.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers((process.env.DNS_SERVERS || '1.1.1.1,8.8.8.8').split(','));
const txt = async (name) => { try { return (await resolver.resolveTxt(name)).map((c) => c.join('')); } catch { return []; } };
const mailIps = () => String(process.env.MAIL_SERVER_IPS || '').split(',').map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
const memo = new Map();
async function cached(key, ms, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- DNS health
const check = (name, ok, found, fix, level = ok ? 'good' : 'bad') => ({ name, ok, level, found, fix: ok ? null : fix });
export async function domainHealth(domain) {
  const out = [];
  const host = config.mailHostname;
  const spf = (await txt(domain)).filter((t) => /^v=spf1\b/i.test(t));
  out.push(spf.length === 1
    ? check('SPF', /\b(mx|a:|include:|ip4:)/i.test(spf[0]) && /[-~]all\b/i.test(spf[0]), spf[0], `SPF should allow our server and end in "~all" or "-all": v=spf1 mx a:${host} ~all`)
    : check('SPF', false, spf.join(' | ') || 'none', spf.length ? 'There must be exactly one SPF record' : `Add TXT on ${domain}: v=spf1 mx a:${host} ~all`));
  let dkim = null; try { dkim = await mailcow.getDkim(domain); } catch { /* not on this server */ }
  if (dkim?.selector) {
    const pub = (await txt(`${dkim.selector}._domainkey.${domain}`)).join('');
    out.push(check('DKIM', /p=[A-Za-z0-9+/]{100,}/.test(pub), pub ? `${dkim.selector}._domainkey (${pub.length} chars)` : 'not published', `Publish the DKIM key as TXT on ${dkim.selector}._domainkey.${domain}`));
  } else out.push(check('DKIM', false, 'no key on the mail server', 'Create a DKIM key in mailcow for this domain'));
  const dmarc = (await txt(`_dmarc.${domain}`)).find((t) => /^v=DMARC1/i.test(t));
  const policy = /\bp=(none|quarantine|reject)/i.exec(dmarc || '')?.[1]?.toLowerCase();
  out.push(!dmarc ? check('DMARC', false, 'none', `Add TXT on _dmarc.${domain}: v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`)
    : { ...check('DMARC', policy !== 'none', dmarc, 'p=none only watches. Gmail and Yahoo trust p=quarantine or p=reject more.'), level: policy === 'none' ? 'warn' : 'good' });
  if (dmarc && !/\brua=/i.test(dmarc)) out.push({ ...check('DMARC reports', false, 'no rua=', 'Add rua=mailto:postmaster@… to get daily reports from Gmail, Microsoft and Yahoo'), level: 'warn' });
  const sts = (await txt(`_mta-sts.${domain}`)).find((t) => /^v=STSv1/i.test(t));
  out.push({ ...check('MTA-STS', !!sts, sts || 'none', `Optional: forces encrypted delivery to ${domain}. Needs _mta-sts TXT and https://mta-sts.${domain}/.well-known/mta-sts.txt`), level: sts ? 'good' : 'warn' });
  const tlsrpt = (await txt(`_smtp._tls.${domain}`)).find((t) => /^v=TLSRPTv1/i.test(t));
  out.push({ ...check('TLS reports', !!tlsrpt, tlsrpt || 'none', `Optional: TXT on _smtp._tls.${domain}: v=TLSRPTv1; rua=mailto:postmaster@${domain}`), level: tlsrpt ? 'good' : 'warn' });
  for (const ip of mailIps()) {
    let ptr = []; try { ptr = await resolver.reverse(ip); } catch { /* none */ }
    let forward = []; try { forward = ptr[0] ? await resolver.resolve4(ptr[0]) : []; } catch { /* none */ }
    out.push(check(`Reverse DNS ${ip}`, ptr.length > 0 && forward.includes(ip), ptr.join(', ') || 'none', `Ask AWS to set reverse DNS of ${ip} to ${host} (and ${host} must point back to ${ip})`));
  }
  return out;
}

// ---------------------------------------------------------------- Google Postmaster Tools
const gp = () => ({ id: process.env.GOOGLE_POSTMASTER_CLIENT_ID, secret: process.env.GOOGLE_POSTMASTER_CLIENT_SECRET, refresh: process.env.GOOGLE_POSTMASTER_REFRESH_TOKEN });
export async function googlePostmaster(domain) {
  const c = gp();
  if (!c.id || !c.secret || !c.refresh) return { connected: false };
  const tok = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: c.refresh, grant_type: 'refresh_token' }) }).then((r) => r.json());
  if (!tok.access_token) return { connected: true, error: 'Google did not accept the sign-in. Connect Postmaster Tools again.' };
  const r = await fetch(`https://gmailpostmastertools.googleapis.com/v1/domains/${encodeURIComponent(domain)}/trafficStats?pageSize=30`, { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { connected: true, error: j.error?.message || `Google said ${r.status}` };
  const days = (j.trafficStats || []).map((d) => ({
    day: /(\d{8})$/.exec(d.name || '')?.[1]?.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') || null,
    spamRate: d.userReportedSpamRatio ?? null,
    domainReputation: d.domainReputation || null,
    ipReputation: (d.ipReputations || []).reduce((best, x) => (x.ipCount > (best?.ipCount || 0) ? x : best), null)?.reputation || null,
    spf: d.spfSuccessRatio ?? null, dkim: d.dkimSuccessRatio ?? null, dmarc: d.dmarcSuccessRatio ?? null,
    tls: d.inboundEncryptionRatio ?? null,
  })).filter((d) => d.day).sort((a, b) => a.day.localeCompare(b.day));
  return { connected: true, days, note: days.length ? null : 'Google only shows data once enough mail reaches Gmail users each day (a few hundred).' };
}

// ---------------------------------------------------------------- Microsoft SNDS
export function parseSnds(csv) {
  return String(csv || '').split(/\r?\n/).map((l) => l.split(',')).filter((c) => c.length >= 8 && /^\d+\.\d+\.\d+\.\d+$/.test(c[0])).map((c) => ({
    ip: c[0], from: c[1], to: c[2], rcpt: Number(c[3]) || 0, data: Number(c[4]) || 0, recipients: Number(c[5]) || 0,
    filter: String(c[6] || '').toUpperCase(), complaintRate: c[7] || null, trapHits: Number(c[10]) || 0,
  }));
}
export async function microsoftSnds() {
  const key = process.env.SNDS_KEY;
  if (!key) return { connected: false };
  const r = await fetch(`https://sendersupport.olc.protection.outlook.com/snds/data.aspx?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return { connected: true, error: `Microsoft said ${r.status}` };
  const rows = parseSnds(await r.text());
  return { connected: true, rows, note: rows.length ? null : 'Microsoft shows data once an IP sends to Outlook.com, Hotmail or Live users.' };
}

// ---------------------------------------------------------------- daily history
export async function recordDay(r) {
  const day = new Date(r.at - 864e5 / 2).toISOString().slice(0, 10); // the report covers the last 24h: mostly yesterday
  const d = r.delivery || {};
  await q.run(`INSERT INTO deliverability_days(day, sent, bounced, deferred, complaints, listed, held, by_provider) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET sent = excluded.sent, bounced = excluded.bounced, deferred = excluded.deferred, complaints = excluded.complaints,
      listed = excluded.listed, held = excluded.held, by_provider = excluded.by_provider`,
  day, d.sent ?? null, d.bounced ?? null, d.deferred ?? null, r.complaints, r.listed, r.holds.length, JSON.stringify(d.byProvider || {}));
  await q.run('DELETE FROM deliverability_days WHERE day < ?', new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10));
}

export const deliverabilityApi = express.Router();
deliverabilityApi.get('/super/deliverability', requireAuth, wrap(async (req, res) => {
  if (!(await rolesFor(req.user.email)).superAdmin) return res.status(403).json({ error: 'Super-admin only' });
  const domain = String(req.query.domain || config.signup.domain || '').toLowerCase();
  if (!/^[a-z0-9.-]{3,253}$/.test(domain)) return res.status(400).json({ error: 'Pick a domain' });
  const fresh = req.query.refresh === '1';
  const ttl = fresh ? 0 : 15 * 60e3;
  const safe = (p) => p.catch((e) => ({ error: e.message }));
  const [today, health, google, microsoft] = await Promise.all([
    safe(cached('today', fresh ? 0 : 10 * 60e3, () => buildReport())),
    safe(cached(`health:${domain}`, ttl, () => domainHealth(domain))),
    safe(cached(`google:${domain}`, fresh ? 0 : 3 * 3600e3, () => googlePostmaster(domain))),
    safe(cached('snds', fresh ? 0 : 3 * 3600e3, () => microsoftSnds())),
  ]);
  const history = (await q.all('SELECT * FROM deliverability_days ORDER BY day DESC LIMIT 90')).reverse()
    .map((x) => ({ day: x.day, sent: x.sent, bounced: x.bounced, deferred: x.deferred, complaints: x.complaints, listed: x.listed, held: x.held, byProvider: JSON.parse(x.by_provider || '{}') }));
  const domains = [config.signup.domain, ...(await q.all("SELECT domain FROM domains WHERE status = 'active' ORDER BY domain LIMIT 200")).map((d) => d.domain)].filter(Boolean);
  res.json({ domain, domains: [...new Set(domains)], today, history, health, google, microsoft, mailIps: mailIps() });
}));
