// Signature builder: 20 professional styles that turn the person's details into email-safe HTML.
// Email apps (Outlook, Gmail, Apple Mail, phones) only reliably show tables with inline styles, so every style is built
// from tables, inline CSS, web-safe fonts and plain links; no classes, no external CSS, no background images.

export const FONTS = [
  ['Arial, Helvetica, sans-serif', 'Arial'], ['Helvetica, Arial, sans-serif', 'Helvetica'], ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['Tahoma, Geneva, sans-serif', 'Tahoma'], ["'Trebuchet MS', Helvetica, sans-serif", 'Trebuchet MS'], ["'Segoe UI', Tahoma, Arial, sans-serif", 'Segoe UI'],
  ['Calibri, Candara, Arial, sans-serif', 'Calibri'], ['Georgia, serif', 'Georgia'], ["'Times New Roman', Times, serif", 'Times New Roman'],
  ["'Palatino Linotype', Palatino, 'Book Antiqua', serif", 'Palatino'], ["Garamond, 'EB Garamond', Georgia, serif", 'Garamond'],
  ["'Courier New', Courier, monospace", 'Courier New'],
];

export const SOCIALS = [
  ['linkedin', 'LinkedIn', '#0a66c2'], ['x', 'X', '#000000'], ['facebook', 'Facebook', '#1877f2'], ['instagram', 'Instagram', '#e1306c'],
  ['youtube', 'YouTube', '#ff0000'], ['tiktok', 'TikTok', '#010101'], ['github', 'GitHub', '#24292f'], ['whatsapp', 'WhatsApp', '#25d366'],
  ['website', 'Website', '#475569'],
];

export const PHONE_LABELS = ['Phone', 'Mobile', 'Office', 'Direct', 'Fax', 'Toll-free'];
export const EMAIL_LABELS = ['Email', 'Support', 'Sales', 'Billing'];

export const blankDesign = (seed = {}) => ({
  style: 'classic', font: FONTS[0][0], size: 13, nameSize: 18, color: '#1f2937', accent: '#1d4ed8', muted: '#6b7280',
  name: '', title: '', department: '', company: '', phones: [], emails: [], website: '', address: '',
  booking: { label: 'Book a meeting', url: '' }, socials: [], logo: { url: '', width: 110 },
  disclosure: '', disclosureSize: 10, ...seed,
});

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Only web, mail and phone links; anything else is dropped. A bare domain becomes https://. */
export function safeUrl(u, kind = 'web') {
  const s = String(u || '').trim();
  if (!s) return '';
  if (kind === 'tel') { const n = s.replace(/[^\d+]/g, ''); return n ? `tel:${n}` : ''; }
  if (kind === 'mail') return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s) ? `mailto:${s}` : '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return `https://${s}`;
  return '';
}
const display = (url) => String(url || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
const has = (v) => !!String(v || '').trim();
const list = (a) => (Array.isArray(a) ? a.filter((x) => has(x?.value) || has(x?.url)) : []);
const px = (n, lo, hi, def) => { const v = Number(n); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def; };
const color = (c, def) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : def);

function theme(d, over = {}) {
  const font = FONTS.some(([f]) => f === d.font) ? d.font : FONTS[0][0];
  return {
    font, size: px(d.size, 10, 18, 13), nameSize: px(d.nameSize, 12, 32, 18), color: color(d.color, '#1f2937'),
    accent: color(d.accent, '#1d4ed8'), muted: color(d.muted, '#6b7280'), ...over,
  };
}
const link = (href, text, style) => (href ? `<a href="${esc(href)}" style="text-decoration:none;${style}">${esc(text)}</a>` : esc(text));

// The building blocks every style uses
function parts(d, T) {
  const base = `font-family:${T.font};font-size:${T.size}px;color:${T.color};line-height:1.45`;
  const name = has(d.name) ? `<span style="font-family:${T.font};font-size:${T.nameSize}px;font-weight:bold;color:${T.nameColor || T.color}">${esc(d.name)}</span>` : '';
  const roleBits = [d.title, d.department].filter(has).map(esc);
  const role = roleBits.length ? `<span style="font-family:${T.font};font-size:${T.size}px;color:${T.roleColor || T.muted}">${roleBits.join(', ')}</span>` : '';
  const company = has(d.company) ? `<span style="font-family:${T.font};font-size:${T.size}px;font-weight:bold;color:${T.companyColor || T.accent}">${esc(d.company)}</span>` : '';
  const label = (l) => (T.labels === false || !has(l) ? '' : `<span style="color:${T.labelColor || T.accent};font-weight:bold">${esc(T.shortLabels ? String(l)[0] : l)}${T.shortLabels ? '' : ':'}</span>&nbsp;`);
  const contacts = [
    ...list(d.phones).map((p) => `${label(p.label || 'Phone')}${link(safeUrl(p.value, 'tel'), p.value, `color:${T.color}`)}`),
    ...list(d.emails).map((e) => `${label(e.label || 'Email')}${link(safeUrl(e.value, 'mail'), e.value, `color:${T.color}`)}`),
    ...(has(d.website) ? [`${label('Web')}${link(safeUrl(d.website), display(d.website), `color:${T.linkColor || T.accent}`)}`] : []),
    ...(has(d.address) ? [`${label('Address')}<span style="color:${T.color}">${esc(d.address).replace(/\n/g, ', ')}</span>`] : []),
  ];
  const logoUrl = safeUrl(d.logo?.url);
  const logoW = px(d.logo?.width, 40, 260, 110);
  const logo = logoUrl ? `<img src="${esc(logoUrl)}" alt="${esc(d.company || d.name || 'Logo')}" width="${logoW}" style="display:block;border:0;width:${logoW}px;max-width:${logoW}px;height:auto">` : '';
  const socials = list(d.socials).map((s) => {
    const meta = SOCIALS.find(([k]) => k === s.network) || SOCIALS[SOCIALS.length - 1];
    const href = safeUrl(s.url);
    if (!href) return '';
    if (T.socialStyle === 'text') return `<a href="${esc(href)}" style="text-decoration:none;color:${T.accent};font-size:${T.size - 1}px">${esc(meta[1])}</a>`;
    const bg = T.socialStyle === 'mono' ? T.accent : meta[2];
    return `<a href="${esc(href)}" style="display:inline-block;text-decoration:none;background-color:${bg};color:#ffffff;font-family:${T.font};font-size:${Math.max(10, T.size - 2)}px;font-weight:bold;padding:3px 8px;border-radius:${T.round === false ? 0 : 3}px;margin:0 4px 0 0">${esc(meta[1])}</a>`;
  }).filter(Boolean);
  const socialSep = T.socialStyle === 'text' ? ` <span style="color:${T.muted}">&middot;</span> ` : '';
  const socialsHtml = socials.length ? socials.join(socialSep) : '';
  const bookUrl = safeUrl(d.booking?.url);
  const bookText = has(d.booking?.label) ? d.booking.label : 'Book a meeting';
  const booking = !bookUrl ? '' : T.bookingStyle === 'link'
    ? `<a href="${esc(bookUrl)}" style="text-decoration:none;color:${T.accent};font-weight:bold">&#128197; ${esc(bookText)} &rarr;</a>`
    : `<a href="${esc(bookUrl)}" style="display:inline-block;text-decoration:none;background-color:${T.accent};color:#ffffff;font-family:${T.font};font-size:${T.size}px;font-weight:bold;padding:7px 14px;border-radius:${T.round === false ? 0 : 4}px">&#128197;&nbsp;${esc(bookText)}</a>`;
  const disclosure = has(d.disclosure)
    ? `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:12px"><tr><td style="font-family:${T.font};font-size:${px(d.disclosureSize, 8, 13, 10)}px;color:#8a8f98;line-height:1.4;max-width:560px;width:560px;padding-top:8px;border-top:1px solid #e5e7eb">${esc(d.disclosure).replace(/\n/g, '<br>')}</td></tr></table>`
    : '';
  return { base, name, role, company, contacts, logo, logoW, socialsHtml, booking, disclosure };
}

const tbl = (inner, style = '') => `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;${style}">${inner}</table>`;
const lines = (arr, T, sep) => (sep
  ? arr.join(` <span style="color:${T.accent}">${sep}</span> `)
  : arr.join('<br>'));
const block = (p, T, { contactsSep, gap = 4 } = {}) => [
  p.name && `<div style="margin:0">${p.name}</div>`,
  p.role && `<div style="margin:0">${p.role}</div>`,
  p.company && `<div style="margin:0">${p.company}</div>`,
  p.contacts.length && `<div style="margin:${gap + 4}px 0 0 0;font-family:${T.font};font-size:${T.size}px;color:${T.color};line-height:1.5">${lines(p.contacts, T, contactsSep)}</div>`,
  p.socialsHtml && `<div style="margin:${gap + 4}px 0 0 0">${p.socialsHtml}</div>`,
  p.booking && `<div style="margin:${gap + 6}px 0 0 0">${p.booking}</div>`,
].filter(Boolean).join('');

// ---------------------------------------------------------------- layouts
const L = {
  // name, details under it; logo optional on top
  stack(p, T, o) {
    return tbl(`${p.logo && o.logoTop ? `<tr><td style="padding:0 0 10px 0">${p.logo}</td></tr>` : ''}<tr><td style="${p.base}">${block(p, T, o)}</td></tr>`);
  },
  // logo on the left, a vertical line, details on the right
  side(p, T, o) {
    const left = p.logo ? `<td valign="top" style="padding:0 ${o.line ? 14 : 16}px 0 0;width:${p.logoW}px">${p.logo}</td>` : '';
    const line = p.logo && o.line ? `<td style="border-left:${o.line}px solid ${T.accent};padding:0 14px 0 0">&nbsp;</td>` : '';
    return tbl(`<tr>${left}${line}<td valign="top" style="${p.base}">${block(p, T, o)}</td></tr>`);
  },
  // details left, logo right
  right(p, T, o) {
    const right = p.logo ? `<td valign="top" style="padding:0 0 0 18px;border-left:${o.line || 0}px solid ${T.accent}">${p.logo}</td>` : '';
    return tbl(`<tr><td valign="top" style="${p.base};padding-right:18px">${block(p, T, o)}</td>${right}</tr>`);
  },
  // everything centred
  center(p, T, o) {
    return tbl(`${p.logo ? `<tr><td align="center" style="padding:0 0 10px 0">${p.logo}</td></tr>` : ''}<tr><td align="center" style="${p.base};text-align:center">${block(p, T, { ...o, contactsSep: o.contactsSep || '|' })}</td></tr>`);
  },
  // coloured strip on the left edge
  bar(p, T, o) {
    return tbl(`<tr><td style="width:${o.bar || 4}px;background-color:${T.accent}">&nbsp;</td><td valign="top" style="${p.base};padding:2px 0 2px 14px">${p.logo ? `<div style="margin:0 0 8px 0">${p.logo}</div>` : ''}${block(p, T, o)}</td></tr>`);
  },
  // name and title in a coloured header band, details underneath
  banner(p, T, o) {
    const head = [p.name, p.role].filter(Boolean).join('<br>');
    const rest = { ...p, name: '', role: '' };
    return tbl(`<tr><td style="background-color:${T.accent};padding:10px 14px;border-radius:${T.round === false ? 0 : 6}px ${T.round === false ? 0 : 6}px 0 0">${p.logo ? `<table cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-right:12px">${p.logo}</td><td>${head}</td></tr></table>` : head}</td></tr><tr><td style="${p.base};padding:10px 14px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 ${T.round === false ? 0 : 6}px ${T.round === false ? 0 : 6}px">${block(rest, T, o)}</td></tr>`, 'min-width:300px');
  },
  // boxed card
  card(p, T, o) {
    return tbl(`<tr><td style="border:1px solid ${o.border || '#e5e7eb'};border-radius:${T.round === false ? 0 : 8}px;padding:14px 16px;background-color:${o.bg || '#ffffff'}">${L.side(p, T, { ...o, line: o.line })}</td></tr>`);
  },
  // horizontal rule between the name block and the details
  rule(p, T, o) {
    const top = [p.name, p.role, p.company].filter(Boolean).map((x) => `<div style="margin:0">${x}</div>`).join('');
    const rest = block({ ...p, name: '', role: '', company: '' }, T, o);
    return tbl(`<tr><td style="${p.base}">${p.logo && o.logoTop ? `<div style="margin:0 0 8px 0">${p.logo}</div>` : ''}${top}</td></tr><tr><td style="padding:8px 0 0 0"><div style="border-top:${o.ruleW || 2}px solid ${T.accent};width:${o.ruleLen || 60}px;line-height:0;font-size:0">&nbsp;</div></td></tr><tr><td style="${p.base}">${rest}</td></tr>`);
  },
  // two columns: who on the left, how to reach on the right
  columns(p, T, o) {
    const who = [p.logo ? `<div style="margin:0 0 8px 0">${p.logo}</div>` : '', p.name && `<div>${p.name}</div>`, p.role && `<div>${p.role}</div>`, p.company && `<div>${p.company}</div>`].filter(Boolean).join('');
    const how = block({ ...p, name: '', role: '', company: '' }, T, o);
    return tbl(`<tr><td valign="top" style="${p.base};padding-right:18px;border-right:1px solid ${T.accent}">${who}</td><td valign="top" style="${p.base};padding-left:18px">${how}</td></tr>`);
  },
  // everything on two short lines
  compact(p, T) {
    const first = [p.name, p.role, p.company].filter(Boolean).join(` <span style="color:${T.muted}">|</span> `);
    const second = [...p.contacts, p.socialsHtml].filter(Boolean).join(` <span style="color:${T.muted}">|</span> `);
    return tbl(`<tr>${p.logo ? `<td valign="middle" style="padding-right:12px">${p.logo}</td>` : ''}<td valign="middle" style="${p.base}">${first}${second ? `<br>${second}` : ''}${p.booking ? `<div style="margin-top:6px">${p.booking}</div>` : ''}</td></tr>`);
  },
};

// ---------------------------------------------------------------- the 20 styles
export const STYLES = [
  { id: 'classic', name: 'Classic', layout: 'stack', t: {} },
  { id: 'modern', name: 'Modern', layout: 'side', o: { line: 2 }, t: { shortLabels: true } },
  { id: 'minimal', name: 'Minimal', layout: 'stack', t: { labels: false, socialStyle: 'text', bookingStyle: 'link', companyColor: '#1f2937' } },
  { id: 'bold', name: 'Bold name', layout: 'stack', t: { nameBoost: 6, nameColor: 'accent' } },
  { id: 'logo-left', name: 'Logo left', layout: 'side', o: { line: 0 }, t: {} },
  { id: 'logo-right', name: 'Logo right', layout: 'right', o: { line: 2 }, t: {} },
  { id: 'centered', name: 'Centred', layout: 'center', t: { labels: false, socialStyle: 'text' } },
  { id: 'divider', name: 'Divider line', layout: 'rule', o: { logoTop: true }, t: {} },
  { id: 'accent-bar', name: 'Accent bar', layout: 'bar', o: { bar: 4 }, t: {} },
  { id: 'card', name: 'Card', layout: 'card', o: { line: 0 }, t: {} },
  { id: 'banner', name: 'Banner', layout: 'banner', t: { nameColor: '#ffffff', roleColor: '#e5e7eb' } },
  { id: 'compact', name: 'Compact', layout: 'compact', t: { labels: false, socialStyle: 'text', bookingStyle: 'link' } },
  { id: 'executive', name: 'Executive', layout: 'rule', o: { ruleW: 1, ruleLen: 220 }, t: { fontDefault: 'Georgia, serif', labels: false, companyColor: '#111827', socialStyle: 'text' } },
  { id: 'corporate', name: 'Corporate', layout: 'columns', t: { shortLabels: true, round: false } },
  { id: 'creative', name: 'Creative', layout: 'bar', o: { bar: 8 }, t: { nameBoost: 4, nameColor: 'accent', socialStyle: 'mono' } },
  { id: 'elegant', name: 'Elegant serif', layout: 'center', o: { contactsSep: '&middot;' }, t: { fontDefault: "'Palatino Linotype', Palatino, 'Book Antiqua', serif", labels: false, socialStyle: 'text', bookingStyle: 'link' } },
  { id: 'tech', name: 'Tech', layout: 'side', o: { line: 3 }, t: { fontDefault: "'Courier New', Courier, monospace", shortLabels: true, round: false, socialStyle: 'mono' } },
  { id: 'agent', name: 'Agent / sales', layout: 'card', o: { line: 3, bg: '#f9fafb' }, t: { nameBoost: 2 } },
  { id: 'professional', name: 'Professional services', layout: 'side', o: { line: 1 }, t: { fontDefault: "'Times New Roman', Times, serif", labels: true, socialStyle: 'text', bookingStyle: 'link', round: false } },
  { id: 'split', name: 'Two column', layout: 'columns', t: { labels: false, socialStyle: 'mono' } },
];

/** Build the HTML for a design. The style's font is used unless the person picked their own. */
export function renderSignature(design) {
  const d = blankDesign(design);
  const S = STYLES.find((s) => s.id === d.style) || STYLES[0];
  const st = S.t || {};
  const fontPicked = d.fontPicked && FONTS.some(([f]) => f === d.font);
  let T = theme({ ...d, font: fontPicked ? d.font : st.fontDefault || d.font });
  T = { ...T, ...st, font: T.font };
  if (st.nameBoost) T.nameSize = Math.min(34, T.nameSize + st.nameBoost);
  if (st.nameColor === 'accent') T.nameColor = T.accent;
  const p = parts(d, T);
  const html = L[S.layout](p, T, S.o || {});
  return `<div style="font-family:${T.font};font-size:${T.size}px;color:${T.color}">${html}${p.disclosure}</div>`;
}

/** A design is "empty" until it has at least a name or a company. */
export const designReady = (d) => has(d?.name) || has(d?.company);
