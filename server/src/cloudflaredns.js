// One-click DNS for domains on Cloudflare: the customer pastes a Cloudflare API token (permission "Zone → DNS →
// Edit" for that one domain) and we add every record their email needs. The token is used once and never stored.
// Mail records (MX, SPF, DMARC) replace the old ones (that's what moving email means); everything else is only added.
const API = process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

async function cf(token, method, path, body) {
  const r = await fetch(`${API}${path}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = j.errors?.[0]?.message || `Cloudflare said ${r.status}`;
    throw fail(r.status === 401 || r.status === 403 ? 400 : 502, /auth|token|permission/i.test(msg) ? 'Cloudflare didn’t accept that token. Make sure it can edit DNS for this domain.' : `Cloudflare: ${msg}`);
  }
  return j.result;
}

const toCf = (rec, domain) => {
  const name = rec.host === '@' ? domain : `${rec.host}.${domain}`;
  if (rec.type === 'MX') return { type: 'MX', name, content: rec.value, priority: rec.priority || 10, ttl: 1 };
  if (rec.type === 'SRV') { const [priority, weight, port, target] = rec.value.split(/\s+/); return { type: 'SRV', name, data: { priority: +priority, weight: +weight, port: +port, target }, ttl: 1 }; }
  if (rec.type === 'CNAME') return { type: 'CNAME', name, content: rec.value, proxied: false, ttl: 1 };
  return { type: 'TXT', name, content: rec.value, ttl: 1 };
};
const same = (a, b) => a.type === b.type && a.name.toLowerCase() === b.name.toLowerCase()
  && (a.type === 'SRV' ? String(a.data?.target).replace(/\.$/, '') === String(b.data?.target).replace(/\.$/, '') && Number(a.data?.port) === Number(b.data?.port) : String(a.content).replace(/^"|"$/g, '').replace(/\.$/, '') === String(b.content).replace(/^"|"$/g, '').replace(/\.$/, ''));

/** Add the records. Returns { added, replaced, kept }. */
export async function applyCloudflare(token, domain, records) {
  const t = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(t)) throw fail(400, 'Paste the API token Cloudflare showed you (it’s about 40 letters and numbers)');
  const zones = await cf(t, 'GET', `/zones?name=${encodeURIComponent(domain)}&status=active`);
  const zone = zones?.[0];
  if (!zone) throw fail(400, `This token can’t see ${domain} on Cloudflare. Check the domain is in that Cloudflare account and the token covers it.`);
  const existing = await cf(t, 'GET', `/zones/${zone.id}/dns_records?per_page=500`);
  const out = { added: 0, replaced: 0, kept: 0 };
  for (const rec of records) {
    const want = toCf(rec, domain);
    if (existing.some((e) => same(e, want))) { out.kept++; continue; }
    // moving email: the old mail server, SPF and DMARC make way for ours
    const old = existing.filter((e) => e.type === want.type && e.name.toLowerCase() === want.name.toLowerCase()
      && (want.type === 'MX' || (want.type === 'TXT' && (/^"?v=spf1/i.test(e.content) && /^v=spf1/i.test(want.content) || /^"?v=DMARC1/i.test(e.content) && /^v=DMARC1/i.test(want.content)))));
    for (const e of old) { await cf(t, 'DELETE', `/zones/${zone.id}/dns_records/${e.id}`); out.replaced++; }
    if (want.type === 'CNAME' && existing.some((e) => e.name.toLowerCase() === want.name.toLowerCase() && e.type !== 'CNAME')) { out.kept++; continue; } // something else lives there: leave it
    await cf(t, 'POST', `/zones/${zone.id}/dns_records`, want);
    out.added++;
  }
  return out;
}
