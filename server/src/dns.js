// DNS records a business domain needs, plus live checks against public resolvers.
import { Resolver } from 'node:dns/promises';
import { config } from './config.js';

const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers((process.env.DNS_SERVERS || '1.1.1.1,8.8.8.8').split(','));

const norm = (s) => String(s || '').toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ').trim();
const txt = async (name) => { try { return (await resolver.resolveTxt(name)).map((c) => c.join('')); } catch { return []; } };

export const verifyRecord = (domain, token) => ({
  type: 'TXT', host: '@', name: domain, value: `mailcow-verify=${token}`, purpose: 'Proves you own this domain',
});

export function requiredRecords(domain, dkim) {
  const mx = config.mailHostname;
  const recs = [
    { key: 'mx', type: 'MX', host: '@', name: domain, value: mx, priority: 10, purpose: 'Delivers mail for your domain to us' },
    { key: 'spf', type: 'TXT', host: '@', name: domain, value: `v=spf1 mx a:${mx} ~all`, purpose: 'Authorises our server to send as you (SPF)' },
  ];
  if (dkim) recs.push({ key: 'dkim', type: 'TXT', host: `${dkim.selector}._domainkey`, name: `${dkim.selector}._domainkey.${domain}`, value: dkim.txt, purpose: 'Signs your outgoing mail (DKIM)' });
  recs.push(
    { key: 'dmarc', type: 'TXT', host: '_dmarc', name: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, purpose: 'Tells others what to do with spoofed mail (DMARC)' },
    { key: 'srv-imaps', type: 'SRV', host: '_imaps._tcp', name: `_imaps._tcp.${domain}`, value: `0 1 993 ${mx}`, purpose: 'Phones & apps find your mail server automatically', optional: true },
    { key: 'srv-submission', type: 'SRV', host: '_submission._tcp', name: `_submission._tcp.${domain}`, value: `0 1 587 ${mx}`, purpose: 'Apps find the sending server automatically', optional: true },
    { key: 'srv-autodiscover', type: 'SRV', host: '_autodiscover._tcp', name: `_autodiscover._tcp.${domain}`, value: `0 1 443 ${mx}`, purpose: 'Outlook auto-setup', optional: true },
    { key: 'autodiscover', type: 'CNAME', host: 'autodiscover', name: `autodiscover.${domain}`, value: mx, purpose: 'Outlook / phone auto-setup', optional: true },
    { key: 'autoconfig', type: 'CNAME', host: 'autoconfig', name: `autoconfig.${domain}`, value: mx, purpose: 'Thunderbird / phone auto-setup', optional: true },
  );
  return recs;
}

// Local development only: never honored in production (the Docker image sets NODE_ENV=production)
const DEV_SKIP = process.env.DEV_SKIP_DNS_VERIFY === 'true' && process.env.NODE_ENV !== 'production';
if (DEV_SKIP) console.warn('WARNING: DEV_SKIP_DNS_VERIFY is on - domain ownership is NOT checked. Never use this in production.');

export async function checkVerification(domain, token) {
  if (DEV_SKIP) return true;
  return (await txt(domain)).some((v) => v.trim() === `mailcow-verify=${token}`);
}

export async function checkRecords(domain, dkim) {
  const recs = requiredRecords(domain, dkim);
  const out = [];
  for (const r of recs) {
    let ok = false;
    let found = [];
    try {
      if (r.type === 'MX') {
        found = (await resolver.resolveMx(r.name)).map((m) => m.exchange);
        ok = found.some((x) => norm(x) === norm(r.value));
      } else if (r.type === 'SRV') {
        const recs = await resolver.resolveSrv(r.name).catch(() => []);
        found = recs.map((x) => `${x.priority} ${x.weight} ${x.port} ${x.name}`);
        const port = Number(r.value.split(' ')[2]);
        ok = recs.some((x) => x.port === port && norm(x.name) === norm(r.value.split(' ')[3]));
      } else if (r.type === 'CNAME') {
        found = await resolver.resolveCname(r.name).catch(() => []);
        ok = found.some((x) => norm(x) === norm(r.value));
      } else if (r.key === 'spf') {
        found = (await txt(r.name)).filter((v) => v.startsWith('v=spf1'));
        ok = found.some((v) => / mx( |$)/.test(v) || v.includes(config.mailHostname));
      } else if (r.key === 'dkim') {
        found = await txt(r.name);
        const want = norm(r.value).replace(/ /g, '');
        ok = found.some((v) => norm(v).replace(/ /g, '') === want);
      } else if (r.key === 'dmarc') {
        found = (await txt(r.name)).filter((v) => v.startsWith('v=DMARC1'));
        ok = found.length > 0;
      }
    } catch { /* not found */ }
    out.push({ ...r, ok, found });
  }
  return out;
}
