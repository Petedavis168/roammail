import { safeHtml } from '../../safehtml.js';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import RichEditor from '../RichEditor.jsx';
import { useToast } from '../Toast.jsx';
import { escapeHtml } from '../../util.js';
import { t } from '../../i18n.js';
import SignatureBuilder from './SignatureBuilder.jsx';

export default function Signatures({ sigData, reloadSigs, prefs, setPrefs, me }) {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ name: '', html: '' });
  const [building, setBuilding] = useState(null); // { id, design, name } while the builder is open
  const [bookingUrl, setBookingUrl] = useState('');
  useEffect(() => { api.get('/api/booking/me').then((b) => setBookingUrl(b?.url || '')).catch(() => {}); }, []);

  useEffect(() => {
    if (!sigData) return;
    const p = sigData.personal || { signatures: [] };
    // One-time migration of the old plain-text signature that lived in browser settings
    if (!p.signatures.length && prefs.signature) {
      const html = prefs.signature.split('\n').map(escapeHtml).join('<br>');
      save({ ...p, signatures: [{ id: 'migrated', name: 'My signature', html }], defaultNew: 'migrated', defaultReply: 'migrated' }, true);
      setPrefs({ signature: '' });
    } else setState(p);
  }, [sigData]);

  async function save(next, quiet) {
    try {
      const saved = await api.put('/api/signature/personal', next);
      setState(saved); reloadSigs();
      if (!quiet) toast(t("Signatures saved"));
    } catch (e) { toast(e.message, { error: true }); }
  }
  if (!state) return <div className="spinner" />;

  const org = sigData.org;
  const choices = [[null, 'No signature'], ...(org?.mode === 'default' ? [['company', `${org.company || 'Company'} signature`]] : []), ...state.signatures.map((s) => [s.id, s.name])];
  const startEdit = (s) => { setEditing(s?.id || 'new'); setDraft(s ? { name: s.name, html: s.html } : { name: state.signatures.length ? `Signature ${state.signatures.length + 1}` : 'My signature', html: '' }); };
  const commit = () => {
    const list = editing === 'new' ? [...state.signatures, { id: `s${Date.now()}`, ...draft }] : state.signatures.map((s) => (s.id === editing ? { ...s, ...draft, design: undefined } : s));
    const next = { ...state, signatures: list };
    if (editing === 'new' && !state.signatures.length && !org) { next.defaultNew = list[0].id; next.defaultReply = list[0].id; }
    save(next); setEditing(null);
  };
  // Start the builder from what we already know about the person
  const seed = () => {
    const p = sigData.profile || {};
    return {
      name: p.name || me?.name || '', title: p.title || '', department: p.department || '', company: sigData.org?.company || '',
      phones: [p.phone && { label: 'Phone', value: p.phone }, p.mobile && { label: 'Mobile', value: p.mobile }].filter(Boolean),
      emails: me?.email ? [{ label: 'Email', value: me.email }] : [], booking: { label: 'Book a meeting', url: bookingUrl },
    };
  };
  const saveBuilt = ({ name, html, design }) => {
    const id = building.id || `s${Date.now()}`;
    const exists = state.signatures.some((s) => s.id === id);
    const list = exists ? state.signatures.map((s) => (s.id === id ? { ...s, name, html, design } : s)) : [...state.signatures, { id, name, html, design }];
    const next = { ...state, signatures: list };
    if (!exists && !state.signatures.length && !org) { next.defaultNew = id; next.defaultReply = id; }
    save(next); setBuilding(null);
  };
  const copyRich = async (html) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([html.replace(/<[^>]+>/g, '')], { type: 'text/plain' }) })]);
      toast(t("Copied. Paste it into Outlook or your phone's signature settings."));
    } catch { toast(t("Your browser blocked copying. Select the preview and copy it instead."), { error: true }); }
  };

  return (
    <div className="settings-section">
      {org && (
        <div className="card org-sig">
          <h3><Icon name="shield" size={16} /> {org.company || 'Company'} signature</h3>
          <p className="muted small">{org.mode === 'enforced'
            ? `Your organization adds this to every email you send${org.onReplies ? ', including replies' : ' (not on replies)'}. It updates automatically when your details change.`
            : 'Your organization provides this signature. You can use it, or choose your own below.'}</p>
          <div className="sig-preview" dangerouslySetInnerHTML={{ __html: safeHtml(org.html) }} />
          <button className="btn sm" onClick={() => copyRich(org.html)}><Icon name="copy" size={14} />{' '}{t("Copy for Outlook / phone")}</button>
        </div>
      )}
      {org?.mode !== 'enforced' && <>
        <h3>{t("Your signatures")}</h3>
        {state.signatures.map((s) => (
          editing === s.id ? null : (
            <div key={s.id} className="sig-item">
              <div className="sig-item-head"><b>{s.name}</b><div className="spacer" />
                <button className="btn sm" onClick={() => copyRich(s.html)} title={t("Copy for Outlook / phone")}><Icon name="copy" size={14} /></button>
                <button className="btn sm" onClick={() => (s.design ? setBuilding({ id: s.id, design: s.design, name: s.name }) : startEdit(s))}>{t("Edit")}</button>
                <button className="icon-btn" onClick={() => confirm(`Delete "${s.name}"?`) && save({ ...state, signatures: state.signatures.filter((x) => x.id !== s.id),
                  defaultNew: state.defaultNew === s.id ? null : state.defaultNew, defaultReply: state.defaultReply === s.id ? null : state.defaultReply })}><Icon name="trash" size={16} /></button></div>
              <div className="sig-preview" dangerouslySetInnerHTML={{ __html: safeHtml(s.html) }} />
            </div>
          )
        ))}
        {building && <SignatureBuilder initial={building.design} seed={building.design ? null : seed()} name={building.name} bookingUrl={bookingUrl} onSave={saveBuilt} onCancel={() => setBuilding(null)} />}
        {building ? null : editing ? (
          <div className="sig-edit card">
            <label className="row-field">{t("Name")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <RichEditor value={draft.html} onChange={(html) => setDraft((d) => ({ ...d, html }))} />
            <div className="step-actions"><button className="btn" onClick={() => setEditing(null)}>{t("Cancel")}</button><button className="btn primary" onClick={commit}>{t("Save signature")}</button></div>
          </div>
        ) : (
          <div className="btn-row">
            <button className="btn primary" onClick={() => setBuilding({ id: null, design: null, name: state.signatures.length ? `Signature ${state.signatures.length + 1}` : 'My signature' })}><Icon name="pen" size={16} />{' '}{t("Design a signature")}</button>
            <button className="btn" onClick={() => startEdit(null)}><Icon name="plus" size={16} />{' '}{t("Write my own")}</button>
          </div>
        )}

        <h3>{t("Defaults")}</h3>
        <label className="row-field">{t("For new messages")}{' '}<select value={state.defaultNew ?? ''} onChange={(e) => save({ ...state, defaultNew: e.target.value || null })}>
            {choices.map(([v, l]) => <option key={String(v)} value={v ?? ''}>{l}</option>)}</select></label>
        <label className="row-field">{t("For replies & forwards")}{' '}<select value={state.defaultReply ?? ''} onChange={(e) => save({ ...state, defaultReply: e.target.value || null })}>
            {choices.map(([v, l]) => <option key={String(v)} value={v ?? ''}>{l}</option>)}</select></label>
        <p className="muted small">{t("You can switch signatures while writing with the")}{' '}<Icon name="pen" size={12} /> button.</p>
      </>}
    </div>
  );
}
