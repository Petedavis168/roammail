// Minimal CalDAV / CardDAV client (RFC 4791 / 6352) for mailcow's SOGo, using standard discovery.
import { XMLParser } from 'fast-xml-parser';
import { config } from './config.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, processEntities: true, htmlEntities: false, isArray: (n) => ['response', 'propstat', 'comp', 'href'].includes(n) });
const origin = () => new URL(config.davUrl).origin;
const cache = new Map(); // sid -> { at, principal, calHome, cardHome }

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function dav(user, method, url, body, headers = {}) {
  const full = new URL(url, config.davUrl);
  if (full.origin !== origin()) throw fail(400, 'Invalid calendar address'); // never follow hrefs to other hosts
  const res = await fetch(full, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${user.email}:${user.password}`).toString('base64')}`,
      ...(body ? { 'Content-Type': headers['Content-Type'] || 'application/xml; charset=utf-8' } : {}),
      ...headers,
    },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401) throw fail(502, 'The calendar server refused your sign-in');
  return res;
}

async function propfind(user, url, depth, props) {
  const res = await dav(user, 'PROPFIND', url, `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cr="urn:ietf:params:xml:ns:carddav" xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${props}</d:prop></d:propfind>`, { Depth: String(depth) });
  if (res.status !== 207) throw fail(502, `Calendar server error (${res.status})`);
  return parseMultistatus(await res.text());
}

function parseMultistatus(xml) {
  const doc = parser.parse(xml);
  return (doc.multistatus?.response || []).map((r) => {
    const ok = (r.propstat || []).find((p) => String(p.status || '').includes(' 200')) || {};
    return { href: decodeURI(String(r.href?.[0] ?? '')), prop: ok.prop || {}, status: r.status };
  });
}
const hrefOf = (v) => (v && typeof v === 'object' ? String(v.href?.[0] ?? '') : String(v || ''));

/** Locate the user's principal, calendar home and address book home (cached per session). */
export async function discover(user) {
  const c = cache.get(user.sid);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c;
  const root = await propfind(user, config.davUrl, 0, '<d:current-user-principal/>');
  const principal = hrefOf(root[0]?.prop?.['current-user-principal']) || `${new URL(config.davUrl).pathname}${encodeURIComponent(user.email)}/`;
  const p = await propfind(user, principal, 0, '<c:calendar-home-set/><cr:addressbook-home-set/>');
  const out = {
    at: Date.now(), principal,
    calHome: hrefOf(p[0]?.prop?.['calendar-home-set']) || principal,
    cardHome: hrefOf(p[0]?.prop?.['addressbook-home-set']) || principal,
  };
  cache.set(user.sid, out);
  return out;
}

/** Make sure a client-supplied href points inside this user's own calendar/address book home. */
export function assertOwnHref(href, home) {
  const path = decodeURI(new URL(href, config.davUrl).pathname);
  const h = decodeURI(new URL(home, config.davUrl).pathname);
  if (!path.startsWith(h) || path.includes('/../') || path.includes('/./')) throw fail(403, 'Not allowed');
  return path;
}

const COLORS = ['#244960', '#c239b3', '#038387', '#ca5010', '#498205', '#8764b8', '#d13438', '#986f0b'];

export async function listCollections(user, kind) {
  const d = await discover(user);
  const home = kind === 'calendar' ? d.calHome : d.cardHome;
  const items = await propfind(user, home, 1, '<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><cs:getctag/>');
  const out = [];
  items.forEach((r, i) => {
    const rt = r.prop.resourcetype || {};
    const isCal = rt.calendar !== undefined; const isBook = rt.addressbook !== undefined;
    if (kind === 'calendar' && isCal) {
      const comps = r.prop['supported-calendar-component-set']?.comp;
      const supportsEvents = !comps || JSON.stringify(comps).includes('VEVENT') || JSON.stringify(r.prop['supported-calendar-component-set']).includes('VEVENT');
      if (!supportsEvents) return;
      const color = String(r.prop['calendar-color'] || '').slice(0, 7);
      out.push({ href: r.href, name: String(r.prop.displayname || 'Calendar'), color: /^#[0-9a-f]{6}$/i.test(color) ? color : COLORS[out.length % COLORS.length] });
    }
    if (kind === 'addressbook' && isBook) out.push({ href: r.href, name: String(r.prop.displayname || 'Contacts') });
  });
  if (!out.length) {
    // Servers without a default collection (SOGo always has one; others may not): create it
    const href = `${home.replace(/\/?$/, '/')}${kind === 'calendar' ? 'personal' : 'contacts'}/`;
    if (kind === 'calendar') {
      await dav(user, 'MKCALENDAR', href, `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Calendar</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`);
      out.push({ href, name: 'Calendar', color: COLORS[0] });
    } else {
      await dav(user, 'MKCOL', href, `<?xml version="1.0" encoding="utf-8"?><d:mkcol xmlns:d="DAV:" xmlns:cr="urn:ietf:params:xml:ns:carddav"><d:set><d:prop><d:resourcetype><d:collection/><cr:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname></d:prop></d:set></d:mkcol>`);
      out.push({ href, name: 'Contacts' });
    }
  }
  return out;
}

export async function createCalendar(user, name, color) {
  const d = await discover(user);
  const href = `${d.calHome.replace(/\/?$/, '/')}${crypto.randomUUID()}/`;
  const res = await dav(user, 'MKCALENDAR', href, `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>${esc(name)}</d:displayname><a:calendar-color>${esc(color)}</a:calendar-color><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`);
  if (res.status >= 300) throw fail(502, `Could not create the calendar (${res.status})`);
  return { href, name, color };
}

/** REPORT returning [{href, etag, data}] for calendar-query or addressbook-query. */
export async function report(user, href, body) {
  const res = await dav(user, 'REPORT', href, body, { Depth: '1' });
  if (res.status !== 207) throw fail(502, `Calendar server error (${res.status})`);
  return parseMultistatus(await res.text()).map((r) => ({
    href: r.href, etag: String(r.prop.getetag || ''), data: String(r.prop['calendar-data'] ?? r.prop['address-data'] ?? ''),
  })).filter((r) => r.data);
}

export async function putResource(user, href, body, contentType, etag) {
  const headers = { 'Content-Type': contentType };
  if (etag) headers['If-Match'] = etag; else headers['If-None-Match'] = '*';
  const res = await dav(user, 'PUT', href, body, headers);
  if (res.status === 412) throw fail(409, 'This item was changed somewhere else (maybe on your phone). Reload and try again.');
  if (res.status >= 300) throw fail(502, `The calendar server refused the change (${res.status})`);
  return res.headers.get('etag') || '';
}

export async function deleteResource(user, href, etag) {
  const res = await dav(user, 'DELETE', href, undefined, etag ? { 'If-Match': etag } : {});
  if (res.status === 412) throw fail(409, 'This item was changed somewhere else. Reload and try again.');
  if (res.status >= 300 && res.status !== 404) throw fail(502, `The calendar server refused the delete (${res.status})`);
}

export async function getResource(user, href) {
  const res = await dav(user, 'GET', href);
  if (res.status !== 200) throw fail(404, 'Not found');
  return { data: await res.text(), etag: res.headers.get('etag') || '' };
}

export const xmlEscape = esc;
