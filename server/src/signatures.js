// Signatures: personal (per user, rich HTML) and company-wide templates with
// per-user placeholders, applied automatically to every user incl. new hires.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import sanitizeHtml from 'sanitize-html';
import { config } from './config.js';
import { q, rolesFor, audit, setting, setSetting, userSetting, setUserSetting } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------- sanitizing
const SAFE_STYLE = /^[^;{}<>]*$/;
const SANITIZE = {
  allowedTags: ['p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'img', 'table', 'tbody', 'thead', 'tr', 'td', 'th',
    'font', 'hr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'small', 'big', 'sup', 'sub', 'blockquote', 'center'],
  allowedAttributes: {
    a: ['href', 'target', 'style', 'title'],
    img: ['src', 'alt', 'width', 'height', 'style', 'border'],
    table: ['cellpadding', 'cellspacing', 'border', 'width', 'style', 'bgcolor', 'align'],
    td: ['colspan', 'rowspan', 'width', 'valign', 'align', 'style', 'bgcolor'],
    th: ['colspan', 'rowspan', 'width', 'valign', 'align', 'style'],
    font: ['color', 'size', 'face'],
    '*': ['style', 'align', 'data-org-signature'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowedStyles: {
    '*': Object.fromEntries(['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration',
      'text-align', 'line-height', 'letter-spacing', 'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
      'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'border', 'border-left', 'border-right', 'border-top',
      'border-bottom', 'border-radius', 'width', 'height', 'max-width', 'vertical-align', 'display', 'white-space'].map((k) => [k, [SAFE_STYLE]])),
  },
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  transformTags: { a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank' } }) },
};
export const cleanHtml = (html) => sanitizeHtml(String(html || '').slice(0, 50000), SANITIZE);

// ---------------------------------------------------------------- templates
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Mustache-lite: {{key}}, {{#key}}shown if key set{{/key}}, {{^key}}shown if key empty{{/key}} */
export function renderTemplate(tpl, vars) {
  let out = String(tpl || '');
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/\{\{#\s*(\w+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g, (_, k, body) => (String(vars[k] ?? '').trim() ? body : ''))
      .replace(/\{\{\^\s*(\w+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g, (_, k, body) => (String(vars[k] ?? '').trim() ? '' : body));
    if (next === out) break;
    out = next;
  }
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => esc(vars[k]));
  return cleanHtml(out); // re-balance any tags split by sections
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const PLACEHOLDERS = [
  ['name', 'Full name'], ['first_name', 'First name'], ['email', 'Email'], ['title', 'Job title'], ['department', 'Department'],
  ['phone', 'Phone'], ['mobile', 'Mobile'], ['company', 'Company'], ['website', 'Website'], ['address', 'Address'], ['logo', 'Logo URL'],
];

// ---------------------------------------------------------------- data access
const orgIdForEmail = async (email) => (await q.get('SELECT org_id FROM domains WHERE domain = ? AND status = ?', email.split('@')[1], 'active'))?.org_id ?? null;

export async function getProfile(email) {
  return await q.get('SELECT name, title, department, phone, mobile FROM profiles WHERE email = ?', email.toLowerCase()) || {};
}
export async function saveProfile(email, fields) {
  const cur = await getProfile(email);
  const next = { ...cur };
  for (const k of ['name', 'title', 'department', 'phone', 'mobile']) {
    if (fields[k] !== undefined) next[k] = String(fields[k] ?? '').trim().slice(0, 120);
  }
  await q.run(`INSERT INTO profiles(email, name, title, department, phone, mobile, updated_at) VALUES(?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, title = excluded.title, department = excluded.department,
         phone = excluded.phone, mobile = excluded.mobile, updated_at = excluded.updated_at`,
  email.toLowerCase(), next.name ?? null, next.title ?? null, next.department ?? null, next.phone ?? null, next.mobile ?? null);
}
export async function deleteUserData(email) {
  await q.run('DELETE FROM profiles WHERE email = ?', email.toLowerCase());
  await q.run('DELETE FROM user_signatures WHERE email = ?', email.toLowerCase());
}

export async function getOrgSignature(orgId) {
  const r = await q.get('SELECT * FROM org_signatures WHERE org_id = ?', orgId);
  const org = await q.get('SELECT name FROM orgs WHERE id = ?', orgId);
  const vars = r ? JSON.parse(r.vars || '{}') : {};
  return { html: r?.html || '', mode: r?.mode || 'off', onReplies: r ? !!r.on_replies : true,
    vars: { company: org?.name || '', website: '', address: '', logo: '', ...vars }, updatedAt: r?.updated_at || null, updatedBy: r?.updated_by || null };
}

async function varsFor(email, orgSig, fallbackName) {
  const p = await getProfile(email);
  let name = p.name;
  if (!name) {
    // Fill the profile from mailcow the first time (covers users created before signatures existed)
    try { name = (await mailcow.getMailbox(email))?.name; if (name) await saveProfile(email, { name }); } catch { /* ignore */ }
  }
  name = name || fallbackName || email.split('@')[0];
  return { ...orgSig.vars, ...p, name, first_name: name.split(/\s+/)[0], email };
}

/** Company signature rendered for one user, or null. */
export async function orgSignatureFor(email, { fallbackName, template, vars } = {}) {
  const orgId = await orgIdForEmail(email);
  if (!orgId) return null;
  const sig = await getOrgSignature(orgId);
  if (vars) sig.vars = { ...sig.vars, ...vars };
  const tpl = template ?? sig.html;
  if (!tpl) return { ...sig, rendered: '' };
  return { ...sig, rendered: renderTemplate(tpl, await varsFor(email, sig, fallbackName)) };
}

async function personal(email) {
  const r = await q.get('SELECT data FROM user_signatures WHERE email = ?', email.toLowerCase());
  return r ? JSON.parse(r.data) : { signatures: [], defaultNew: null, defaultReply: null };
}

/** Used by /api/send: append the required company signature. */
export async function applyEnforcedSignature(user, mail, isReply) {
  const sig = await orgSignatureFor(user.email, { fallbackName: user.name });
  if (!sig || sig.mode !== 'enforced' || !sig.rendered) return mail;
  if (isReply && !sig.onReplies) return mail;
  if (mail.html && /data-org-signature/.test(mail.html)) return mail;
  const block = `<div data-org-signature="1" style="margin-top:16px">${sig.rendered}</div>`;
  const html = mail.html || (mail.text ? `<div style="white-space:pre-wrap">${esc(mail.text)}</div>` : '');
  // Put it above the quoted thread if there is one (Outlook behaviour)
  const qi = html.search(/<div>On [^<]*wrote:<\/div>|<div>---------- Forwarded message/);
  const newHtml = qi > 0 ? `${html.slice(0, qi)}${block}${html.slice(qi)}` : `${html}${block}`;
  return { ...mail, html: newHtml, text: `${mail.text || htmlToText(html)}\n\n-- \n${htmlToText(sig.rendered)}` };
}

// ---------------------------------------------------------------- assets (logos)
const assetDir = path.join(config.dataDir, 'sig-assets');
fs.mkdirSync(assetDir, { recursive: true });
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const imgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 } });

export const publicAssets = express.Router();
// Logos live in the database so every app server can serve them (older ones may still be files on disk)
publicAssets.get('/sig-assets/:file', wrap(async (req, res) => {
  const f = req.params.file;
  if (!/^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(f)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // recipients' mail apps load this
  const row = await q.get('SELECT mime, data FROM sig_assets WHERE name = ?', f);
  if (row) return res.type(row.mime).send(Buffer.from(row.data));
  res.sendFile(path.join(path.resolve(assetDir), f), (err) => err && res.status(404).end());
}));

// ---------------------------------------------------------------- API
export const signatures = express.Router();
signatures.use(requireAuth);

const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

signatures.post('/sig-assets', imgUpload.single('image'), wrap(async (req, res) => {
  const f = req.file;
  if (!f || !TYPES[f.mimetype]) throw fail(400, 'Upload a PNG, JPG, GIF or WebP image (max 512 KB)');
  const today = (await q.get("SELECT COUNT(*) AS n FROM audit WHERE actor = ? AND action = 'asset.upload' AND at > datetime('now', '-1 day')", req.user.email)).n;
  if (today >= 30) throw fail(429, 'Upload limit reached for today');
  // Check magic bytes so a renamed file can't sneak through
  const b = f.buffer;
  const ok = (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 3).toString() === 'GIF' || b.subarray(8, 12).toString() === 'WEBP';
  if (!ok) throw fail(400, 'That file is not a valid image');
  const name = `${crypto.randomBytes(12).toString('hex')}.${TYPES[f.mimetype]}`;
  await q.run('INSERT INTO sig_assets(name, mime, data) VALUES(?, ?, ?)', name, f.mimetype, b);
  await audit(req.user.email, null, 'asset.upload', { name, size: b.length });
  res.json({ url: `${baseUrl(req)}/sig-assets/${name}` });
}));

// Everything the compose window needs
signatures.get('/signature', wrap(async (req, res) => {
  const org = await orgSignatureFor(req.user.email, { fallbackName: req.user.name });
  res.json({
    personal: await personal(req.user.email),
    org: org && org.mode !== 'off' && org.rendered ? { mode: org.mode, onReplies: org.onReplies, html: org.rendered, company: org.vars.company } : null,
    profile: await getProfile(req.user.email),
    inOrg: !!await orgIdForEmail(req.user.email),
  });
}));

// The builder's settings are plain data (texts, numbers, colours); kept only if small and of the right shape
const designOk = (d) => !!d && typeof d === 'object' && !Array.isArray(d) && JSON.stringify(d).length <= 20000 && typeof d.style === 'string';
signatures.put('/signature/personal', wrap(async (req, res) => {
  const list = (Array.isArray(req.body.signatures) ? req.body.signatures : []).slice(0, 20).map((s) => ({
    id: /^[\w-]{1,40}$/.test(s.id) ? s.id : crypto.randomBytes(6).toString('hex'),
    name: String(s.name || 'Signature').slice(0, 60),
    html: cleanHtml(s.html),
    ...(designOk(s.design) ? { design: s.design } : {}), // the builder's settings, so it can be edited again
  }));
  const valid = (v) => (v === 'company' || v === null || list.some((s) => s.id === v) ? v : null);
  const data = { signatures: list, defaultNew: valid(req.body.defaultNew ?? null), defaultReply: valid(req.body.defaultReply ?? null) };
  await q.run('INSERT INTO user_signatures(email, data) VALUES(?, ?) ON CONFLICT(email) DO UPDATE SET data = excluded.data', req.user.email, JSON.stringify(data));
  res.json(data);
}));

// Users may keep their own phone numbers up to date; title/department are set by admins.
signatures.patch('/profile', wrap(async (req, res) => {
  await saveProfile(req.user.email, { phone: req.body.phone, mobile: req.body.mobile });
  res.json(await getProfile(req.user.email));
}));

// ---- admin: company signature
async function requireOrgAdmin(req, orgId) {
  const r = await rolesFor(req.user.email);
  const id = Number(orgId);
  if (!await q.get('SELECT 1 FROM orgs WHERE id = ?', id)) throw fail(404, 'Organization not found');
  if (!r.superAdmin && !r.orgs.some((o) => o.id === id && o.role === 'admin')) throw fail(403, 'You are not an admin of this organization');
  return id;
}

signatures.get('/admin/orgs/:id/signature', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.id);
  res.json({ ...await getOrgSignature(id), placeholders: PLACEHOLDERS });
}));

signatures.put('/admin/orgs/:id/signature', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.id);
  const mode = ['off', 'default', 'enforced'].includes(req.body.mode) ? req.body.mode : 'off';
  const v = req.body.vars || {};
  const vars = {
    company: String(v.company || '').slice(0, 120), website: String(v.website || '').slice(0, 200),
    address: String(v.address || '').slice(0, 300), logo: /^https?:\/\//.test(v.logo || '') ? String(v.logo).slice(0, 500) : '',
  };
  await q.run(`INSERT INTO org_signatures(org_id, html, mode, on_replies, vars, updated_by, updated_at) VALUES(?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(org_id) DO UPDATE SET html = excluded.html, mode = excluded.mode, on_replies = excluded.on_replies,
         vars = excluded.vars, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  id, cleanHtml(req.body.html), mode, req.body.onReplies === false ? 0 : 1, JSON.stringify(vars), req.user.email);
  await audit(req.user.email, id, 'signature.update', { mode });
  res.json(await getOrgSignature(id));
}));

// Live preview of an unsaved template for any user in the org
signatures.post('/admin/orgs/:id/signature/preview', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.id);
  const email = String(req.body.email || '').toLowerCase();
  const sample = { name: 'Alex Morgan', title: 'Sales Manager', department: 'Sales', phone: '+1 (555) 010-2030', mobile: '+1 (555) 010-4050' };
  const org = await getOrgSignature(id);
  const vars = { ...org.vars, ...(req.body.vars || {}) };
  if (email && await orgIdForEmail(email) === id) {
    const r = await orgSignatureFor(email, { template: cleanHtml(req.body.html), vars });
    return res.json({ html: r.rendered });
  }
  const domain = (await q.get("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", id))?.domain || 'example.com';
  res.json({ html: renderTemplate(cleanHtml(req.body.html), { ...vars, ...sample, first_name: 'Alex', email: `alex@${domain}` }) });
}));

// ---------------------------------------------------------------- templates (canned replies)
// Personal templates for everyone, plus company templates that business admins share with all staff.
const cleanTemplates = (list) => (Array.isArray(list) ? list : []).slice(0, 100).map((t) => ({
  id: /^[\w-]{1,40}$/.test(t.id) ? t.id : crypto.randomBytes(6).toString('hex'),
  name: String(t.name || 'Template').slice(0, 80),
  subject: String(t.subject || '').slice(0, 200),
  html: cleanHtml(t.html),
  category: String(t.category || '').slice(0, 40),
}));
signatures.get('/templates', wrap(async (req, res) => {
  const orgId = await orgIdForEmail(req.user.email);
  res.json({
    personal: await userSetting(req.user.email, 'templates', []),
    company: orgId ? await setting(`orgTemplates:${orgId}`, []) : [],
  });
}));
signatures.put('/templates', wrap(async (req, res) => {
  const list = cleanTemplates(req.body.templates);
  await setUserSetting(req.user.email, 'templates', list);
  res.json({ ok: true, templates: list });
}));
signatures.get('/admin/orgs/:id/templates', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.id);
  res.json(await setting(`orgTemplates:${id}`, []));
}));
signatures.put('/admin/orgs/:id/templates', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.id);
  const list = cleanTemplates(req.body.templates);
  await setSetting(`orgTemplates:${id}`, list);
  await audit(req.user.email, id, 'templates.company', { count: list.length });
  res.json({ ok: true, templates: list });
}));

// ---------------------------------------------------------------- company footer (disclaimer)
// A short legal / confidentiality notice added under every email the team sends (optionally only to outside people).
const cleanFooter = (b) => ({ enabled: !!b.enabled, text: String(b.text || '').replace(/\r/g, '').slice(0, 2000), externalOnly: b.externalOnly !== false });
signatures.get('/admin/orgs/:id/footer', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.id);
  res.json(await setting(`orgFooter:${id}`, { enabled: false, text: '', externalOnly: true }));
}));
signatures.put('/admin/orgs/:id/footer', wrap(async (req, res) => {
  const id = await requireOrgAdmin(req, req.params.id);
  const f = cleanFooter(req.body);
  if (f.enabled && !f.text.trim()) throw fail(400, 'Write the footer text');
  await setSetting(`orgFooter:${id}`, f);
  await audit(req.user.email, id, 'footer.company', { enabled: f.enabled, externalOnly: f.externalOnly });
  res.json(f);
}));
/** Add the company footer to an outgoing email (plain text and HTML). recipients = every address it goes to. */
export async function applyCompanyFooter(user, mail, recipients) {
  const orgId = await orgIdForEmail(user.email);
  if (!orgId) return mail;
  const f = await setting(`orgFooter:${orgId}`, null);
  if (!f?.enabled || !f.text?.trim()) return mail;
  if (f.externalOnly) {
    const own = new Set((await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", orgId)).map((d) => d.domain));
    if (recipients.every((r) => own.has(String(r).split('@')[1]))) return mail;
  }
  if (mail.html && /data-org-footer/.test(mail.html)) return mail;
  const block = `<div data-org-footer="1" style="margin-top:20px;padding-top:8px;border-top:1px solid #ddd;color:#777;font-size:11px;line-height:1.4;white-space:pre-wrap">${esc(f.text)}</div>`;
  const html = mail.html || (mail.text ? `<div style="white-space:pre-wrap">${esc(mail.text)}</div>` : '');
  return { ...mail, html: `${html}${block}`, text: `${mail.text || ''}\n\n--\n${f.text}` };
}
