import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { useToast } from './Toast.jsx';
import { safeHtml, onSafePaste } from '../safehtml.js';
import { t } from '../i18n.js';

/** Small WYSIWYG editor used for signatures and templates. Uncontrolled: reads initial `value`, reports changes. */
export default function RichEditor({ value, onChange, placeholders, minHeight = 120, editorRef }) {
  const toast = useToast();
  const ref = useRef();
  const file = useRef();
  const [showPh, setShowPh] = useState(false);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = safeHtml(value || ''); }, [value === undefined]);
  useEffect(() => { if (editorRef) editorRef.current = ref.current; });

  const emit = () => onChange?.(ref.current.innerHTML);
  const onPaste = (e) => onSafePaste(e, emit);
  const exec = (cmd, val) => { ref.current.focus(); document.execCommand(cmd, false, val); emit(); };
  const link = () => { const u = prompt(t("Link address (https://…, mailto:…, tel:…)")); if (u) exec('createLink', /^(https?|mailto|tel):/i.test(u) ? u : `https://${u}`); };
  const upload = async (f) => {
    if (!f) return;
    const fd = new FormData(); fd.append('image', f);
    try { const r = await api.form('/api/sig-assets', fd); exec('insertHTML', safeHtml(`<img src="${encodeURI(r.url)}" alt="" width="140" style="max-width:140px;height:auto">`)); }
    catch (e) { toast(e.message, { error: true }); }
  };
  const btn = (title, icon, fn, label) => (
    <button type="button" className="icon-btn" title={title} onMouseDown={(e) => { e.preventDefault(); fn(); }}>{icon ? <Icon name={icon} size={16} /> : label}</button>
  );

  return (
    <div className="rich">
      <div className="rich-bar">
        {btn('Bold', 'bold', () => exec('bold'))}
        {btn('Italic', 'italic', () => exec('italic'))}
        {btn('Underline', 'underline', () => exec('underline'))}
        <label className="icon-btn color-pick" title={t("Text color")}><span>A</span><input type="color" onChange={(e) => exec('foreColor', e.target.value)} /></label>
        <select title={t("Size")} onChange={(e) => { exec('fontSize', e.target.value); e.target.value = ''; }} defaultValue="">
          <option value="" disabled>{t("Size")}</option><option value="1">{t("Small")}</option><option value="3">{t("Normal")}</option><option value="4">{t("Large")}</option><option value="5">{t("Larger")}</option>
        </select>
        {btn('Link', 'link', link)}
        {btn('Insert image / logo', 'clip', () => file.current.click())}
        {btn('Divider line', null, () => exec('insertHTML', '<hr style="border:0;border-top:1px solid #ccc;margin:6px 0">'), '—')}
        {btn('Clear formatting', null, () => exec('removeFormat'), 'Tx')}
        <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
        {placeholders && (
          <div className="dd">
            <button type="button" className="btn sm" onMouseDown={(e) => { e.preventDefault(); setShowPh((x) => !x); }}>{t("Insert field")}{' '}<Icon name="down" size={12} /></button>
            {showPh && (
              <div className="menu" onMouseLeave={() => setShowPh(false)}>
                {placeholders.map(([k, l]) => (
                  <button type="button" key={k} onMouseDown={(e) => { e.preventDefault(); setShowPh(false); if (k === '__custom') { const n = prompt(t('Name the field (for example: price, address, start date)')); const key = String(n || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '_').slice(0, 40); if (/^[a-z]/.test(key)) exec('insertText', `{{${key}}}`); return; } exec('insertText', k === 'logo' ? '' : `{{${k}}}`); if (k === 'logo') exec('insertHTML', '{{#logo}}<img src="{{logo}}" alt="" width="140">{{/logo}}'); }}>
                    {l} {k !== '__custom' && <small className="muted">{`{{${k}}}`}</small>}</button>
                ))}
                {!placeholders.some(([k]) => k === '__custom') && <div className="menu-note">{t("Tip: wrap a line in")}{' '}<code>{'{{#phone}}…{{/phone}}'}</code>{' '}{t("to hide it when the person has no phone number.")}</div>}
              </div>
            )}
          </div>
        )}
      </div>
      <div ref={ref} className="rich-area" contentEditable suppressContentEditableWarning onInput={emit} onBlur={emit} onPaste={onPaste} style={{ minHeight }} />
    </div>
  );
}
