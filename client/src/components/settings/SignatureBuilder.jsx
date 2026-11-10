// Signature builder: pick one of 20 styles, fill in your details (as many phones and emails as you like, address,
// booking link, social links, logo, disclosure), change fonts, sizes and colours, and see it live.
import { useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { safeHtml } from '../../safehtml.js';
import { STYLES, FONTS, SOCIALS, PHONE_LABELS, EMAIL_LABELS, blankDesign, renderSignature, designReady } from '../../sigstyles.js';

const SWATCHES = ['#1d4ed8', '#0f766e', '#15803d', '#b45309', '#b91c1c', '#7c3aed', '#be185d', '#0e7490', '#1f2937', '#000000'];

function Repeater({ items, onChange, labels, placeholder, addText, type = 'text', max = 6 }) {
  const set = (i, patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="sb-rep">
      {items.map((it, i) => (
        <div key={i} className="sb-rep-row">
          <select value={it.label} onChange={(e) => set(i, { label: e.target.value })} aria-label="Label">
            {[...new Set([...labels, it.label].filter(Boolean))].map((l) => <option key={l}>{l}</option>)}
          </select>
          <input type={type} value={it.value} placeholder={placeholder} onChange={(e) => set(i, { value: e.target.value })} aria-label={it.label || 'Value'} />
          <button type="button" className="icon-btn" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="trash" size={15} /></button>
        </div>
      ))}
      {items.length < max && <button type="button" className="btn sm" onClick={() => onChange([...items, { label: labels[0], value: '' }])}><Icon name="plus" size={14} /> {addText}</button>}
    </div>
  );
}

export default function SignatureBuilder({ initial, seed, name: initialName, onSave, onCancel, bookingUrl }) {
  const toast = useToast();
  const [d, setD] = useState(() => blankDesign(initial || seed));
  const [name, setName] = useState(initialName || 'My signature');
  const [tab, setTab] = useState('style');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const html = useMemo(() => renderSignature(d), [d]);
  const thumbs = useMemo(() => (tab === 'style' ? STYLES.map((s) => [s, renderSignature({ ...d, style: s.id })]) : []), [tab, d]);

  const upload = async (file) => {
    if (!file) return;
    if (file.size > 512 * 1024) return toast('Logos can be up to 512 KB. Try a smaller PNG or JPG.', { error: true });
    setUploading(true);
    try { const fd = new FormData(); fd.append('image', file); const r = await api.form('/api/sig-assets', fd); set({ logo: { ...d.logo, url: r.url } }); }
    catch (e) { toast(e.message, { error: true }); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const save = () => {
    if (!designReady(d)) return toast('Add at least your name or company name', { error: true });
    onSave({ name: name.trim() || 'My signature', html, design: d });
  };

  const TABS = [['style', 'Style', 'sparkle'], ['details', 'Details', 'user'], ['contact', 'Contact', 'phone'], ['links', 'Links & booking', 'link'], ['logo', 'Logo', 'image'], ['look', 'Fonts & colours', 'pen'], ['disclosure', 'Disclosure', 'shield']];

  return (
    <div className="sb card">
      <div className="sb-head">
        <label className="row-field">Signature name <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
        <div className="spacer" />
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={save}>Save signature</button>
      </div>
      <div className="sb-body">
        <div className="sb-form">
          <div className="sb-tabs" role="tablist">
            {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>

          {tab === 'style' && (
            <div className="sb-gallery">
              {thumbs.map(([s, h]) => (
                <button key={s.id} type="button" className={`sb-thumb ${d.style === s.id ? 'on' : ''}`} onClick={() => set({ style: s.id })} aria-pressed={d.style === s.id}>
                  <div className="sb-thumb-view" aria-hidden="true"><div className="sb-thumb-inner" dangerouslySetInnerHTML={{ __html: safeHtml(h) }} /></div>
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          )}

          {tab === 'details' && (
            <div className="sb-fields">
              <label>Full name<input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} /></label>
              <label>Job title<input value={d.title} onChange={(e) => set({ title: e.target.value })} maxLength={80} placeholder="e.g. Sales Manager" /></label>
              <label>Department<input value={d.department} onChange={(e) => set({ department: e.target.value })} maxLength={80} /></label>
              <label>Company name<input value={d.company} onChange={(e) => set({ company: e.target.value })} maxLength={120} /></label>
              <label>Address<textarea rows={2} value={d.address} onChange={(e) => set({ address: e.target.value })} maxLength={300} placeholder="Street, City, State ZIP" /></label>
            </div>
          )}

          {tab === 'contact' && (
            <div className="sb-fields">
              <h4>Phone numbers</h4>
              <Repeater items={d.phones} onChange={(phones) => set({ phones })} labels={PHONE_LABELS} placeholder="+1 555 123 4567" addText="Add a phone number" type="tel" />
              <h4>Email addresses</h4>
              <Repeater items={d.emails} onChange={(emails) => set({ emails })} labels={EMAIL_LABELS} placeholder="you@company.com" addText="Add an email address" type="email" />
              <label>Website<input value={d.website} onChange={(e) => set({ website: e.target.value })} placeholder="www.yourcompany.com" maxLength={200} /></label>
            </div>
          )}

          {tab === 'links' && (
            <div className="sb-fields">
              <h4>Booking link</h4>
              <p className="muted small">A button people can click to book time with you.</p>
              <label>Button text<input value={d.booking.label} onChange={(e) => set({ booking: { ...d.booking, label: e.target.value } })} maxLength={40} /></label>
              <label>Booking page address<input value={d.booking.url} onChange={(e) => set({ booking: { ...d.booking, url: e.target.value } })} placeholder="https://…" maxLength={300} /></label>
              {bookingUrl && d.booking.url !== bookingUrl && <button type="button" className="btn sm" onClick={() => set({ booking: { ...d.booking, url: bookingUrl } })}><Icon name="calendar" size={14} /> Use my Roammail booking page</button>}
              {d.booking.url && <button type="button" className="link" onClick={() => set({ booking: { ...d.booking, url: '' } })}>Remove booking button</button>}
              <h4>Social links</h4>
              <div className="sb-rep">
                {d.socials.map((s, i) => (
                  <div key={i} className="sb-rep-row">
                    <select value={s.network} onChange={(e) => set({ socials: d.socials.map((x, j) => (j === i ? { ...x, network: e.target.value } : x)) })} aria-label="Network">
                      {SOCIALS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <input value={s.url} placeholder="https://…" onChange={(e) => set({ socials: d.socials.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} aria-label="Link" />
                    <button type="button" className="icon-btn" onClick={() => set({ socials: d.socials.filter((_, j) => j !== i) })} aria-label="Remove"><Icon name="trash" size={15} /></button>
                  </div>
                ))}
                {d.socials.length < 8 && <button type="button" className="btn sm" onClick={() => set({ socials: [...d.socials, { network: SOCIALS.find(([k]) => !d.socials.some((s) => s.network === k))?.[0] || 'website', url: '' }] })}><Icon name="plus" size={14} /> Add a social link</button>}
              </div>
            </div>
          )}

          {tab === 'logo' && (
            <div className="sb-fields">
              <p className="muted small">PNG or JPG, up to 512 KB. A logo on a white or transparent background looks best.</p>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} />
              <div className="btn-row">
                <button type="button" className="btn" disabled={uploading} onClick={() => fileRef.current?.click()}><Icon name="clip" size={15} /> {uploading ? 'Uploading…' : d.logo.url ? 'Change logo' : 'Upload logo'}</button>
                {d.logo.url && <button type="button" className="btn" onClick={() => set({ logo: { ...d.logo, url: '' } })}>Remove logo</button>}
              </div>
              {d.logo.url && <label>Logo width: {d.logo.width}px<input type="range" min={40} max={260} step={5} value={d.logo.width} onChange={(e) => set({ logo: { ...d.logo, width: Number(e.target.value) } })} /></label>}
              <label>Or paste a logo address<input value={d.logo.url} onChange={(e) => set({ logo: { ...d.logo, url: e.target.value } })} placeholder="https://…/logo.png" maxLength={500} /></label>
            </div>
          )}

          {tab === 'look' && (
            <div className="sb-fields">
              <label>Font<select value={d.fontPicked ? d.font : ''} onChange={(e) => set(e.target.value ? { font: e.target.value, fontPicked: true } : { fontPicked: false })}>
                <option value="">Style's own font</option>
                {FONTS.map(([f, l]) => <option key={f} value={f} style={{ fontFamily: f }}>{l}</option>)}
              </select></label>
              <label>Text size: {d.size}px<input type="range" min={10} max={18} value={d.size} onChange={(e) => set({ size: Number(e.target.value) })} /></label>
              <label>Name size: {d.nameSize}px<input type="range" min={12} max={32} value={d.nameSize} onChange={(e) => set({ nameSize: Number(e.target.value) })} /></label>
              <div className="sb-color"><span>Accent colour</span>
                <div className="sb-swatches">{SWATCHES.map((c) => <button key={c} type="button" className={d.accent === c ? 'on' : ''} style={{ background: c }} onClick={() => set({ accent: c })} aria-label={c} />)}
                  <input type="color" value={d.accent} onChange={(e) => set({ accent: e.target.value })} aria-label="Custom accent colour" /></div></div>
              <div className="sb-color"><span>Text colour</span><input type="color" value={d.color} onChange={(e) => set({ color: e.target.value })} aria-label="Text colour" /></div>
              <div className="sb-color"><span>Secondary text</span><input type="color" value={d.muted} onChange={(e) => set({ muted: e.target.value })} aria-label="Secondary text colour" /></div>
            </div>
          )}

          {tab === 'disclosure' && (
            <div className="sb-fields">
              <p className="muted small">Shown in small print under your signature: a confidentiality notice, licence number, or legal disclaimer.</p>
              <label>Disclosure<textarea rows={6} value={d.disclosure} onChange={(e) => set({ disclosure: e.target.value })} maxLength={2000}
                placeholder="CONFIDENTIALITY NOTICE: This email and any attachments are for the exclusive use of the intended recipient…" /></label>
              <label>Size: {d.disclosureSize}px<input type="range" min={8} max={13} value={d.disclosureSize} onChange={(e) => set({ disclosureSize: Number(e.target.value) })} /></label>
            </div>
          )}
        </div>

        <div className="sb-preview">
          <div className="sb-preview-label">Preview</div>
          <div className="sb-mail">
            <div className="sb-mail-text">Hi Sam,<br /><br />Thanks for your time today. I'll send the details over shortly.<br /><br />Best regards,</div>
            <div dangerouslySetInnerHTML={{ __html: safeHtml(html) }} />
          </div>
        </div>
      </div>
    </div>
  );
}
