export function fmtDate(iso, long = false) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (long) return d.toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString();
}

export function dateGroup(iso) {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 14) return 'Last week';
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return 'This month';
  return d.toLocaleDateString([], { month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export const personName = (a) => a?.name || a?.address?.split('@')[0] || 'Unknown';
export const fmtAddr = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
export const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

const COLORS = ['#0f6cbd', '#c239b3', '#038387', '#ca5010', '#8764b8', '#498205', '#d13438', '#005b70', '#986f0b', '#4f6bed'];
export function avatarColor(s = '') {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}
export function initials(a) {
  const n = personName(a).replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/);
  return ((n[0]?.[0] || '?') + (n.length > 1 ? n[n.length - 1][0] : '')).toUpperCase();
}

export const CATEGORY_COLORS = { Red: '#d13438', Orange: '#ca5010', Yellow: '#c19c00', Green: '#498205', Blue: '#0f6cbd', Purple: '#8764b8' };

export function folderIcon(f) {
  switch (f.specialUse) {
    case '\\Inbox': return 'inbox';
    case '\\Sent': return 'send';
    case '\\Drafts': return 'draft';
    case '\\Trash': return 'trash';
    case '\\Junk': return 'junk';
    case '\\Archive': return 'archive';
    default: return 'folder';
  }
}
export const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
export function folderLabel(f) {
  const names = { '\\Inbox': 'Inbox', '\\Sent': 'Sent Items', '\\Drafts': 'Drafts', '\\Trash': 'Deleted Items', '\\Junk': 'Junk Email', '\\Archive': 'Archive' };
  return names[f.specialUse] || f.name;
}

export function escapeHtml(s = '') {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
