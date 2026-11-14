import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';
import { t } from '../../i18n.js';

/** Free accounts: emails sent this month, and verifying with a US driver's license to remove the monthly limit. */
export default function IdVerify() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/id-verify').then(setD).catch(() => {});
  useEffect(() => {
    load();
    if (new URLSearchParams(location.search).get('idv') === 'done') { // back from the ID check: results can take a few seconds
      const iv = setInterval(load, 3000); setTimeout(() => clearInterval(iv), 30000);
      return () => clearInterval(iv);
    }
  }, []);
  if (!d || (!d.available && d.status !== 'verified')) return null;
  const start = async () => {
    setBusy(true);
    try { const r = await api.post('/api/id-verify/start'); if (r.url) location.assign(r.url); else load(); } catch (e) { toast(e.message, { error: true }); setBusy(false); }
  };
  const pct = d.cap ? Math.min(100, Math.round((d.sentThisMonth / d.cap) * 100)) : 0;
  return (
    <section className="idv">
      <h3>{t('Verify your identity')}</h3>
      {d.status === 'verified' ? (
        <p className="idv-ok"><span aria-hidden="true">✓</span> {t('Verified with a US driver’s license. You have no monthly sending limit.')}</p>
      ) : <>
        {d.capApplies && d.cap && (
          <div className="idv-usage">
            <div className="small"><b>{d.sentThisMonth}</b> {t('of')} {d.cap} {t('emails sent this month')}</div>
            <div className="idv-bar" role="progressbar" aria-valuemin={0} aria-valuemax={d.cap} aria-valuenow={d.sentThisMonth} aria-label={t('Emails sent this month')}><span style={{ width: `${pct}%` }} className={pct >= 90 ? 'full' : ''} /></div>
          </div>
        )}
        <p className="small">{t('Free accounts can send 100 emails a month. This keeps spammers off Roammail. Verify that you’re a real person in the US to remove the limit. It takes about 2 minutes.')}</p>
        <ol className="small idv-steps">
          <li>{t('Have your US driver’s license ready.')}</li>
          <li>{t('Take a photo of it with your phone or webcam. It’s detected and read automatically.')}</li>
          <li>{t('Take a quick selfie so we know it’s you.')}</li>
        </ol>
        {d.status === 'processing' && <p className="small"><b>{t('Checking your license…')}</b> {t('This usually takes under a minute.')}</p>}
        {d.status === 'pending' && <p className="small muted">{t('Not finished yet. You can continue where you left off.')}</p>}
        {d.status === 'failed' && <p className="form-error small">{d.reason || t('We couldn’t verify that. Please try again.')}</p>}
        <button className="btn primary" disabled={busy || d.status === 'processing'} onClick={start}>{busy ? t('Opening…') : d.status === 'failed' ? t('Try again') : d.status === 'pending' ? t('Continue verifying') : t('Verify with my driver’s license')}</button>
        <p className="muted small idv-privacy">{t('Checked securely by Stripe. Roammail never sees or keeps your license photo, number or address: we only keep that you’re verified.')}</p>
      </>}
    </section>
  );
}
