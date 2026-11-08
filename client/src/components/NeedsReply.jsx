import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { aiStatus, onAiChange } from '../ai.js';
import { t } from '../i18n.js';

/** Inbox: "What needs my reply?" (AI looks at unread mail and lists what people are waiting on). */
export default function NeedsReply({ messages, onOpen }) {
  const [st, setSt] = useState(null);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { aiStatus().then(setSt); return onAiChange(setSt); }, []);
  if (!st?.available || !st.enabled || st.blockedByOrg) return null;
  const run = async () => {
    setBusy(true); setErr('');
    try { setRes((await api.post('/api/ai/triage', {})).needsReply); aiStatus(true).then(setSt); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="needs-reply">
      {!res && <button className="link" disabled={busy} onClick={run}><Icon name="spark" size={14} /> {busy ? 'Looking through your unread mail…' : 'What needs my reply?'}</button>}
      {err && <span className="form-error small"> {err}</span>}
      {res && (
        <div>
          <div className="nr-head"><b>{res.length ? `${res.length} ${res.length === 1 ? 'person is' : 'people are'} waiting for your reply` : 'Nothing in your unread mail is waiting for a reply.'}</b>
            <button className="icon-btn xs" aria-label={t("Close")} title={t("Close")} onClick={() => setRes(null)}><Icon name="close" size={14} /></button></div>
          <ul>
            {res.map((x) => (
              <li key={x.uid}><button className="link" onClick={() => onOpen(messages.find((m) => m.uid === x.uid) || { uid: x.uid })}>
                <b>{x.from?.name || x.from?.address || ''}</b> · {x.subject} <span className="muted">· {x.reason}</span></button></li>
            ))}
          </ul>
          <p className="muted small">{t("AI-generated from sender, subject and first lines.")}</p>
        </div>
      )}
    </div>
  );
}
