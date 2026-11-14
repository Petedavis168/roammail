// Slack / Microsoft Teams / Discord alerts: "New email from Ann: Contract signed" in a channel you choose.
// You paste the channel's incoming-webhook link; we post to it when new mail arrives (all mail, or only from people
// you pick). Only those services' webhook addresses are accepted, over https, without following redirects.
// Runs on the background worker, which watches the inbox (the same watch that sends phone notifications).
import express from 'express';
import { q, audit } from './db.js';
import { requireAuth, seal, unseal } from './session.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>".]{1,63}(?:\.[^\s@<>".]{1,63}){1,8}$/;

/** Which service a webhook link belongs to, or null if it isn't one we post to. */
export function hookKind(url) {
  let u; try { u = new URL(String(url || '').trim()); } catch { return null; }
  // tests talk to a local stand-in (never in production)
  if (process.env.NODE_ENV !== 'production' && process.env.CHAT_HOOK_ALLOW_LOCAL === '1' && u.hostname === '127.0.0.1' && u.pathname.startsWith('/services/')) return 'slack';
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'hooks.slack.com' && u.pathname.startsWith('/services/')) return 'slack';
  if ((h.endsWith('.webhook.office.com') || h === 'outlook.office.com') && /\/webhook/i.test(u.pathname)) return 'teams';
  if ((h.endsWith('.logic.azure.com') || h.endsWith('.environment.api.powerplatform.com')) && /\/workflows\//i.test(u.pathname)) return 'teams-workflow';
  if ((h === 'discord.com' || h === 'discordapp.com') && u.pathname.startsWith('/api/webhooks/')) return 'discord';
  return null;
}

function payloadFor(kind, { title, body, link }) {
  const text = `${title}${body ? `\n${body}` : ''}${link ? `\n${link}` : ''}`;
  if (kind === 'slack') return { text: `*${title}*${body ? `\n${body}` : ''}${link ? `\n<${link}|Open in Roammail>` : ''}` };
  if (kind === 'discord') return { content: text.slice(0, 1900) };
  if (kind === 'teams-workflow') {
    return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
      body: [{ type: 'TextBlock', text: title, weight: 'Bolder', wrap: true }, ...(body ? [{ type: 'TextBlock', text: body, wrap: true }] : [])],
      ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Roammail', url: link }] } : {}) } }] };
  }
  return { text }; // classic Teams connector
}

export async function postToHook(url, msg) {
  const kind = hookKind(url);
  if (!kind) return false;
  try {
    const r = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadFor(kind, msg)), signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch { return false; }
}

/** Called by the inbox watcher for each new email. */
export async function chatNotify(email, { from, subject, preview, link }) {
  const rows = await q.all('SELECT * FROM chat_hooks WHERE email = ?', email);
  for (const r of rows) {
    const vip = JSON.parse(r.only_from || '[]');
    if (vip.length && !vip.includes(String(from?.address || '').toLowerCase())) continue;
    const url = unseal(r.url)?.u;
    if (!url) continue;
    const ok = await postToHook(url, preview
      ? { title: `New email from ${from?.name || from?.address || 'someone'}`, body: String(subject || '(no subject)').slice(0, 200), link }
      : { title: 'You have new email', body: email, link });
    await q.run('UPDATE chat_hooks SET last_at = ?, last_ok = ? WHERE id = ?', Date.now(), ok ? 1 : 0, r.id);
  }
}
/** Mailboxes with chat alerts (and the sign-in the watcher uses for them). */
export async function chatWatchers() {
  const out = [];
  for (const r of await q.all('SELECT email, creds FROM chat_hooks')) {
    const c = unseal(r.creds);
    if (c && c.exp > Date.now()) out.push({ email: r.email, user: { email: c.email, password: c.password, sid: `chat:${r.email}` } });
  }
  return out;
}

export const chatAlertsApi = express.Router();
chatAlertsApi.use('/chat-alerts', requireAuth);
const out = (r) => ({ id: Number(r.id), kind: r.kind, onlyFrom: JSON.parse(r.only_from || '[]'), lastAt: r.last_at ? Number(r.last_at) : null, lastOk: r.last_ok === null ? null : !!Number(r.last_ok) });

chatAlertsApi.get('/chat-alerts', wrap(async (req, res) => res.json((await q.all('SELECT * FROM chat_hooks WHERE email = ? ORDER BY id', req.user.email)).map(out))));
chatAlertsApi.post('/chat-alerts', rateLimit({ windowMs: 3600e3, limit: 20 }), wrap(async (req, res) => {
  if (req.delegatedMailbox) throw fail(403, 'Set up alerts from your own mailbox');
  const url = String(req.body.url || '').trim();
  const kind = hookKind(url);
  if (!kind) throw fail(400, 'Paste an incoming-webhook link from Slack, Microsoft Teams or Discord');
  const onlyFrom = [...new Set((Array.isArray(req.body.onlyFrom) ? req.body.onlyFrom : String(req.body.onlyFrom || '').split(/[,\s]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => EMAIL_RE.test(x)))].slice(0, 50);
  if (Number((await q.get('SELECT COUNT(*) AS n FROM chat_hooks WHERE email = ?', req.user.email)).n) >= 5) throw fail(400, 'You can have up to 5 channels');
  if (!(await postToHook(url, { title: 'Roammail is connected ✅', body: `New email alerts for ${req.user.email} will appear here.` }))) throw fail(400, 'We couldn’t post to that link. Check it and try again.');
  const id = await q.insert('INSERT INTO chat_hooks(email, kind, url, only_from, creds, created_at) VALUES(?, ?, ?, ?, ?, ?)', req.user.email, kind, seal({ u: url }), JSON.stringify(onlyFrom),
    seal({ email: req.user.email, password: req.user.password, exp: Date.now() + 365 * 864e5 }), Date.now());
  await audit(req.user.email, null, 'chat_alerts.add', { kind, filtered: onlyFrom.length });
  res.json(out(await q.get('SELECT * FROM chat_hooks WHERE id = ?', id)));
}));
chatAlertsApi.delete('/chat-alerts/:id', wrap(async (req, res) => {
  await q.run('DELETE FROM chat_hooks WHERE id = ? AND email = ?', Number(req.params.id), req.user.email);
  res.json({ ok: true });
}));
