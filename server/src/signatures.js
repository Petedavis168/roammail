// Signatures: personal (per user, rich HTML) and company-wide templates with
// per-user placeholders, applied automatically to every user incl. new hires.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import sanitizeHtml from 'sanitize-html';
import { config } from './config.js';
import { q, rolesFor, audit } from './db.js';
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
const orgIdForEmail = (email) => q.get('SELECT org_id FROM domains WHERE domain = ? AND status = ?', email.split('@')[1], 'active')?.org_id ?? null;

export function getProfile(email) {
  return q.get('SELECT name, title, department, phone, mobile FROM profiles WHERE email = ?', email.toLowerCase()) || {};
}
export function saveProfile(email, fields) {
  const cur = getProfile(email);
  const next = { ...cur };
  for (const k of ['name', 'title', 'department', 'phone', 'mobile']) {
    if (fields[k] !== undefined) next[k] = String(fields[k] ?? '').trim().slice(0, 120);
  }
  q.run(`INSERT INTO profiles(email, name, title, department, phone, mobile, updated_at) VALUES(?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, title = excluded.title, department = excluded.department,
         phone = excluded.phone, mobile = excluded.mobile, updated_at = excluded.updated_at`,
  email.toLowerCase(), next.name ?? null, next.title ?? null, next.department ?? null, next.phone ?? null, next.mobile ?? null);
}
export function deleteUserData(email) {
  q.run('DELETE FROM profiles WHERE email = ?', email.toLowerCase());
  q.run('DELETE FROM user_signatures WHERE email = ?', email.toLowerCase());
}

export function getOrgSignature(orgId) {
  const r = q.get('SELECT * FROM org_signatures WHERE org_id = ?', orgId);
  const org = q.get('SELECT name FROM orgs WHERE id = ?', orgId);
  const vars = r ? JSON.parse(r.vars || '{}') : {};
  return { html: r?.html || '', mode: r?.mode || 'off', onReplies: r ? !!r.on_replies : true,
    vars: { company: org?.name || '', website: '', address: '', logo: '', ...vars }, updatedAt: r?.updated_at || null, updatedBy: r?.updated_by || null };
}

async function varsFor(email, orgSig, fallbackName) {
  const p = getProfile(email);
  let name = p.name;
  if (!name) {
    // Fill the profile from mailcow the first time (covers users created before signatures existed)
    try { name = (await mailcow.getMailbox(email))?.name; if (name) saveProfile(email, { name }); } catch { /* ignore */ }
  }
  name = name || fallbackName || email.split('@')[0];
  return { ...orgSig.vars, ...p, name, first_name: name.split(/\s+/)[0], email };
}

/** Company signature rendered for one user, or null. */
export async function orgSignatureFor(email, { fallbackName, template, vars } = {}) {
  const orgId = orgIdForEmail(email);
  if (!orgId) return null;
  const sig = getOrgSignature(orgId);
  if (vars) sig.vars = { ...sig.vars, ...vars };
  const tpl = template ?? sig.html;
  if (!tpl) return { ...sig, rendered: '' };
  return { ...sig, rendered: renderTemplate(tpl, await varsFor(email, sig, fallbackName)) };
}

function personal(email) {
  const r = q.get('SELECT data FROM user_signatures WHERE email = ?', email.toLowerCase());
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
publicAssets.get('/sig-assets/:file', (req, res) => {
  const f = req.params.file;
  if (!/^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(f)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // recipients' mail apps load this
  res.sendFile(path.join(path.resolve(assetDir), f), (err) => err && res.status(404).end());
});

// ---------------------------------------------------------------- API
export const signatures = express.Router();
signatures.use(requireAuth);

const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

signatures.post('/sig-assets', imgUpload.single('image'), wrap(async (req, res) => {
  const f = req.file;
  if (!f || !TYPES[f.mimetype]) throw fail(400, 'Upload a PNG, JPG, GIF or WebP image (max 512 KB)');
  // Check magic bytes so a renamed file can't sneak through
  const b = f.buffer;
  const ok = (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 3).toString() === 'GIF' || b.subarray(8, 12).toString() === 'WEBP';
  if (!ok) throw fail(400, 'That file is not a valid image');
  const name = `${crypto.randomBytes(12).toString('hex')}.${TYPES[f.mimetype]}`;
  fs.writeFileSync(path.join(assetDir, name), b);
  audit(req.user.email, null, 'asset.upload', { name, size: b.length });
  res.json({ url: `${baseUrl(req)}/sig-assets/${name}` });
}));

// Everything the compose window needs
signatures.get('/signature', wrap(async (req, res) => {
  const org = await orgSignatureFor(req.user.email, { fallbackName: req.user.name });
  res.json({
    personal: personal(req.user.email),
    org: org && org.mode !== 'off' && org.rendered ? { mode: org.mode, onReplies: org.onReplies, html: org.rendered, company: org.vars.company } : null,
    profile: getProfile(req.user.email),
    inOrg: !!orgIdForEmail(req.user.email),
  });
}));

signatures.put('/signature/personal', wrap(async (req, res) => {
  const list = (Array.isArray(req.body.signatures) ? req.body.signatures : []).slice(0, 20).map((s) => ({
    id: /^[\w-]{1,40}$/.test(s.id) ? s.id : crypto.randomBytes(6).toString('hex'),
    name: String(s.name || 'Signature').slice(0, 60),
    html: cleanHtml(s.html),
  }));
  const valid = (v) => (v === 'company' || v === null || list.some((s) => s.id === v) ? v : null);
  const data = { signatures: list, defaultNew: valid(req.body.defaultNew ?? null), defaultReply: valid(req.body.defaultReply ?? null) };
  q.run('INSERT INTO user_signatures(email, data) VALUES(?, ?) ON CONFLICT(email) DO UPDATE SET data = excluded.data', req.user.email, JSON.stringify(data));
  res.json(data);
}));

// Users may keep their own phone numbers up to date; title/department are set by admins.
signatures.patch('/profile', wrap(async (req, res) => {
  saveProfile(req.user.email, { phone: req.body.phone, mobile: req.body.mobile });
  res.json(getProfile(req.user.email));
}));

// ---- admin: company signature
function requireOrgAdmin(req, orgId) {
  const r = rolesFor(req.user.email);
  const id = Number(orgId);
  if (!q.get('SELECT 1 FROM orgs WHERE id = ?', id)) throw fail(404, 'Organization not found');
  if (!r.superAdmin && !r.orgs.some((o) => o.id === id && o.role === 'admin')) throw fail(403, 'You are not an admin of this organization');
  return id;
}

signatures.get('/admin/orgs/:id/signature', wrap(async (req, res) => {
  const id = requireOrgAdmin(req, req.params.id);
  res.json({ ...getOrgSignature(id), placeholders: PLACEHOLDERS });
}));

signatures.put('/admin/orgs/:id/signature', wrap(async (req, res) => {
  const id = requireOrgAdmin(req, req.params.id);
  const mode = ['off', 'default', 'enforced'].includes(req.body.mode) ? req.body.mode : 'off';
  const v = req.body.vars || {};
  const vars = {
    company: String(v.company || '').slice(0, 120), website: String(v.website || '').slice(0, 200),
    address: String(v.address || '').slice(0, 300), logo: /^https?:\/\//.test(v.logo || '') ? String(v.logo).slice(0, 500) : '',
  };
  q.run(`INSERT INTO org_signatures(org_id, html, mode, on_replies, vars, updated_by, updated_at) VALUES(?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(org_id) DO UPDATE SET html = excluded.html, mode = excluded.mode, on_replies = excluded.on_replies,
         vars = excluded.vars, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  id, cleanHtml(req.body.html), mode, req.body.onReplies === false ? 0 : 1, JSON.stringify(vars), req.user.email);
  audit(req.user.email, id, 'signature.update', { mode });
  res.json(getOrgSignature(id));
}));

// Live preview of an unsaved template for any user in the org
signatures.post('/admin/orgs/:id/signature/preview', wrap(async (req, res) => {
  const id = requireOrgAdmin(req, req.params.id);
  const email = String(req.body.email || '').toLowerCase();
  const sample = { name: 'Alex Morgan', title: 'Sales Manager', department: 'Sales', phone: '+1 (555) 010-2030', mobile: '+1 (555) 010-4050' };
  const org = getOrgSignature(id);
  const vars = { ...org.vars, ...(req.body.vars || {}) };
  if (email && orgIdForEmail(email) === id) {
    const r = await orgSignatureFor(email, { template: cleanHtml(req.body.html), vars });
    return res.json({ html: r.rendered });
  }
  const domain = q.get("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", id)?.domain || 'example.com';
  res.json({ html: renderTemplate(cleanHtml(req.body.html), { ...vars, ...sample, first_name: 'Alex', email: `alex@${domain}` }) });
}));
