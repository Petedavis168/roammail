import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import RichEditor from '../RichEditor.jsx';
import { safeHtml } from '../../safehtml.js';
import { t as tr } from '../../i18n.js';
import { GALLERY, CATEGORIES, BUILTIN_FIELDS, templateFields, fieldLabel, fillTemplate } from '../../templategallery.js';

const FIELD_CHOICES = [...BUILTIN_FIELDS, ['__custom', 'Your own field…']];
const SAMPLE = { first_name: 'Alex', name: 'Alex Morgan', my_first_name: 'Sam', my_name: 'Sam Lee', my_email: 'sam@example.com', date: new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), day: new Date().toLocaleDateString(undefined, { weekday: 'long' }) };
/** Preview with sample values; the fields you fill in each time show as highlighted blanks. */
const preview = (t) => {
  const f = fillTemplate(t, SAMPLE);
  return { subject: f.subject, html: f.html.replace(/\{\{\s*([A-Za-z][\w ]{0,40}?)\s*\}\}/g, (_, k) => `<span class="tpl-blank">${fieldLabel(k.trim().toLowerCase().replace(/\s+/g, '_'))}</span>`) };
};

function TemplateCard({ t, onUse, onEdit, onDelete, useLabel }) {
  const pv = preview(t);
  const custom = templateFields(t).filter((k) => !BUILTIN_FIELDS.some(([b]) => b === k));
  return (
    <div className="tpl-card">
      <div className="tpl-card-head">
        <b>{t.name}</b>{t.category && <span className="pill">{tr(t.category)}</span>}
      </div>
      {pv.subject && <div className="small muted tpl-subj">{pv.subject}</div>}
      <div className="small tpl-body" dangerouslySetInnerHTML={{ __html: safeHtml(pv.html) }} />
      {custom.length > 0 && <div className="small muted">{tr('You fill in:')} {custom.map(fieldLabel).join(', ')}</div>}
      <div className="tpl-actions">
        {onUse && <button className="btn sm primary" onClick={onUse}>{useLabel}</button>}
        {onEdit && <button className="btn sm" onClick={onEdit}>{tr('Edit')}</button>}
        {onDelete && <button className="icon-btn" title={tr('Delete')} aria-label={tr('Delete')} onClick={onDelete}><Icon name="trash" size={16} /></button>}
      </div>
    </div>
  );
}

/** Edit a list of templates. load() returns the list; save(list) stores it. */
export function TemplatesEditor({ load, save, intro }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState(null);
  const [view, setView] = useState('mine'); // mine | gallery
  const [cat, setCat] = useState('All');
  const [q, setQ] = useState('');
  useEffect(() => { load().then((l) => { setList(l); if (!l.length) setView('gallery'); }).catch((e) => toast(e.message, { error: true })); }, []);
  const gallery = useMemo(() => GALLERY.filter((g) => (cat === 'All' || g.category === cat) && (!q || `${g.name} ${g.subject} ${g.category}`.toLowerCase().includes(q.toLowerCase()))), [cat, q]);
  if (!list) return <div className="spinner" />;
  const store = async (next, msg = tr('Saved')) => { try { const r = await save(next); setList(r.templates || next); toast(msg); return true; } catch (e) { toast(e.message, { error: true }); return false; } };
  const mine = list.filter((x) => !q || `${x.name} ${x.subject}`.toLowerCase().includes(q.toLowerCase()));

  if (draft) {
    const pv = preview(draft);
    return (
      <div className="settings-section">
        <div className="card form tpl-builder">
          <div className="two-col">
            <label>{tr('Template name')}<input placeholder={tr('e.g. Send a quote')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>{tr('Group')}<input list="tpl-cats" placeholder={tr('e.g. Sales')} value={draft.category || ''} onChange={(e) => setDraft({ ...draft, category: e.target.value })} /></label>
          </div>
          <datalist id="tpl-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
          <label>{tr('Subject (optional)')}<input placeholder={tr('e.g. Your quote for {{service}}')} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label>
          <RichEditor value={draft.html} onChange={(html) => setDraft((d) => ({ ...d, html }))} placeholders={FIELD_CHOICES} minHeight={180} />
          <p className="muted small">{tr('Fields in {{double brackets}} are filled in when you use the template. Their name, your name and the date fill themselves; anything else you type in each time.')}</p>
          <div className="tpl-preview">
            <div className="muted small">{tr('Preview')}</div>
            {pv.subject && <b>{pv.subject}</b>}
            <div dangerouslySetInnerHTML={{ __html: safeHtml(pv.html) }} />
          </div>
          <div className="actions">
            <button className="btn primary" disabled={!draft.name.trim()} onClick={async () => { const next = draft.id ? list.map((x) => (x.id === draft.id ? draft : x)) : [...list, draft]; if (await store(next)) { setDraft(null); setView('mine'); } }}>{tr('Save template')}</button>
            <button className="btn" onClick={() => setDraft(null)}>{tr('Cancel')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <p className="muted small">{intro}</p>
      <div className="tpl-toolbar">
        <div className="seg">
          <button className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>{tr('My templates')} ({list.length})</button>
          <button className={view === 'gallery' ? 'on' : ''} onClick={() => setView('gallery')}>{tr('Ready-made')} ({GALLERY.length})</button>
        </div>
        <input className="tpl-search" type="search" placeholder={tr('Search templates')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr('Search templates')} />
        <button className="btn primary" onClick={() => setDraft({ name: '', subject: '', html: '', category: '' })}><Icon name="plus" size={16} /> {tr('New template')}</button>
      </div>

      {view === 'gallery' && <>
        <div className="chips">
          {['All', ...CATEGORIES].map((c) => <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{tr(c)}</button>)}
        </div>
        <div className="tpl-grid">
          {gallery.map((g) => (
            <TemplateCard key={g.id} t={g} useLabel={tr('Add to my templates')}
              onUse={() => store([...list, { name: g.name, subject: g.subject, html: g.html, category: g.category }], tr('Added to your templates'))}
              onEdit={() => setDraft({ name: g.name, subject: g.subject, html: g.html, category: g.category })} />
          ))}
        </div>
      </>}

      {view === 'mine' && <>
        {!list.length && <div className="empty-card small">{tr('No templates yet. Pick one from Ready-made or make your own.')}</div>}
        <div className="tpl-grid">
          {mine.map((x) => (
            <TemplateCard key={x.id} t={x} onEdit={() => setDraft({ ...x })} onDelete={() => confirm(`${tr('Delete')} "${x.name}"?`) && store(list.filter((y) => y.id !== x.id))} />
          ))}
        </div>
      </>}
    </div>
  );
}

export default function Templates() {
  return <TemplatesEditor intro={tr('Templates are emails you send often. Use one from a new message: ⋯ More options → Template. Fill-in fields like the person’s first name are filled in for you.')}
    load={() => api.get('/api/templates').then((d) => d.personal)} save={(templates) => api.put('/api/templates', { templates })} />;
}
