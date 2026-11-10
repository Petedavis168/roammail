import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { useToast } from './Toast.jsx';
import { fmtDate, personName, avatarColor, initials } from '../util.js';
import { t } from '../i18n.js';

/** The Screener: people emailing you for the first time. Yes = inbox from now on; No = Junk from now on. */
export default function ScreenerList({ onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/screener').then((d) => { setData(d); onChanged?.(d.waiting.length); }).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []);
  if (!data) return <section className="list"><div className="spinner" /></section>;

  const decide = async (s, decision) => {
    setData((d) => ({ ...d, waiting: d.waiting.filter((x) => x.address !== s.address) }));
    try {
      await api.post('/api/screener/decide', { address: s.address, decision });
      toast(decision === 'allow' ? `${personName(s)} ${t('can email you now')}` : `${personName(s)} ${t('is blocked')}`);
      onChanged?.(data.waiting.length - 1);
    } catch (e) { toast(e.message, { error: true }); load(); }
  };
  const toggle = async (enabled) => {
    setBusy(true);
    try { const r = await api.put('/api/screener', { enabled }); toast(enabled ? `${t('Screener is on.')} ${r.learned} ${t('people you already know will always get through.')}` : t('Screener is off. Everything waiting went to your inbox.')); await load(); }
    catch (e) { toast(e.message, { error: true }); }
    setBusy(false);
  };

  return (
    <section className="list screener">
      <div className="list-head"><h2>{t('Screener')}</h2>
        {data.enabled && <button className="btn sm" disabled={busy} onClick={() => toggle(false)}>{t('Turn off')}</button>}
      </div>
      {!data.enabled ? (
        <div className="screener-intro">
          <div className="screener-hero"><Icon name="userCheck" size={34} /></div>
          <h3>{t('Decide who gets into your inbox')}</h3>
          <p>{t('When someone emails you for the first time, their email waits here instead of your inbox. Say yes once and they always get through. Say no and you never hear from them again.')}</p>
          <ul className="muted small">
            <li>{t('Everyone you’ve ever emailed, and everyone already in your inbox, gets through automatically.')}</li>
            <li>{t('People at your own company always get through.')}</li>
            <li>{t('It works in every app — your phone’s mail app too.')}</li>
          </ul>
          <button className="btn primary" disabled={busy} onClick={() => toggle(true)}>{busy ? t('Setting up…') : t('Turn on the Screener')}</button>
        </div>
      ) : !data.waiting.length ? (
        <div className="empty"><Icon name="userCheck" size={40} /><b>{t('No one is waiting')}</b><p className="muted">{t('New people who email you will show up here first.')}</p></div>
      ) : (
        <div className="screener-list">
          <p className="muted small" style={{ padding: '0 14px' }}>{t('These people emailed you for the first time. Do you want to hear from them?')}</p>
          {data.waiting.map((s) => (
            <div className="screener-row" key={s.address}>
              <span className="avatar" style={{ background: avatarColor(s.address) }}>{initials(s)}</span>
              <div className="screener-who">
                <b>{personName(s)}</b> <span className="muted small">{s.address}</span>
                <div className="small screener-subj">{s.subject || t('(no subject)')}{s.count > 1 ? ` · ${s.count} ${t('emails')}` : ''} · {fmtDate(s.last)}</div>
              </div>
              <button className="btn sm primary" onClick={() => decide(s, 'allow')}><Icon name="check" size={14} /> {t('Yes')}</button>
              <button className="btn sm" onClick={() => decide(s, 'block')}><Icon name="close" size={14} /> {t('No')}</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
