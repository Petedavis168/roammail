import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { aiStatus, setAiEnabled, onAiChange, aiConsentText } from '../ai.js';
import { t } from '../i18n.js';

/** Summary and suggested replies for the open conversation. */
export default function AiPanel({ folder, uid, last, onReply }) {
  const [st, setSt] = useState(null);
  const [summary, setSummary] = useState(null);
  const [replies, setReplies] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [consent, setConsent] = useState(false);
  useEffect(() => { aiStatus().then(setSt); return onAiChange(setSt); }, []);
  useEffect(() => { setSummary(null); setReplies(null); setErr(''); }, [folder, uid]);
  if (!st?.available || st.blockedByOrg) return null;

  const run = async (kind) => {
    setBusy(kind); setErr('');
    try {
      if (kind === 'summary') setSummary(await api.post('/api/ai/summarize', { folder, uid }));
      else setReplies((await api.post('/api/ai/replies', { folder, uid })).replies);
      aiStatus(true).then(setSt);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  if (!st.enabled) {
    return (
      <div className="ai-panel off">
        {!consent ? <button className="link" onClick={() => setConsent(true)}><Icon name="spark" size={14} />{' '}{t("AI help: summarise and suggest replies")}</button> : (
          <div>
            <p className="small">{aiConsentText}</p>
            <button className="btn primary sm" onClick={() => setAiEnabled(true)}>{t("Turn on AI help")}</button> <button className="link" onClick={() => setConsent(false)}>{t("Not now")}</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="ai-panel" aria-live="polite">
      <div className="ai-actions">
        <button className="btn sm" disabled={!!busy} onClick={() => run('summary')}><Icon name="spark" size={14} /> {busy === 'summary' ? 'Summarising…' : 'Summarise'}</button>
        <button className="btn sm" disabled={!!busy} onClick={() => run('replies')}><Icon name="reply" size={14} /> {busy === 'replies' ? 'Writing…' : 'Suggest replies'}</button>
        {st.limit != null && <span className="muted small">{Math.max(0, st.limit - st.used)} of {st.limit}{' '}{t("free this month")}</span>}
      </div>
      {err && <div className="form-error small">{err}</div>}
      {summary && (
        <div className="ai-summary">
          <p>{summary.summary}</p>
          {summary.actionItems?.length > 0 && <ul>{summary.actionItems.map((a, i) => <li key={i}>{a}</li>)}</ul>}
          {summary.needsReply && <p className="small"><b>{t("Waiting for your reply.")}</b></p>}
          <p className="muted small">{t("AI-generated. Check important details in the emails.")}</p>
        </div>
      )}
      {replies && (
        <div className="ai-replies">
          {replies.map((r, i) => (
            <button key={i} className="g-chip" title={r.text} onClick={() => onReply(last, 'reply', r.text)}>{r.label}</button>
          ))}
          <span className="muted small">{t("Opens a reply you can edit before sending.")}</span>
        </div>
      )}
    </div>
  );
}
