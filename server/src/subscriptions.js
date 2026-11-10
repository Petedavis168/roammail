// Subscriptions: every newsletter and mailing list in your inbox, grouped by sender, with how many emails they've
// sent and how many are unread. From here you can unsubscribe, clear out everything they've sent (archive or bin),
// or block them. Found by the List-Unsubscribe header bulk senders are required to include.
//
// Unsubscribing, in order of preference:
//  1. one-click (RFC 8058): our server sends the POST the sender asked for. Only https, only to public addresses
//     (never to anything inside our network), no redirects, short timeout.
//  2. by email: we send "unsubscribe" to the address the sender gave, from your mailbox.
//  3. otherwise the sender's own unsubscribe page is opened in a new tab.
import express from 'express';
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { q, audit } from './db.js';
import { requireAuth } from './session.js';
import { withMailbox, specialFolder, userTransport } from './imap.js';
import { checkSendQuota } from './abuse.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>".]{1,63}(?:\.[^\s@<>".]{1,63}){1,8}$/; // no backtracking blow-up on long input
const SCAN_LIMIT = 3000; // most recent list emails looked at
const cache = new Map(); // email -> { at, list }
const CACHE_MS = 5 * 60e3;

/** Parse a List-Unsubscribe header: "<https://…>, <mailto:…>" */
export function parseListUnsubscribe(header, post) {
  const out = { http: null, mailto: null, oneClick: false };
  for (const m of String(header || '').matchAll(/<\s*([^>\s]+)\s*>/g)) {
    const u = m[1];
    if (!out.http && /^https?:\/\//i.test(u)) out.http = u;
    else if (!out.mailto && /^mailto:/i.test(u)) out.mailto = u;
  }
  out.oneClick = !!out.http && /List-Unsubscribe=One-Click/i.test(String(post || '')); // https is checked when we send it
  return out;
}

// ---------------------------------------------------------------- scanning the inbox
const headerText = (buf) => String(buf || '');
const pickHeader = (text, name) => {
  const m = new RegExp(`^${name}:([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, 'im').exec(text);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
};

async function scan(user) {
  const hit = cache.get(user.email);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const senders = new Map();
  await withMailbox(user, 'INBOX', async (client) => {
    const uids = ((await client.search({ header: { 'list-unsubscribe': '' } }, { uid: true })) || []).sort((a, b) => b - a).slice(0, SCAN_LIMIT);
    if (!uids.length) return;
    for await (const msg of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, internalDate: true, headers: ['list-unsubscribe', 'list-unsubscribe-post', 'list-id'] }, { uid: true })) {
      const from = msg.envelope?.from?.[0];
      const address = String(from?.address || '').toLowerCase();
      if (!EMAIL_RE.test(address)) continue;
      const h = headerText(msg.headers);
      const date = new Date(msg.internalDate || msg.envelope?.date || 0).getTime();
      let s = senders.get(address);
      if (!s) {
        s = { address, name: from?.name || '', domain: address.split('@')[1], count: 0, unread: 0, last: 0, first: Infinity, subject: '', unsubscribe: null, listId: '' };
        senders.set(address, s);
      }
      s.count++;
      if (!msg.flags?.has('\\Seen')) s.unread++;
      if (date > s.last) {
        s.last = date; s.subject = msg.envelope?.subject || ''; if (from?.name) s.name = from.name;
        s.unsubscribe = parseListUnsubscribe(pickHeader(h, 'List-Unsubscribe'), pickHeader(h, 'List-Unsubscribe-Post'));
        s.listId = pickHeader(h, 'List-Id').slice(0, 200);
      }
      if (date < s.first) s.first = date;
    }
  }, { readOnly: true });
  const list = [...senders.values()].map((s) => ({ ...s, first: Number.isFinite(s.first) ? s.first : s.last }));
  cache.set(user.email, { at: Date.now(), list });
  return list;
}

// ---------------------------------------------------------------- one-click unsubscribe, safely
const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6');
const allowLocal = () => process.env.NODE_ENV !== 'production' && process.env.UNSUB_ALLOW_LOCAL === '1'; // tests talk to a local stand-in
export const isPublicIp = (ip) => {
  const v = net.isIP(ip);
  return v === 4 ? !blocked.check(ip, 'ipv4') : v === 6 ? !blocked.check(ip, 'ipv6') : false;
};

function oneClick(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(false); }
    const local = allowLocal() && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    if (u.protocol !== 'https:' && !local) return resolve(false);
    const body = 'List-Unsubscribe=One-Click';
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST', timeout: 8000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Roammail-Unsubscribe/1.0' },
      // resolve the name ourselves and refuse private addresses (checked on the address actually connected to)
      lookup: (host, opts, cb) => dns.lookup(host, { all: true }, (err, addrs) => {
        if (err) return cb(err);
        const ok = (addrs || []).find((a) => local || isPublicIp(a.address));
        if (!ok) return cb(new Error('blocked address'));
        if (opts?.all) return cb(null, [ok]);
        return cb(null, ok.address, ok.family);
      }),
    }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

// ---------------------------------------------------------------- API
export const subscriptionsApi = express.Router();
subscriptionsApi.use('/subscriptions', requireAuth);

subscriptionsApi.get('/subscriptions', rateLimit({ windowMs: 60e3, limit: 20 }), wrap(async (req, res) => {
  if (req.query.refresh === '1') cache.delete(req.user.email);
  const list = await scan(req.user);
  const states = Object.fromEntries((await q.all('SELECT sender, status, at FROM subscription_state WHERE email = ?', req.user.email)).map((r) => [r.sender, r]));
  res.json({
    scannedAt: cache.get(req.user.email)?.at || Date.now(),
    senders: list.map((s) => ({
      address: s.address, name: s.name, domain: s.domain, count: s.count, unread: s.unread, last: s.last, first: s.first, subject: s.subject, listId: s.listId,
      canUnsubscribe: !!(s.unsubscribe?.http || s.unsubscribe?.mailto), oneClick: !!s.unsubscribe?.oneClick,
      status: states[s.address]?.status || 'active', statusAt: states[s.address]?.at || null,
    })).sort((a, b) => b.last - a.last),
  });
}));

async function setState(email, sender, status) {
  await q.run('INSERT INTO subscription_state(email, sender, status, at) VALUES(?, ?, ?, ?) ON CONFLICT(email, sender) DO UPDATE SET status = excluded.status, at = excluded.at', email, sender, status, Date.now());
}
const senderOf = (req) => {
  const a = String(req.body.address || '').trim().toLowerCase();
  if (!EMAIL_RE.test(a)) throw fail(400, 'Pick a sender');
  return a;
};

subscriptionsApi.post('/subscriptions/unsubscribe', rateLimit({ windowMs: 3600e3, limit: 100 }), wrap(async (req, res) => {
  if (req.delegatedMailbox) throw fail(403, 'Unsubscribe from your own mailbox');
  const address = senderOf(req);
  const s = (await scan(req.user)).find((x) => x.address === address);
  if (!s?.unsubscribe) throw fail(404, 'We couldn’t find an unsubscribe option from this sender');
  const u = s.unsubscribe;
  let method = null;
  if (u.oneClick && await oneClick(u.http)) method = 'one-click';
  if (!method && u.mailto) {
    const m = /^mailto:([^?]+)(?:\?(.*))?$/i.exec(u.mailto);
    const to = m && decodeURIComponent(m[1]);
    if (to && EMAIL_RE.test(to)) {
      const params = new URLSearchParams(m[2] || '');
      await checkSendQuota(req.user.email, 1);
      await userTransport(nodemailer, req.user).sendMail({ from: req.user.email, to, subject: (params.get('subject') || 'unsubscribe').slice(0, 200), text: (params.get('body') || 'unsubscribe').slice(0, 1000) });
      method = 'email';
    }
  }
  if (!method && u.http) {
    await setState(req.user.email, address, 'unsubscribed');
    return res.json({ ok: true, method: 'link', url: u.http });
  }
  if (!method) throw fail(502, 'The sender’s unsubscribe didn’t work. Try blocking them instead.');
  await setState(req.user.email, address, 'unsubscribed');
  await audit(req.user.email, null, 'subscriptions.unsubscribe', { sender: address, method });
  res.json({ ok: true, method });
}));

subscriptionsApi.post('/subscriptions/keep', wrap(async (req, res) => {
  const address = senderOf(req);
  await setState(req.user.email, address, req.body.keep === false ? 'active' : 'kept');
  res.json({ ok: true });
}));

// Clear out everything a sender has sent: to Archive or the bin
subscriptionsApi.post('/subscriptions/cleanup', rateLimit({ windowMs: 60e3, limit: 30 }), wrap(async (req, res) => {
  const address = senderOf(req);
  const action = req.body.action === 'trash' ? 'trash' : 'archive';
  const dest = await specialFolder(req.user, action === 'trash' ? '\\Trash' : '\\Archive', { create: true });
  const moved = await withMailbox(req.user, 'INBOX', async (client) => {
    const uids = (await client.search({ from: address }, { uid: true })) || [];
    if (uids.length) await client.messageMove(uids.join(','), dest, { uid: true });
    return uids.length;
  });
  cache.delete(req.user.email);
  await audit(req.user.email, null, `subscriptions.${action}`, { sender: address, moved });
  res.json({ ok: true, moved, to: dest });
}));
