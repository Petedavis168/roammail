import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { t } from '../../i18n.js';

const NAMES = { slack: 'Slack', teams: 'Microsoft Teams', 'teams-workflow': 'Microsoft Teams', discord: 'Discord' };

/** New-email alerts in a Slack / Teams / Discord channel. */
export default function ChatAlerts() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/api/chat-alerts').then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list) return null;
  const add = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api.post('/api/chat-alerts', f); toast(t('Connected. We posted a test message to the channel.')); setF(null); load(); } catch (x) { toast(x.message, { error: true }); }
    setBusy(false);
  };
  return (
    <div className="field-group chat-alerts">
      <p className="muted small">{t('Get a message in a Slack, Microsoft Teams or Discord channel when new email arrives, for all your email or only from people you choose.')}</p>
      {list.map((h) => (
        <div key={h.id} className="ref-row"><span><b>{NAMES[h.kind] || h.kind}</b> {h.onlyFrom.length ? <small className="muted">{t('only from')} {h.onlyFrom.join(', ')}</small> : <small className="muted">{t('all new email')}</small>}</span>
          {h.lastAt && <small className={h.lastOk ? 'muted' : 'bad'}>{h.lastOk ? t('last sent') : t('last attempt failed')} {new Date(h.lastAt).toLocaleString()}</small>}
          <button className="icon-btn" title={t('Remove')} aria-label={t('Remove')} onClick={async () => { await api.del(`/api/chat-alerts/${h.id}`); load(); }}><Icon name="trash" size={15} /></button></div>
      ))}
      {!f ? <button className="btn sm" onClick={() => setF({ url: '', onlyFrom: '' })}><Icon name="plus" size={14} /> {t('Connect a channel')}</button> : (
        <form className="form" onSubmit={add}>
          <label>{t('Incoming webhook link')}<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://hooks.slack.com/services/…" required /></label>
          <details className="muted small"><summary>{t('Where do I find this?')}</summary>
            <p><b>Slack:</b> {t('your workspace → Apps → Incoming Webhooks → Add to Slack → pick a channel → copy the Webhook URL.')}</p>
            <p><b>Teams:</b> {t('the channel → ⋯ → Workflows → “Post to a channel when a webhook request is received” → copy the link.')}</p>
            <p><b>Discord:</b> {t('channel settings → Integrations → Webhooks → New webhook → Copy webhook URL.')}</p></details>
          <label>{t('Only for email from (optional)')}<input value={f.onlyFrom} onChange={(e) => setF({ ...f, onlyFrom: e.target.value })} placeholder="boss@company.com, client@example.com" /></label>
          <div className="actions"><button className="btn primary" disabled={busy}>{busy ? t('Connecting…') : t('Connect')}</button><button type="button" className="btn" onClick={() => setF(null)}>{t('Cancel')}</button></div>
          <p className="muted small">{t('Alerts show who it’s from and the subject. Turn off “Show sender and subject” (Phone & apps) to post only “You have new email”.')}</p>
        </form>
      )}
    </div>
  );
}
