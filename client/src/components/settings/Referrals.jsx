import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { t } from '../../i18n.js';

/** Refer a friend: your link, how it works, and who joined. */
export default function Referrals() {
  const toast = useToast();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/api/referrals').then(setD).catch((e) => toast(e.message, { error: true })); }, []);
  if (!d) return <div className="spinner" />;
  const copy = async () => { try { await navigator.clipboard.writeText(d.link); toast(t('Link copied')); } catch { prompt(t('Copy your link'), d.link); } };
  const share = async () => {
    const text = t('I use Roammail for private email. Join with my link and we both get a free month of Premium:');
    if (navigator.share) { try { await navigator.share({ title: 'Roammail', text, url: d.link }); } catch { /* cancelled */ } } else copy();
  };
  const mailto = `mailto:?subject=${encodeURIComponent(t('Try Roammail with me'))}&body=${encodeURIComponent(`${t('I use Roammail for private, ad-free email. Sign up with my link and we both get a free month of Premium:')}\n\n${d.link}`)}`;
  const label = { pending: t('Joined: waiting'), rewarded: t('Free month earned'), 'not-eligible': t('Not eligible') };
  return (
    <div className="settings-section referrals">
      <div className="ref-hero">
        <div className="ref-gift">🎁</div>
        <div><h3>{t('Give a month, get a month')}</h3>
          <p className="muted">{d.personal ? t('Invite friends to Roammail. When they’re up and running, you both get a free month of Premium.') : t('Invite people to Roammail with your link. They get a free month of Premium when they’re up and running.')}</p></div>
      </div>
      <div className="ref-link"><input readOnly value={d.link} onFocus={(e) => e.target.select()} aria-label={t('Your link')} />
        <button className="btn primary" onClick={copy}><Icon name="copy" size={15} /> {t('Copy')}</button>
        <button className="btn" onClick={share}><Icon name="forward" size={15} /> {t('Share')}</button>
        <a className="btn" href={mailto}><Icon name="mail" size={15} /> {t('Email it')}</a></div>
      <ol className="ref-steps">
        <li><b>{t('Share your link')}</b><span>{t('with friends, family or coworkers.')}</span></li>
        <li><b>{t('They sign up')}</b><span>{`${t('and use Roammail for a week (sending at least')} ${d.qualify.sent} ${t('emails).')}`}</span></li>
        <li><b>{t('You both get a free month')}</b><span>{t('of Premium: 100 GB, your own domain and unlimited AI help. Up to 12 free months a year.')}</span></li>
      </ol>
      {!d.available && <p className="muted small">{t('Rewards start as soon as Premium is available.')}</p>}
      <h4>{t('Your invites')} {d.earned > 0 && <span className="pill ok">{d.earned} {d.earned === 1 ? t('free month earned') : t('free months earned')}</span>}</h4>
      {!d.friends.length && <div className="empty-card small">{t('No one has joined with your link yet.')}</div>}
      {d.friends.map((f, i) => (
        <div key={i} className="ref-row"><span>{f.who}</span><small className="muted">{new Date(f.joined).toLocaleDateString()}</small><span className={`pill ${f.status === 'rewarded' ? 'ok' : f.status === 'pending' ? 'warn' : ''}`}>{label[f.status] || f.status}</span></div>
      ))}
      <p className="muted small">{t('To keep it fair, invites from the same network or phone as you don’t count.')}</p>
    </div>
  );
}
