// Contacts on top of mailcow's CardDAV, plus the company directory and vCard import/export.
import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import ICAL from 'ical.js';
import { requireAuth } from './session.js';
import { q, audit } from './db.js';
import { mailcow } from './mailcow.js';
import { getProfile } from './signatures.js';
import { discover, listCollections, report, putResource, deleteResource, getResource, assertOwnHref } from './dav.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => String(s ?? '').replace(/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n).trim();
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

// ---------------------------------------------------------------- vCard
const vesc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\;');
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) { if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ` ${ch}`; } else cur += ch; }
  out.push(cur); return out.join('\r\n');
}
const TYPES = new Set(['work', 'home', 'mobile', 'cell', 'other', 'main', 'fax']);

/** Validate and normalize contact fields (used for both API input and imported vCards). */
export function cleanContact(b) {
  const c = {
    first: clip(b.first, 100), last: clip(b.last, 100), company: clip(b.company, 200), title: clip(b.title, 200),
    note: clip(b.note, 5000).slice(0, 5000), birthday: /^\d{4}-\d{2}-\d{2}$/.test(b.birthday || '') ? b.birthday : '',
    emails: [], phones: [], address: null,
  };
  for (const e of (Array.isArray(b.emails) ? b.emails : []).slice(0, 10)) {
    const v = clip(e.value ?? e, 200).toLowerCase();
    if (EMAIL_RE.test(v)) c.emails.push({ value: v, type: TYPES.has(e.type) ? e.type : 'other' });
  }
  for (const p of (Array.isArray(b.phones) ? b.phones : []).slice(0, 10)) {
    const v = clip(p.value ?? p, 40).replace(/[^\d+()\-.\s x#*]/g, '');
    if (v.replace(/\D/g, '').length >= 3) c.phones.push({ value: v, type: TYPES.has(p.type) ? p.type : 'mobile' });
  }
  if (b.address && typeof b.address === 'object') {
    const a = Object.fromEntries(['street', 'city', 'region', 'postal', 'country'].map((k) => [k, clip(b.address[k], 200)]));
    if (Object.values(a).some(Boolean)) c.address = a;
  }
  c.name = clip(b.name, 200) || [c.first, c.last].filter(Boolean).join(' ') || c.company || c.emails[0]?.value || '';
  if (!c.name) throw fail(400, 'Add a name or an email address');
  return c;
}

export function buildVCard(c, uid) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${vesc(uid)}`, `FN:${vesc(c.name)}`, `N:${vesc(c.last)};${vesc(c.first)};;;`];
  if (c.company) lines.push(`ORG:${vesc(c.company)}`);
  if (c.title) lines.push(`TITLE:${vesc(c.title)}`);
  for (const e of c.emails) lines.push(`EMAIL;TYPE=INTERNET,${e.type.toUpperCase()}:${vesc(e.value)}`);
  for (const p of c.phones) lines.push(`TEL;TYPE=${(p.type === 'mobile' ? 'CELL' : p.type).toUpperCase()}:${vesc(p.value)}`);
  if (c.address) lines.push(`ADR;TYPE=WORK:;;${vesc(c.address.street)};${vesc(c.address.city)};${vesc(c.address.region)};${vesc(c.address.postal)};${vesc(c.address.country)}`);
  if (c.birthday) lines.push(`BDAY:${c.birthday}`);
  if (c.note) lines.push(`NOTE:${vesc(c.note)}`);
  lines.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`, 'END:VCARD');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

const unesc = (x) => (typeof x === 'string' ? x.replace(/\\([;,\\])/g, '$1') : x);
export function parseVCard(text) {
  const parsed = ICAL.parse(String(text));
  // One card parses to a single jCard; a file with many cards parses to a list of them
  const roots = Array.isArray(parsed[0]) ? parsed : [parsed];
  const cards = roots.map((r) => new ICAL.Component(r)).flatMap((c) => (c.name === 'vcard' ? [c] : c.getAllSubcomponents('vcard')));
  return cards.map((v) => {
    const val = (n) => { const x = v.getFirstPropertyValue(n); return Array.isArray(x) ? x.map(unesc) : (x == null ? '' : unesc(String(x))); };
    const n = val('n'); const adr = v.getFirstPropertyValue('adr');
    const typeOf = (p) => String([].concat(p.getParameter('type') || []).join(',')).toLowerCase();
    const pickType = (t, fallback) => (/cell|mobile/.test(t) ? 'mobile' : /work/.test(t) ? 'work' : /home/.test(t) ? 'home' : fallback);
    const org = val('org');
    return {
      uid: String(val('uid') || ''),
      name: String(val('fn') || ''), first: Array.isArray(n) ? String(n[1] || '') : '', last: Array.isArray(n) ? String(n[0] || '') : '',
      company: Array.isArray(org) ? String(org[0] || '') : String(org || ''), title: String(val('title') || ''), note: String(val('note') || ''),
      birthday: String(v.getFirstPropertyValue('bday') || '').slice(0, 10),
      emails: v.getAllProperties('email').map((p) => ({ value: unesc(String(p.getFirstValue())), type: pickType(typeOf(p), 'other') })),
      phones: v.getAllProperties('tel').map((p) => ({ value: unesc(String(p.getFirstValue())).replace(/^tel:/, ''), type: pickType(typeOf(p), 'mobile') })),
      address: Array.isArray(adr) ? { street: String(adr[2] || ''), city: String(adr[3] || ''), region: String(adr[4] || ''), postal: String(adr[5] || ''), country: String(adr[6] || '') } : null,
    };
  });
}

// ---------------------------------------------------------------- data access
const QUERY = '<?xml version="1.0" encoding="utf-8"?><cr:addressbook-query xmlns:d="DAV:" xmlns:cr="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><cr:address-data/></d:prop></cr:addressbook-query>';
const listCache = new Map(); // sid -> { at, list }

export async function allContacts(user, { fresh } = {}) {
  const c = listCache.get(user.sid);
  if (!fresh && c && Date.now() - c.at < 2 * 60 * 1000) return c.list;
  const d = await discover(user);
  const books = await listCollections(user, 'addressbook');
  const out = [];
  for (const b of books) {
    assertOwnHref(b.href, d.cardHome);
    for (const it of await report(user, b.href, QUERY).catch(() => [])) {
      try {
        const [card] = parseVCard(it.data);
        if (card) out.push({ ...card, href: it.href, etag: it.etag, book: b.href });
      } catch { /* skip unreadable card */ }
    }
  }
  out.sort((a, b) => (a.name || a.emails[0]?.value || '').localeCompare(b.name || b.emails[0]?.value || '', undefined, { sensitivity: 'base' }));
  listCache.set(user.sid, { at: Date.now(), list: out });
  return out;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of listCache) if (now - v.at > 10 * 60 * 1000) listCache.delete(k); }, 5 * 60 * 1000).unref();

/** Coworkers for business users: everyone with a mailbox on the organization's domains. */
export async function directory(email) {
  const org = q.get("SELECT org_id FROM domains WHERE domain = ? AND status = 'active'", email.split('@')[1]);
  if (!org) return [];
  const domains = q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", org.org_id).map((r) => r.domain);
  const people = [];
  for (const dom of domains) {
    for (const m of await mailcow.listMailboxes(dom).catch(() => [])) {
      if (!m.active) continue;
      const p = getProfile(m.email);
      people.push({ email: m.email, name: p.name || m.name || m.email.split('@')[0], title: p.title || '', department: p.department || '', phone: p.phone || '', mobile: p.mobile || '' });
    }
  }
  return people.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- API
export const contacts = express.Router();
contacts.use(requireAuth);

contacts.get('/addressbooks', wrap(async (req, res) => res.json(await listCollections(req.user, 'addressbook'))));
contacts.get('/address-contacts', wrap(async (req, res) => res.json(await allContacts(req.user, { fresh: req.query.fresh === '1' }))));
contacts.get('/directory', wrap(async (req, res) => res.json(await directory(req.user.email))));

contacts.post('/address-contacts', wrap(async (req, res) => {
  const d = await discover(req.user);
  const books = await listCollections(req.user, 'addressbook');
  const book = req.body.book && books.some((b) => b.href === req.body.book) ? req.body.book : books[0].href;
  assertOwnHref(book, d.cardHome);
  const c = cleanContact(req.body);
  const uid = crypto.randomUUID();
  const href = `${book.replace(/\/?$/, '/')}${uid}.vcf`;
  const etag = await putResource(req.user, href, buildVCard(c, uid), 'text/vcard; charset=utf-8');
  listCache.delete(req.user.sid);
  res.json({ ok: true, href, etag });
}));

contacts.put('/address-contacts', wrap(async (req, res) => {
  const d = await discover(req.user);
  const href = assertOwnHref(String(req.body.href || ''), d.cardHome);
  const cur = await getResource(req.user, href);
  const [old] = parseVCard(cur.data);
  const c = cleanContact(req.body);
  const etag = await putResource(req.user, href, buildVCard(c, old?.uid || crypto.randomUUID()), 'text/vcard; charset=utf-8', req.body.etag || cur.etag);
  listCache.delete(req.user.sid);
  res.json({ ok: true, etag });
}));

contacts.delete('/address-contacts', wrap(async (req, res) => {
  const d = await discover(req.user);
  const hrefs = [].concat(req.query.href || []).slice(0, 500);
  for (const h of hrefs) {
    const href = assertOwnHref(String(h), d.cardHome);
    const cur = await getResource(req.user, href).catch(() => null);
    if (cur) await deleteResource(req.user, href, cur.etag);
  }
  listCache.delete(req.user.sid);
  res.json({ ok: true, deleted: hrefs.length });
}));

contacts.get('/address-contacts/export', wrap(async (req, res) => {
  const list = await allContacts(req.user, { fresh: true });
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.vcf"');
  res.end(list.map((c) => buildVCard(cleanContactSafe(c), c.uid || crypto.randomUUID())).join(''));
}));
function cleanContactSafe(c) { try { return cleanContact(c); } catch { return cleanContact({ ...c, name: c.name || 'Unnamed' }); } }

// Import a .vcf exported from Gmail, Outlook, iPhone etc. Each card is rebuilt from clean fields.
contacts.post('/address-contacts/import', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw fail(400, 'Choose a .vcf file');
  let cards;
  try { cards = parseVCard(req.file.buffer.toString('utf8').replace(/\r?\n/g, '\r\n')); } catch { throw fail(400, 'That file is not a valid vCard (.vcf) file'); }
  if (cards.length > 5000) throw fail(400, 'At most 5000 contacts per import');
  const d = await discover(req.user);
  const books = await listCollections(req.user, 'addressbook');
  const book = books[0].href; assertOwnHref(book, d.cardHome);
  const existing = new Set((await allContacts(req.user, { fresh: true })).flatMap((c) => c.emails.map((e) => e.value)));
  let added = 0; let skipped = 0;
  for (const raw of cards) {
    let c; try { c = cleanContact(raw); } catch { skipped++; continue; }
    if (c.emails.some((e) => existing.has(e.value))) { skipped++; continue; } // already have this person
    const uid = crypto.randomUUID();
    try { await putResource(req.user, `${book.replace(/\/?$/, '/')}${uid}.vcf`, buildVCard(c, uid), 'text/vcard; charset=utf-8'); added++; c.emails.forEach((e) => existing.add(e.value)); }
    catch { skipped++; }
  }
  listCache.delete(req.user.sid);
  audit(req.user.email, null, 'contacts.import', { added, skipped });
  res.json({ ok: true, added, skipped });
}));
