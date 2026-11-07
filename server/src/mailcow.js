// Thin client for the mailcow REST API (https://mailcow.docs.apiary.io).
import { config } from './config.js';

class MailcowError extends Error {}

async function call(method, path, body) {
  if (!config.mailcow.apiKey) throw new MailcowError('MAILCOW_API_KEY is not configured on the server');
  const res = await fetch(`${config.mailcow.url}/api/v1/${path}`, {
    method,
    headers: { 'X-API-Key': config.mailcow.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new MailcowError(`mailcow API returned ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new MailcowError(data?.msg || `mailcow API error ${res.status}`);
  // Write calls return [{type: 'success'|'danger'|'error', msg: [...]}]
  if (Array.isArray(data) && data.length && data[0]?.type) {
    const bad = data.find((d) => d.type !== 'success' && d.type !== 'info');
    if (bad) {
      const msg = Array.isArray(bad.msg) ? bad.msg.join(' ') : String(bad.msg);
      throw new MailcowError(`mailcow: ${msg}`);
    }
  }
  return data;
}

const list = (d) => (Array.isArray(d) ? d : d && typeof d === 'object' && Object.keys(d).length ? [d] : []);
const MB = 1024 * 1024;

export const mailcow = {
  getDomain: async (domain) => list(await call('GET', `get/domain/${encodeURIComponent(domain)}`))[0] || null,
  addDomain: (domain, { description, mailboxes, defquota, maxquota, quota }) => call('POST', 'add/domain', {
    domain, description, aliases: 400, mailboxes, defquota, maxquota, quota,
    active: 1, backupmx: 0, relay_all_recipients: 0, restart_sogo: 10,
  }),
  editDomain: (domain, attr) => call('POST', 'edit/domain', { items: [domain], attr }),
  deleteDomain: (domain) => call('POST', 'delete/domain', [domain]),

  addDkim: (domain) => call('POST', 'add/dkim', { domains: domain, dkim_selector: 'dkim', key_size: 2048 }),
  getDkim: async (domain) => {
    const d = await call('GET', `get/dkim/${encodeURIComponent(domain)}`);
    return d && d.dkim_txt ? { txt: d.dkim_txt, selector: d.dkim_selector || 'dkim' } : null;
  },

  listMailboxes: async (domain) => list(await call('GET', `get/mailbox/all/${encodeURIComponent(domain)}`)).map((m) => ({
    email: m.username,
    name: m.name || '',
    active: Number(m.active) === 1 || m.active === '1',
    quotaMb: Math.round(Number(m.quota || 0) / MB),
    usedMb: Math.round(Number(m.quota_used || 0) / MB),
    messages: Number(m.messages || 0),
    lastLogin: m.last_imap_login ? Number(m.last_imap_login) * 1000 : null,
  })),
  getMailbox: async (email) => list(await call('GET', `get/mailbox/${encodeURIComponent(email)}`))[0] || null,
  addMailbox: ({ localPart, domain, name, password, quotaMb }) => call('POST', 'add/mailbox', {
    local_part: localPart, domain, name, password, password2: password, quota: quotaMb,
    active: 1, force_pw_update: 0, tls_enforce_in: 0, tls_enforce_out: 0,
  }),
  editMailbox: (email, attr) => call('POST', 'edit/mailbox', { items: [email], attr }),
  deleteMailbox: (email) => call('POST', 'delete/mailbox', [email]),

  setMailboxRateLimit: (email, value, frame) => call('POST', 'edit/rl-mbox', { items: [email], attr: { rl_value: String(value), rl_frame: frame } }),

  // Sieve filters
  listFilters: async (email) => list(await call('GET', `get/filters/all`)).filter((f) => f.username === email),
  addFilter: (email, desc, script, type = 'prefilter') => call('POST', 'add/filter', { username: email, filter_type: type, script_desc: desc, script_data: script, active: 1 }),
  editFilter: (id, attr) => call('POST', 'edit/filter', { items: [String(id)], attr }),
  deleteFilter: (id) => call('POST', 'delete/filter', [String(id)]),

  // IMAP import (sync jobs). mailcow 2026+ uses "sync sources" (source_id); older versions take host1/port1 directly.
  listSyncJobs: async (email) => list(await call('GET', 'get/syncjobs/all/no_log')).filter((j) => j.user2 === email),
  listSyncSources: async () => {
    try { return list(await call('GET', 'get/syncjob_source/all')); } catch { return null; } // null = old mailcow
  },
  addSyncSource: ({ name, host, port }) => call('POST', 'add/syncjob_source', { name, description: 'Created by webmail import', host, port, enc: 'SSL', verify_cert: 1, auth_type: 'PLAIN', scope: 'all' }),
  addSyncJob: async (email, { host, port, user, password }) => {
    const common = {
      username: email, user1: user, password1: password, mins_interval: 20, subfolder2: '', maxage: 0, maxbytespersecond: 0,
      timeout1: 600, timeout2: 600, exclude: '(?i)spam|(?i)junk|(?i)trash|(?i)bin|(?i)all mail|(?i)important|(?i)starred',
      delete2duplicates: 1, delete1: 0, delete2: 0, automap: 1, skipcrossduplicates: 1, subscribeall: 1, active: 1,
    };
    const sources = await mailcow.listSyncSources();
    if (sources === null) return call('POST', 'add/syncjob', { ...common, host1: host, port1: port, enc1: 'SSL', custom_params: '' });
    const find = (all) => all.find((x) => String(x.host).toLowerCase() === host && Number(x.port) === Number(port) && x.auth_type !== 'XOAUTH2');
    let src = find(sources);
    if (!src) {
      await mailcow.addSyncSource({ name: `Import ${host}:${port}`, host, port });
      src = find((await mailcow.listSyncSources()) || []);
      if (!src) throw new Error('mailcow did not create the import source');
    }
    return call('POST', 'add/syncjob', { ...common, source_id: Number(src.id), custom_params: [] });
  },
  editSyncJob: (id, attr) => call('POST', 'edit/syncjob', { items: [String(id)], attr }),
  deleteSyncJob: (id) => call('POST', 'delete/syncjob', [String(id)]),

  // ---- spam filter (rspamd via mailcow)
  getSpamScore: async (email) => {
    const r = await call('GET', `get/spam-score/${encodeURIComponent(email)}`);
    const v = String((Array.isArray(r) ? r[0] : r)?.score || '').split(',').map(Number);
    return v.length === 2 && v.every((n) => !Number.isNaN(n)) ? { low: v[0], high: v[1] } : null;
  },
  setSpamScore: (emails, score) => call('POST', 'edit/spam-score', { items: [].concat(emails), attr: { spam_score: score } }),
  // Safe (wl) / blocked (bl) senders. Mailbox lists also include the domain-wide entries (object = domain).
  getMailboxPolicy: async (email) => ({
    wl: list(await call('GET', `get/policy_wl_mailbox/${encodeURIComponent(email)}`)),
    bl: list(await call('GET', `get/policy_bl_mailbox/${encodeURIComponent(email)}`)),
  }),
  getDomainPolicy: async (domain) => ({
    wl: list(await call('GET', `get/policy_wl_domain/${encodeURIComponent(domain)}`)),
    bl: list(await call('GET', `get/policy_bl_domain/${encodeURIComponent(domain)}`)),
  }),
  addMailboxPolicy: (email, kind, from) => call('POST', 'add/mailbox-policy', { username: email, object_list: kind, object_from: from }),
  addDomainPolicy: (domain, kind, from) => call('POST', 'add/domain-policy', { domain, object_list: kind, object_from: from }),
  deleteMailboxPolicy: (prefids) => call('POST', 'delete/mailbox-policy', [].concat(prefids).map(String)),
  deleteDomainPolicy: (prefids) => call('POST', 'delete/domain-policy', [].concat(prefids).map(String)),
  // Quarantine (definite spam held by the server)
  listQuarantine: async () => list(await call('GET', 'get/quarantine/all')).map((x) => ({
    id: Number(x.id), qid: x.qid, subject: x.subject || '(no subject)', sender: x.sender || '', rcpt: String(x.rcpt || '').toLowerCase(),
    score: Number(x.score), virus: Number(x.virus_flag) > 0, action: x.action, created: Number(x.created) * 1000, notified: Number(x.notified) === 1,
  })),
  quarantineItem: async (id) => (await call('GET', `get/quarantine/${encodeURIComponent(id)}`)) || null,
  quarantineAction: (ids, action) => call('POST', 'edit/qitem', { items: [].concat(ids).map(String), attr: { action } }),
  deleteQuarantine: (ids) => call('POST', 'delete/qitem', [].concat(ids).map(String)),
  setQuarantineNotification: (emails, freq) => call('POST', 'edit/quarantine_notification', { items: [].concat(emails), attr: { quarantine_notification: freq } }),
  setQuarantineCategory: (emails, cat) => call('POST', 'edit/quarantine_category', { items: [].concat(emails), attr: { quarantine_category: cat } }),

  listAliases: async (domain) => list(await call('GET', 'get/alias/all'))
    .filter((a) => a.domain === domain || String(a.address).endsWith(`@${domain}`))
    .map((a) => ({ id: a.id, address: a.address, goto: a.goto, active: Number(a.active) === 1, internal: Number(a.internal) === 1, senderAllowed: Number(a.sender_allowed) === 1 })),
  addAlias: (address, goto, opts = {}) => call('POST', 'add/alias', {
    address, goto, active: 1, internal: opts.internal ? 1 : 0, sender_allowed: opts.senderAllowed ? 1 : 0,
    ...(opts.comment ? { public_comment: opts.comment } : {}),
  }),
  editAlias: (id, attr) => call('POST', 'edit/alias', { items: [String(id)], attr }),
  deleteAlias: (id) => call('POST', 'delete/alias', [String(id)]),
};

// ---------------------------------------------------------------- caching for hot read paths
// Mailbox lists and the quarantine are read on almost every admin/spam page; mailcow returns the whole
// list each time, so we keep a short-lived shared copy and drop it whenever we change something.
import { createCache } from './cache.js';
import { broadcast, onBroadcast } from './shared.js';
export const mailcowCache = createCache({ ttlMs: Number(process.env.MAILCOW_CACHE_SECONDS || 60) * 1000, max: 2000 });
onBroadcast('mailcow-cache-del', (key) => mailcowCache.delete(key));
const forget = (key) => broadcast('mailcow-cache-del', key);
const raw = { ...mailcow };
const domainOf = (e) => String(e || '').split('@')[1]?.toLowerCase() || '';
const dropBoxes = (domain) => forget(`boxes:${domain}`);

mailcow.listMailboxes = (domain) => mailcowCache.get(`boxes:${String(domain).toLowerCase()}`, () => raw.listMailboxes(domain));
mailcow.addMailbox = async (o) => { try { return await raw.addMailbox(o); } finally { dropBoxes(String(o.domain).toLowerCase()); } };
mailcow.editMailbox = async (email, attr) => { try { return await raw.editMailbox(email, attr); } finally { for (const e of [].concat(email)) dropBoxes(domainOf(e)); } };
mailcow.deleteMailbox = async (email) => { try { return await raw.deleteMailbox(email); } finally { dropBoxes(domainOf(email)); } };

// Quarantine: one fetch shared by everyone, indexed by recipient and by recipient domain.
async function quarantineIndex() {
  return mailcowCache.get('quarantine', async () => {
    const items = (await raw.listQuarantine()).sort((a, b) => b.created - a.created);
    const byRcpt = new Map(); const byDomain = new Map(); const byId = new Map();
    for (const x of items) {
      if (!byRcpt.has(x.rcpt)) byRcpt.set(x.rcpt, []);
      byRcpt.get(x.rcpt).push(x);
      const d = domainOf(x.rcpt);
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(x);
      byId.set(String(x.id), x);
    }
    return { items, byRcpt, byDomain, byId };
  }, Number(process.env.QUARANTINE_CACHE_SECONDS || 60) * 1000);
}
mailcow.listQuarantine = async () => (await quarantineIndex()).items;
mailcow.quarantineFor = async (rcpt) => (await quarantineIndex()).byRcpt.get(String(rcpt).toLowerCase()) || [];
mailcow.quarantineForDomain = async (domain) => (await quarantineIndex()).byDomain.get(String(domain).toLowerCase()) || [];
mailcow.quarantineById = async (id) => (await quarantineIndex()).byId.get(String(id)) || null;
mailcow.quarantineAction = async (ids, action) => { try { return await raw.quarantineAction(ids, action); } finally { forget('quarantine'); } };
mailcow.deleteQuarantine = async (ids) => { try { return await raw.deleteQuarantine(ids); } finally { forget('quarantine'); } };
