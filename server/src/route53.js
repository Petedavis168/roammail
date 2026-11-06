// Optional: add a domain's DNS records automatically when its zone lives in your AWS account.
import { Route53Client, ListHostedZonesByNameCommand, ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand } from '@aws-sdk/client-route-53';
import { config } from './config.js';

let client;
const r53 = () => (client ||= new Route53Client({ region: config.awsRegion }));

export async function findZone(domain) {
  if (!config.route53Enabled) return null;
  try {
    const res = await r53().send(new ListHostedZonesByNameCommand({ DNSName: domain, MaxItems: 1 }));
    const z = res.HostedZones?.[0];
    if (z && z.Name.replace(/\.$/, '') === domain && !z.Config?.PrivateZone) return z.Id.replace('/hostedzone/', '');
  } catch (e) {
    console.warn('Route53 lookup failed:', e.message);
  }
  return null;
}

// TXT values over 255 chars must be split into quoted chunks.
const txtValue = (v) => (v.match(/.{1,255}/g) || ['']).map((c) => `"${c.replace(/"/g, '\\"')}"`).join(' ');

export async function applyRecords(zoneId, domain, records) {
  // Merge all TXT values for the same name into a single record set (Route 53 requirement).
  const sets = new Map();
  for (const r of records) {
    const key = `${r.type}:${r.name}`;
    const set = sets.get(key) || { Name: r.name, Type: r.type, TTL: 300, ResourceRecords: [] };
    const value = r.type === 'MX' ? `${r.priority} ${r.value}.` : r.type === 'CNAME' ? `${r.value}.` : txtValue(r.value);
    set.ResourceRecords.push({ Value: value });
    sets.set(key, set);
  }
  // Keep existing TXT values on the same name (e.g. site verifications), replacing only old SPF records.
  for (const set of sets.values()) {
    if (set.Type !== 'TXT') continue;
    const cur = await r53().send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: set.Name, StartRecordType: 'TXT', MaxItems: 1 }));
    const existing = cur.ResourceRecordSets?.find((r) => r.Type === 'TXT' && r.Name.replace(/\.$/, '') === set.Name);
    const replacingSpf = set.ResourceRecords.some((r) => r.Value.startsWith('"v=spf1'));
    for (const r of existing?.ResourceRecords || []) {
      if (replacingSpf && r.Value.startsWith('"v=spf1')) continue;
      if (!set.ResourceRecords.some((x) => x.Value === r.Value)) set.ResourceRecords.push(r);
    }
  }
  await r53().send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: zoneId,
    ChangeBatch: {
      Comment: `Mail setup for ${domain}`,
      Changes: [...sets.values()].map((s) => ({ Action: 'UPSERT', ResourceRecordSet: s })),
    },
  }));
}
