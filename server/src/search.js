// Translate Gmail-style queries into IMAP SEARCH criteria for imapflow.
// Supports: from: to: cc: subject: has:attachment is:unread is:read is:starred
// is:flagged before:YYYY-MM-DD after:YYYY-MM-DD newer_than:7d older_than:1m
// larger:5M smaller:100K label:<category> in:<folder> "quoted phrases" and -negation.

function tokenize(q) {
  const out = [];
  const re = /(-?)(\w+):("[^"]*"|\S+)|(-?)("[^"]*"|\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[2]) out.push({ neg: !!m[1], key: m[2].toLowerCase(), value: m[3].replace(/^"|"$/g, '') });
    else out.push({ neg: !!m[4], key: null, value: m[5].replace(/^"|"$/g, '') });
  }
  return out;
}

function relDate(v) {
  const m = /^(\d+)([dwmy])$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const d = new Date();
  const unit = m[2].toLowerCase();
  if (unit === 'd') d.setDate(d.getDate() - n);
  if (unit === 'w') d.setDate(d.getDate() - n * 7);
  if (unit === 'm') d.setMonth(d.getMonth() - n);
  if (unit === 'y') d.setFullYear(d.getFullYear() - n);
  return d;
}

function size(v) {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(v);
  if (!m) return null;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

export function parseQuery(q = '') {
  const criteria = {};
  const nots = [];
  let folder = null;
  const words = [];

  for (const t of tokenize(q.trim())) {
    const c = {};
    switch (t.key) {
      case 'from': case 'to': case 'cc': case 'bcc': case 'subject': case 'body':
        c[t.key] = t.value; break;
      case 'has':
        if (/^attachments?$/.test(t.value)) c.header = { 'Content-Type': 'multipart/mixed' };
        break;
      case 'is':
        if (t.value === 'unread') c.seen = false;
        else if (t.value === 'read') c.seen = true;
        else if (t.value === 'starred' || t.value === 'flagged') c.flagged = true;
        else if (t.value === 'answered' || t.value === 'replied') c.answered = true;
        break;
      case 'before': case 'older': c.before = new Date(t.value); break;
      case 'after': case 'newer': case 'since': c.since = new Date(t.value); break;
      case 'older_than': { const d = relDate(t.value); if (d) c.before = d; break; }
      case 'newer_than': { const d = relDate(t.value); if (d) c.since = d; break; }
      case 'larger': { const s = size(t.value); if (s) c.larger = s; break; }
      case 'smaller': { const s = size(t.value); if (s) c.smaller = s; break; }
      case 'label': case 'category': c.keyword = `cat_${t.value}`; break;
      case 'in': folder = t.value; continue;
      default:
        if (t.key) words.push(`${t.key}:${t.value}`);
        else words.push(t.value);
        if (t.neg) nots.push({ text: words.pop() });
        continue;
    }
    if (Object.keys(c).length === 0) continue;
    if (t.neg) nots.push(c);
    else Object.assign(criteria, c);
  }

  if (words.length) criteria.text = words.join(' ');
  if (nots.length === 1) criteria.not = nots[0];
  else if (nots.length > 1) criteria.not = { or: nots };
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return { criteria, folder };
}
