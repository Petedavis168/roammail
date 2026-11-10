// Email trackers: invisible "pixels" that tell the sender when, where and how often you opened an email, and codes
// added to links (utm_source, fbclid, …) that follow you to their website. We remove both, always, even when you
// choose to show pictures, and say how many we removed.
const TRACKER_HOSTS = [
  'list-manage.com', 'mailchimp.com', 'mcusercontent.com/track', 'sendgrid.net', 'sendgrid.com', 'mandrillapp.com', 'mailgun.org', 'mailgun.net',
  'hubspot.com', 'hubspotemail.net', 'hs-analytics.net', 'hsforms.com', 'mktoresp.com', 'mkto-', 'marketo.com', 'pardot.com', 'exacttarget.com',
  'salesforce.com/track', 'sfmc-content', 'rs6.net', 'constantcontact.com', 'klaviyo.com', 'klclick', 'customer.io', 'customeriomail.com',
  'intercom-mail', 'intercom.io', 'mixpanel.com', 'google-analytics.com', 'doubleclick.net', 'facebook.com/tr', 'bat.bing.com', 'linkedin.com/emimp',
  'mailtrack.io', 'yesware.com', 'mixmax.com', 'superhuman.com',
  'streak.com', 'bananatag.com', 'getnotify.com', 'cirrusinsight.com', 'boomeranggmail.com', 'returnpath.net', 'litmus.com', 'emltrk.com',
  'sparkpostmail.com', 'postmarkapp.com', 'amazonses.com', 'awstrack.me', 'convertkit-mail', 'ck.page/open', 'substack.com/o/', 'beehiiv.com/o',
];
const TRACKER_PATH = /(\/open(\.gif|\.png|\.php|\/)|\/track(ing)?\/|\/pixel|\/beacon|\/o\.gif|\/e\/o\/|\/wf\/open|\/imp(ression)?\b|[?&](open|tracking)_?id=)/i;
const LINK_PARAMS = /^(utm_\w+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|mc_eid|mc_cid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|vero_id|vero_conv|oly_enc_id|oly_anon_id|igshid|ck_subscriber_id|_kx|trk|trkCampaign|s_cid|ncid|cmpid|ss_source|ss_campaign_id)$/i;

const small = (v) => { const n = parseInt(String(v || ''), 10); return Number.isFinite(n) && n <= 3; };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

const TRACKER_SUBDOMAIN = /^(pixel|pixels|tracking|track|trk|open|opens|beacon|email\.mg|click|clicks)\./i;
/** Is this <img> a tracking pixel? Tiny or hidden images, and images from known tracking services. */
export function isTrackerImage(node, src) {
  if (!/^https?:/i.test(src || '')) return false;
  const style = String(node.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
  const px = (k) => { const m = new RegExp(`(^|;)${k}:(\\d+)px`).exec(style); return m ? Number(m[2]) : null; };
  const tiny = (small(node.getAttribute('width')) && small(node.getAttribute('height')))
    || (px('width') !== null && px('width') <= 3 && px('height') !== null && px('height') <= 3)
    || /display:none|visibility:hidden|(^|;)opacity:0(;|$)/.test(style);
  if (tiny) return true;
  const lower = src.toLowerCase();
  const host = hostOf(src);
  const knownService = TRACKER_HOSTS.some((h) => lower.includes(h)) || TRACKER_SUBDOMAIN.test(host);
  return knownService && (TRACKER_PATH.test(lower) || !node.getAttribute('alt')); // a real picture from these services has alt text
}

/** Remove tracking codes from a link; returns [cleanUrl, removedCount]. */
export function cleanLink(href) {
  if (!/^https?:/i.test(href || '')) return [href, 0];
  let u;
  try { u = new URL(href); } catch { return [href, 0]; }
  let n = 0;
  for (const k of [...u.searchParams.keys()]) if (LINK_PARAMS.test(k)) { u.searchParams.delete(k); n++; }
  return n ? [u.toString(), n] : [href, 0];
}
export const trackerHost = (src) => hostOf(src);
