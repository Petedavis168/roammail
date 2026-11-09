import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { DomainStatus } from '../admin/DomainSetup.jsx';
import { t } from '../../i18n.js';

/** Personal Premium: 100 GB, your own domain, unlimited AI help. */
export default function Premium({ premiumMsg }) {
  const toast = useToast();
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState('');
  const [domain, setDomain] = useState('');
  const load = () => api.get('/api/premium').then(setP).catch(() => setP({ available: false }));
  useEffect(() => {
    const sid = new URLSearchParams(location.search).get('session_id');
    if (premiumMsg === 'success' && sid) api.post('/api/premium/confirm', { sessionId: sid }).then((r) => { if (r.active) toast(t("Welcome to Premium!")); load(); }).catch(load);
    else load();
  }, []);
  if (!p) return <div className="spinner" />;
  if (!p.available && !p.active) return <p className="muted">{t("Premium isn't available for this account.")}</p>;
  const money = (n) => new Intl.NumberFormat([], { style: 'currency', currency: p.currency || 'USD' }).format(n);
  const go = async (interval) => { setBusy(interval); try { location.href = (await api.post('/api/premium/checkout', { interval })).url; } catch (e) { toast(e.message, { error: true }); setBusy(''); } };
  const manage = async () => { try { location.href = (await api.post('/api/premium/portal')).url; } catch (e) { toast(e.message, { error: true }); } };
  const addDomain = async (e) => {
    e.preventDefault(); setBusy('domain');
    try { await api.post('/api/premium/domain', { domain }); await load(); } catch (x) { toast(x.message, { error: true }); } finally { setBusy(''); }
  };
  return (
    <div className="premium">
      <ul className="premium-perks">
        <li><Icon name="archive" size={16} /> <span><b>{p.quotaGb}{' '}{t("GB")}</b>{' '}{t("of storage for mail and attachments")}</span></li>
        <li><Icon name="globe" size={16} /> <span><b>{t("Your own domain")}</b>{t(", like you@yourname.com")}</span></li>
        <li><Icon name="spark" size={16} /> <span><b>{t("Unlimited AI help")}</b>{t(": summaries, suggested replies, what needs a reply")}</span></li>
      </ul>
      {premiumMsg === 'canceled' && !p.active && <p className="muted small">{t("Checkout was cancelled. Nothing was charged.")}</p>}
      {p.active ? (
        <>
          <p><span className="pill ok">{t("Premium")}</span> {p.interval === 'year' ? 'Yearly' : 'Monthly'}{p.status === 'past_due' ? ' · payment failed, please update your card' : ''}</p>
          <button className="btn" onClick={manage}><Icon name="external" size={14} />{' '}{t("Manage subscription (card, invoices, cancel)")}</button>
          <h3>{t("Your own domain")}</h3>
          {p.domain ? <DomainStatus domain={p.domain.domain} /> : (
            <form className="pick-time" onSubmit={addDomain}>
              <input required placeholder="yourname.com" aria-label={t("Your domain")} autoCapitalize="off" value={domain} onChange={(e) => setDomain(e.target.value)} />
              <button className="btn primary" disabled={busy === 'domain'}>{busy === 'domain' ? 'Adding…' : 'Add domain'}</button>
            </form>
          )}
          {!p.domain && <p className="muted small">{t("Use a domain you own. We'll show you the records to add where you bought it, then create your address there with the same password. Adding a domain turns on 2-step verification for your account.")}</p>}
        </>
      ) : (
        <div className="premium-buy">
          <button className="btn primary" disabled={!!busy} onClick={() => go('month')}>{busy === 'month' ? 'Opening secure checkout…' : `Get Premium: ${money(p.perMonth)}/month`}</button>
          <button className="btn" disabled={!!busy} onClick={() => go('year')}>{busy === 'year' ? 'Opening secure checkout…' : `${money(p.perYear)}/year (2 months free)`}</button>
          <p className="muted small">{t("Cancel any time. Your mail stays yours either way.")}</p>
        </div>
      )}
    </div>
  );
}
