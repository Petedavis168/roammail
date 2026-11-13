import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';
import { t } from '../../i18n.js';

/** Free Premium for students (school email + code) and a nonprofit application. */
export default function StudentNonprofit() {
  const toast = useToast();
  const [st, setSt] = useState(null);
  const [school, setSchool] = useState('');
  const [ticket, setTicket] = useState(null);
  const [code, setCode] = useState('');
  const [np, setNp] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/student').then(setSt).catch(() => {}); }, []);
  if (!st) return null;
  const go = async (fn) => { setBusy(true); try { await fn(); } catch (e) { toast(e.message, { error: true }); } setBusy(false); };
  return (
    <div className="student-np">
      <h3>{t('Students & nonprofits')}</h3>
      {st.available && (
        <div className="card">
          <b>🎓 {t('Free Premium for students')}</b>
          {st.verified ? <p className="ok-text">{t('You have student Premium until')} {new Date(st.until).toLocaleDateString()}.</p> : !ticket ? (
            <form className="row-inline" onSubmit={(e) => { e.preventDefault(); go(async () => { const r = await api.post('/api/student/start', { schoolEmail: school }); setTicket(r.ticket); toast(t('We sent a code to your school email.')); }); }}>
              <p className="muted small">{t('Confirm your school or university email address and get a full year of Premium free.')}</p>
              <input type="email" value={school} onChange={(e) => setSchool(e.target.value)} placeholder="name@school.edu" required aria-label={t('School email')} />
              <button className="btn primary" disabled={busy}>{t('Send code')}</button>
            </form>
          ) : (
            <form className="row-inline" onSubmit={(e) => { e.preventDefault(); go(async () => { const r = await api.post('/api/student/verify', { ticket, code }); setSt({ ...st, verified: true, until: r.until }); toast(t('Welcome! You have Premium free for a year.')); }); }}>
              <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('6-digit code')} required aria-label={t('Code')} />
              <button className="btn primary" disabled={busy}>{t('Confirm')}</button>
              <button type="button" className="link" onClick={() => setTicket(null)}>{t('Use a different address')}</button>
            </form>
          )}
        </div>
      )}
      <div className="card">
        <b>💚 {t('Nonprofits')}</b>
        <p className="muted small">{t('Registered charities and nonprofits get a discount on Roammail for their team. Tell us about your organization and we’ll be in touch.')}</p>
        {np === 'sent' ? <p className="ok-text">{t('Thanks! We received your application and will reply by email.')}</p> : !np ? <button className="btn" onClick={() => setNp({ organization: '', website: '', registration: '', about: '' })}>{t('Apply')}</button> : (
          <form className="form" onSubmit={(e) => { e.preventDefault(); go(async () => { await api.post('/api/nonprofit/apply', np); setNp('sent'); }); }}>
            <label>{t('Organization name')}<input value={np.organization} onChange={(e) => setNp({ ...np, organization: e.target.value })} required /></label>
            <label>{t('Website')}<input value={np.website} onChange={(e) => setNp({ ...np, website: e.target.value })} placeholder="https://" /></label>
            <label>{t('Registration or tax ID (e.g. EIN)')}<input value={np.registration} onChange={(e) => setNp({ ...np, registration: e.target.value })} /></label>
            <label>{t('What does your organization do?')}<textarea rows={3} value={np.about} onChange={(e) => setNp({ ...np, about: e.target.value })} required /></label>
            <div className="actions"><button className="btn primary" disabled={busy}>{t('Send application')}</button></div>
          </form>
        )}
      </div>
    </div>
  );
}
