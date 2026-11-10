// Look-alike senders: phishing often comes from domains that look like a well-known company's (paypa1.com,
// rnicrosoft.com, amazon-support.co) or uses a company's name with someone else's address ("PayPal" <x@gmail.com>).
const BRANDS = {
  paypal: ['paypal.com'], apple: ['apple.com', 'icloud.com'], microsoft: ['microsoft.com', 'outlook.com', 'office.com', 'live.com', 'microsoftonline.com'],
  google: ['google.com', 'gmail.com', 'youtube.com'], amazon: ['amazon.com', 'amazon.co.uk', 'amazonses.com', 'aws.amazon.com'], netflix: ['netflix.com'],
  chase: ['chase.com', 'jpmorgan.com'], 'bank of america': ['bankofamerica.com', 'bofa.com'], 'wells fargo': ['wellsfargo.com'], citi: ['citi.com', 'citibank.com'],
  'american express': ['americanexpress.com', 'aexp.com'], irs: ['irs.gov'], usps: ['usps.com'], ups: ['ups.com'], fedex: ['fedex.com'], dhl: ['dhl.com'],
  docusign: ['docusign.com', 'docusign.net'], dropbox: ['dropbox.com'], linkedin: ['linkedin.com'], facebook: ['facebook.com', 'facebookmail.com', 'meta.com'],
  instagram: ['instagram.com', 'mail.instagram.com'], coinbase: ['coinbase.com'], venmo: ['venmo.com'], zelle: ['zellepay.com'], stripe: ['stripe.com'],
  intuit: ['intuit.com'], quickbooks: ['intuit.com', 'quickbooks.com'], 'geek squad': ['geeksquad.com', 'bestbuy.com'], norton: ['norton.com', 'nortonlifelock.com'],
  mcafee: ['mcafee.com'], walmart: ['walmart.com'], costco: ['costco.com'], roammail: ['roammail.net'],
};
const ALL = Object.values(BRANDS).flat();
const base = (domain) => { const p = String(domain || '').toLowerCase().split('.'); return p.length > 2 && /^(co|com|org|net|gov|ac)$/.test(p[p.length - 2]) ? p.slice(-3).join('.') : p.slice(-2).join('.'); };
const label = (d) => base(d).split('.')[0];
const owns = (domain, brandDomains) => brandDomains.some((b) => domain === b || domain.endsWith(`.${b}`));
const normalise = (s) => s.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/-/g, '');
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Returns null, or { brand, domain, reason } when the sender looks like it's pretending to be a known company. */
export function lookalike(fromAddress, fromName) {
  const domain = String(fromAddress || '').split('@')[1]?.toLowerCase();
  if (!domain) return null;
  if (!owns(domain, ALL)) {
    if (/(^|\.)xn--/.test(domain)) return { brand: '', domain, reason: 'unusual-characters' };
    const mine = label(domain);
    const n = normalise(mine);
    const parts = mine.split('-');
    for (const [brand, domains] of Object.entries(BRANDS)) {
      for (const bd of domains) {
        const b = label(bd);
        if (b.length < 4) continue;
        if (mine !== b && (n === b || (b.length >= 5 && distance(n, b) === 1))) return { brand, domain, reason: 'similar-domain', real: bd };
        if (parts.length > 1 && parts.includes(b)) return { brand, domain, reason: 'brand-in-domain', real: bd }; // paypal-secure.com, not purchase.com
      }
    }
  }
  const name = String(fromName || '').toLowerCase();
  for (const [brand, domains] of Object.entries(BRANDS)) {
    if (brand.length >= 4 && new RegExp(`\\b${brand}\\b`).test(name) && !owns(domain, domains)) return { brand, domain, reason: 'brand-name', real: domains[0] };
  }
  return null;
}
