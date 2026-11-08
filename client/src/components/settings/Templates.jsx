import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import RichEditor from '../RichEditor.jsx';
import { safeHtml } from '../../safehtml.js';
import { t } from '../../i18n.js';

/** Edit a list of templates. load() returns the list; save(list) stores it. */
export function TemplatesEditor({ load, save, intro }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState(null);
  useEffect(() => { load().then(setList).catch((e) => toast(e.message, { error: true })); }, []);
  if (!list) return <div className="spinner" />;
  const store = async (next) => { try { const r = await save(next); setList(r.templates || next); toast(t("Saved")); } catch (e) { toast(e.message, { error: true }); } };
  return (
    <div className="settings-section">
      <p className="muted small">{intro}</p>
      {list.map((t) => (
        <div key={t.id} className="card" style={{ marginBottom: 8 }}>
          <b>{t.name}</b> {t.subject && <span className="muted small">{t("Subject:")}{' '}{t.subject}</span>}
          <div className="small sig-preview" dangerouslySetInnerHTML={{ __html: safeHtml(t.html) }} />
          <div className="actions" style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm" onClick={() => setDraft({ ...t })}>{t("Edit")}</button>
            <button className="icon-btn" title={t("Delete")} onClick={() => confirm(`Delete "${t.name}"?`) && store(list.filter((x) => x.id !== t.id))}><Icon name="trash" size={16} /></button>
          </div>
        </div>
      ))}
      {!draft && <button className="btn primary" onClick={() => setDraft({ name: '', subject: '', html: '' })}><Icon name="plus" size={16} />{' '}{t("New template")}</button>}
      {draft && (
        <div className="card form">
          <input placeholder={t("Template name (only you see this)")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder={t("Subject (optional)")} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          <RichEditor value={draft.html} onChange={(html) => setDraft((d) => ({ ...d, html }))} />
          <div className="actions">
            <button className="btn primary" disabled={!draft.name.trim()} onClick={async () => { await store(draft.id ? list.map((x) => (x.id === draft.id ? draft : x)) : [...list, draft]); setDraft(null); }}>{t("Save")}</button>
            <button className="btn" onClick={() => setDraft(null)}>{t("Cancel")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Templates() {
  return <TemplatesEditor intro="Templates are ready-made messages you use often. Insert one from the New mail window (the 📄 button)."
    load={() => api.get('/api/templates').then((d) => d.personal)} save={(templates) => api.put('/api/templates', { templates })} />;
}
