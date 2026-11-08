import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtDate } from '../util.js';
import { useToast } from './Toast.jsx';
import { t } from '../i18n.js';

/** Definite spam the server held back (mailcow quarantine). Shown as text only, never as live HTML. */
export default function QuarantineList({ domain, onChanged, title = 'Spam quarantine' }) {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState(null);
  const load = () => api.get('/api/quarantine', domain ? { domain } : undefined).then((r) => { setItems(r); onChanged?.(r.length); }).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, [domain]);
  useEffect(() => { setDetail(null); if (open) api.get(`/api/quarantine/${open}`).then(setDetail).catch((e) => toast(e.message, { error: true })); }, [open]);

  const ids = () => (sel.size ? [...sel] : open ? [open] : []);
  const release = async (notSpam) => {
    const list = ids(); if (!list.length) return;
    const hasVirus = items.some((x) => list.includes(x.id) && x.virus);
    if (hasVirus && !confirm(t("⚠ A selected message contains a VIRUS. Releasing it could harm your computer. Release anyway?"))) return;
    try {
      await api.post('/api/quarantine/release', { ids: list, notSpam, trustSender: notSpam && !domain, confirmVirus: hasVirus });
      toast(notSpam ? 'Released to your inbox. We\'ll trust this sender from now on.' : 'Released to the inbox');
      setSel(new Set()); setOpen(null); load();
    } catch (e) { toast(e.message, { error: true }); }
  };
  const del = async () => {
    const list = ids(); if (!list.length) return;
    try { await api.post('/api/quarantine/delete', { ids: list }); toast(t("Deleted")); setSel(new Set()); setOpen(null); load(); } catch (e) { toast(e.message, { error: true }); }
  };
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="quarantine">
      <section className="list q-list">
        <div className="list-head">
          <label className="chk"><input type="checkbox" checked={!!items?.length && sel.size === items.length} onChange={() => setSel(sel.size === items?.length ? new Set() : new Set(items.map((x) => x.id)))} /></label>
          <h2>{title}</h2>
        </div>
        <div className="banner"><Icon name="shield" size={14} />{' '}{t("Definite spam the server stopped before it reached")}{' '}{domain ? 'your team' : 'you'}{t(". Nothing here can harm you unless you release it. Items are removed automatically after a while.")}</div>
        {(sel.size > 0 || open) && (
          <div className="selbar">
            <b>{sel.size || 1} selected</b>
            <button onClick={() => release(false)}><Icon name="inbox" size={16} />{' '}{t("Release")}</button>
            <button onClick={() => release(true)}><Icon name="check" size={16} />{' '}{t("Not spam")}</button>
            <button onClick={del}><Icon name="trash" size={16} />{' '}{t("Delete")}</button>
          </div>
        )}
        <div className="rows">
          {!items && <div className="list-msg"><div className="spinner" /></div>}
          {items?.length === 0 && <div className="empty"><Icon name="shield" size={48} /><p>{t("Nothing in quarantine.")}</p><small>{t("When the server blocks definite spam, it shows up here.")}</small></div>}
          {items?.map((x) => (
            <div key={x.id} className={`row ${open === x.id ? 'active' : ''} ${sel.has(x.id) ? 'selected' : ''}`} onClick={() => setOpen(x.id)}>
              <div className="row-left" onClick={(e) => { e.stopPropagation(); toggle(x.id); }}>
                <span className={`avatar ${x.virus ? 'virus' : 'q'}`}>{x.virus ? '☣' : '!'}</span>
                <input type="checkbox" checked={sel.has(x.id)} readOnly tabIndex={-1} />
              </div>
              <div className="row-main">
                <div className="row-top"><span className="from">{x.sender}</span><span className="date">{fmtDate(new Date(x.created).toISOString())}</span></div>
                <div className="row-sub"><span className="subject">{x.subject}</span></div>
                <div className="snippet">{x.virus ? <b className="bad">{t("Contains a virus ·")}{' '}</b> : null}{t("Spam score")}{' '}{x.score.toFixed(1)}{domain ? ` · to ${x.rcpt}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="reading q-reading">
        {!open ? (
          <div className="empty-pane"><Icon name="shield" size={64} /><p>{t("Select a message to preview it safely")}</p></div>
        ) : !detail ? <div className="list-msg"><div className="spinner" /></div> : (
          <div className="thread">
            <h1 className="q-subject">{detail.subject}</h1>
            {detail.virus && <div className="sec-banner"><Icon name="alert" size={18} /><div><b>{t("This message contains a virus.")}</b><div>{t("Delete it. Don't release it unless your IT person asks you to.")}</div></div></div>}
            <div className="card q-why">
              <b>{t("Why it was stopped")}</b> <span className="muted small">{t("(spam score")}{' '}{detail.score.toFixed(1)})</span>
              <ul>{(detail.reasons.length ? detail.reasons : ['Many spam signals at once']).map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
            <div className="addr-line"><span>{t("From:")}</span> {detail.from?.name ? `${detail.from.name} <${detail.from.address}>` : detail.from?.address}</div>
            <div className="addr-line"><span>{t("To:")}</span> {detail.rcpt}</div>
            <div className="addr-line"><span>{t("Received:")}</span> {fmtDate(new Date(detail.created).toISOString(), true)}</div>
            <p className="muted small">{t("Shown as plain text for your safety. Links and images are disabled.")}</p>
            <pre className="q-text">{detail.text || '(no text)'}</pre>
            {detail.attachments.length > 0 && <div className="muted small">{t("Attachments (not opened):")}{' '}{detail.attachments.map((a) => a.filename).join(', ')}</div>}
            <div className="quick-reply">
              <button className="btn" onClick={() => release(false)}><Icon name="inbox" />{' '}{t("Release to inbox")}</button>
              <button className="btn" onClick={() => release(true)}><Icon name="check" />{' '}{t("Not spam")}{domain ? '' : ' (always trust sender)'}</button>
              <button className="btn" onClick={del}><Icon name="trash" />{' '}{t("Delete")}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
