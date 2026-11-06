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

  listAliases: async (domain) => list(await call('GET', 'get/alias/all'))
    .filter((a) => a.domain === domain || String(a.address).endsWith(`@${domain}`))
    .map((a) => ({ id: a.id, address: a.address, goto: a.goto, active: Number(a.active) === 1 })),
  addAlias: (address, goto) => call('POST', 'add/alias', { address, goto, active: 1 }),
  deleteAlias: (id) => call('POST', 'delete/alias', [String(id)]),
};
