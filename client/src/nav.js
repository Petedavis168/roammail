// URLs: roammail.net/{mailboxId}/{section}, sign-in on login.roammail.net (or /login in development).
export const ID_PATH = /^\/(\d{8}|\d{6}-\d{3}-[A-Z]{2})(?:\/(.*))?$/;

let hosts = { rootDomain: null, loginHost: null, adminHost: null };
export const setHosts = (h) => { hosts = { rootDomain: h?.rootDomain || null, loginHost: h?.loginHost || null, adminHost: h?.adminHost || null }; };
export const onAdminHost = () => !!hosts.adminHost && location.hostname === hosts.adminHost;
export const adminHref = (id) => (hosts.adminHost ? `https://${hosts.adminHost}/${id}/admin` : `/${id}/admin`);
export const onLoginHost = () => !!hosts.loginHost && location.hostname === hosts.loginHost;
export const loginHref = (qs = '') => (hosts.loginHost ? `https://${hosts.loginHost}/${qs}` : `/login${qs}`);
export const signupHref = (qs = '') => (hosts.loginHost ? `https://${hosts.loginHost}/signup${qs}` : `/signup${qs}`);
export const appHref = (path) => (hosts.rootDomain ? `https://${hosts.rootDomain}${path}` : path);
export const homeHref = () => appHref('/');

/** Parse the current location: { id, section, arg } for app URLs, or { page: 'signin' | 'signup' }. */
export function parseLocation() {
  const m = ID_PATH.exec(location.pathname);
  if (m) {
    const [section = 'inbox', ...rest] = (m[2] || 'inbox').split('/');
    return { id: m[1], section, arg: rest.length ? decodeURIComponent(rest.join('/')) : '' };
  }
  return { page: /\/signup\/?$/.test(location.pathname) ? 'signup' : 'signin' };
}

// Message IDs in URLs: base64url(folder) + "." + uid (never an address)
const b64 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
export const messageKey = (folder, uid) => `${b64(folder)}.${uid}`;
export function parseMessageKey(k) { try { const [f, u] = String(k).split('.'); return { folder: unb64(f), uid: Number(u) }; } catch { return null; } }

// Folder <-> section names
export const SPECIAL_SECTIONS = { sent: '\\Sent', drafts: '\\Drafts', spam: '\\Junk', trash: '\\Trash', archive: '\\Archive' };
export function sectionForFolder(folder, folders) {
  if (folder === 'INBOX') return 'inbox';
  if (folder === '@scheduled') return 'scheduled';
  if (folder === '@quarantine') return 'quarantine';
  if (folder === '@all') return 'all';
  const f = folders.find((x) => x.path === folder);
  for (const [s, use] of Object.entries(SPECIAL_SECTIONS)) if (f?.specialUse === use) return s;
  return `folder/${encodeURIComponent(folder)}`;
}
export function folderForSection(section, arg, folders) {
  if (section === 'inbox') return 'INBOX';
  if (section === 'scheduled') return '@scheduled';
  if (section === 'quarantine') return '@quarantine';
  if (section === 'all') return '@all';
  if (section === 'folder') return arg || 'INBOX';
  const use = SPECIAL_SECTIONS[section];
  if (use) return folders.find((x) => x.specialUse === use)?.path || null;
  return null;
}
