import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { useToast } from './Toast.jsx';
import { personName } from '../util.js';
import { t } from '../i18n.js';

/** Inbox: "No reply in 3 days. Bump it?" for emails you sent that nobody has answered. */
export default function Nudges({ onBump }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [menu, setMenu] = useState(false);
  const load = (refresh) => api.get(`/api/nudges${refresh ? '?refresh=1' : ''}`).then(setData).catch(() => {});
  useEffect(() => { load(); const h = () => load(true); window.addEventListener('roammail:nudges', h); return () => window.removeEventListener('roammail:nudges', h); }, []);
  if (!data?.nudges?.length) return null;
  const dismiss = async (n) => {
    setData((d) => ({ ...d, nudges: d.nudges.filter((x) => x.messageId !== n.messageId) }));
    await api.post('/api/nudges/dismiss', { messageId: n.messageId }).catch(() => {});
  };
  const setPrefs = async (p) => {
    setMenu(false);
    try { const prefs = await api.put('/api/nudges/settings', { ...data.prefs, ...p }); toast(prefs.enabled ? t('Saved') : t('Follow-up nudges are off. Turn them back on in Settings → General.')); load(true); } catch (e) { toast(e.message, { error: true }); }
  };
  const who = (n) => n.to.map((a) => personName(a)).slice(0, 2).join(', ') + (n.to.length > 2 ? ` +${n.to.length - 2}` : '');
  const ago = (n) => (n.days <= 0 ? t('today') : n.days === 1 ? t('1 day ago') : `${n.days} ${t('days ago')}`);
  return (
    <section className="nudges" aria-label={t('Follow-up nudges')}>
      <div className="nudges-head"><Icon name="clock" size={15} /> <b>{t('No reply yet')}</b>
        <div className="dd">
          <button className="icon-btn xs" aria-label={t('Nudge settings')} title={t('Nudge settings')} onClick={() => setMenu((x) => !x)}><Icon name="more" size={14} /></button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <div className="menu-note">{t('Nudge me after')}</div>
              {[1, 2, 3, 5, 7].map((d) => <button key={d} onClick={() => setPrefs({ days: d })}>{data.prefs.days === d ? <Icon name="check" size={14} /> : <span className="ic-space" />} {d === 1 ? t('1 day') : `${d} ${t('days')}`}</button>)}
              <div className="menu-sep" />
              <button onClick={() => setPrefs({ onlyQuestions: !data.prefs.onlyQuestions })}>{data.prefs.onlyQuestions ? <Icon name="check" size={14} /> : <span className="ic-space" />} {t('Only emails that asked a question')}</button>
              <button onClick={() => setPrefs({ enabled: false })}><span className="ic-space" /> {t('Turn off nudges')}</button>
            </div>
          )}
        </div>
      </div>
      {data.nudges.map((n) => (
        <div className="nudge" key={n.messageId}>
          <div className="nudge-text"><span className="nudge-who">{who(n)}</span> <span className="nudge-subj">{n.subject || t('(no subject)')}</span>
            <small className="muted">{t('Sent')} {ago(n)}. {t('Bump it?')}</small></div>
          <button className="btn sm primary" onClick={() => { setData((d) => ({ ...d, nudges: d.nudges.filter((x) => x.messageId !== n.messageId) })); onBump(n); }}>{t('Bump')}</button>
          <button className="icon-btn xs" title={t('Dismiss')} aria-label={t('Dismiss')} onClick={() => dismiss(n)}><Icon name="close" size={14} /></button>
        </div>
      ))}
    </section>
  );
}

/** Settings → General: the nudge options. */
export function NudgeSettings() {
  const toast = useToast();
  const [p, setP] = useState(null);
  useEffect(() => { api.get('/api/nudges').then((d) => setP(d.prefs)).catch(() => {}); }, []);
  if (!p) return null;
  const save = async (next) => { setP(next); try { setP(await api.put('/api/nudges/settings', next)); window.dispatchEvent(new Event('roammail:nudges')); toast(t('Saved')); } catch (e) { toast(e.message, { error: true }); } };
  return (
    <div className="field-group">
      <label className="check"><input type="checkbox" checked={p.enabled} onChange={(e) => save({ ...p, enabled: e.target.checked })} /> {t('Remind me when nobody replies to an email I sent')}</label>
      {p.enabled && (
        <div className="row-inline" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginLeft: 26 }}>
          <span className="small">{t('After')}</span>
          <select value={p.days} onChange={(e) => save({ ...p, days: Number(e.target.value) })} aria-label={t('Days')}>{[1, 2, 3, 5, 7].map((d) => <option key={d} value={d}>{d} {d === 1 ? t('day') : t('days')}</option>)}</select>
          <label className="check small"><input type="checkbox" checked={p.onlyQuestions} onChange={(e) => save({ ...p, onlyQuestions: e.target.checked })} /> {t('Only if I asked a question')}</label>
        </div>
      )}
    </div>
  );
}
