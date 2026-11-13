import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { t } from '../../i18n.js';

/** "This month, Roammail…": what was kept away from you. */
export default function PrivacyReport() {
  const [r, setR] = useState(null);
  useEffect(() => { api.get('/api/privacy-report').then(setR).catch(() => {}); }, []);
  if (!r) return null;
  const tiles = [
    ['🕵️', r.trackers.pixels + r.trackers.links, t('trackers blocked'), `${r.trackers.pixels} ${t('spy pixels')}, ${r.trackers.links} ${t('tracking links cleaned')}`],
    ['🛡️', r.spam.junk + r.spam.quarantined, t('spam & phishing kept out'), `${r.spam.junk} ${t('in Junk')}, ${r.spam.quarantined} ${t('held back')}`],
    ['🚫', r.screener.blocked, t('senders blocked by the Screener'), ''],
    ['🎭', r.aliases, t('aliases hiding your address'), ''],
    ['📭', r.unsubscribed, t('newsletters left'), ''],
    ['🔐', r.signins.ok, t('sign-ins to your account'), r.signins.failed ? `${r.signins.failed} ${t('failed attempts blocked')}` : t('no failed attempts')],
  ];
  return (
    <div className="privacy-report">
      <h3>{t('Your privacy report')} <span className="muted small">· {r.month}</span></h3>
      <div className="pr-grid">
        {tiles.map(([ic, n, label, sub]) => (
          <div className="pr-tile" key={label}><span className="pr-ic">{ic}</span><b>{n}</b><span>{label}</span>{sub && <small className="muted">{sub}</small>}</div>
        ))}
      </div>
      {r.scamsReported > 0 && <p className="muted small">{t('You reported')} {r.scamsReported} {t('scam emails this month. Thank you: it protects everyone.')}</p>}
    </div>
  );
}
