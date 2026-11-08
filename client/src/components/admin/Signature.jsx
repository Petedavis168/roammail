import { safeHtml } from '../../safehtml.js';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import RichEditor from '../RichEditor.jsx';
import { useToast } from '../Toast.jsx';

export const STARTERS = [
  ['Simple', `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333333;line-height:1.45"><b style="font-size:14px;color:#111111">{{name}}</b>{{#title}}<br>{{title}}{{/title}}<br>{{company}}{{#phone}}<br>Phone: <a href="tel:{{phone}}" style="color:#333333">{{phone}}</a>{{/phone}}{{#mobile}}<br>Mobile: <a href="tel:{{mobile}}" style="color:#333333">{{mobile}}</a>{{/mobile}}<br><a href="mailto:{{email}}" style="color:#244960">{{email}}</a>{{#website}} · <a href="{{website}}" style="color:#244960">{{website}}</a>{{/website}}</div>`],
  ['With logo', `<table cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333333"><tbody><tr>{{#logo}}<td style="padding-right:14px;vertical-align:top"><img src="{{logo}}" alt="{{company}}" width="90" style="max-width:90px;height:auto"></td>{{/logo}}<td style="border-left:2px solid #244960;padding-left:14px;vertical-align:top;line-height:1.45"><b style="font-size:15px;color:#111111">{{name}}</b>{{#title}}<br><span style="color:#244960">{{title}}</span>{{/title}}{{#department}} · {{department}}{{/department}}<br><b>{{company}}</b>{{#phone}}<br>T: {{phone}}{{/phone}}{{#mobile}}  M: {{mobile}}{{/mobile}}<br><a href="mailto:{{email}}" style="color:#333333">{{email}}</a>{{#website}}<br><a href="{{website}}" style="color:#244960">{{website}}</a>{{/website}}{{#address}}<br><span style="color:#777777;font-size:12px">{{address}}</span>{{/address}}</td></tr></tbody></table>`],
  ['Modern', `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#242424"><div style="font-size:16px;font-weight:bold">{{name}}</div>{{#title}}<div style="color:#616161">{{title}}, {{company}}</div>{{/title}}{{^title}}<div style="color:#616161">{{company}}</div>{{/title}}<hr style="border:0;border-top:1px solid #dddddd;margin:6px 0;width:220px">{{#phone}}<div>📞 {{phone}}</div>{{/phone}}<div>✉️ <a href="mailto:{{email}}" style="color:#244960">{{email}}</a></div>{{#website}}<div>🌐 <a href="{{website}}" style="color:#244960">{{website}}</a></div>{{/website}}{{#logo}}<img src="{{logo}}" alt="" width="120" style="margin-top:8px;max-width:120px;height:auto">{{/logo}}</div>`],
  ['Legal disclaimer', `<div style="font-family:Arial,sans-serif;font-size:13px;color:#333333"><b>{{name}}</b>{{#title}} | {{title}}{{/title}}<br>{{company}}{{#phone}} | {{phone}}{{/phone}}<p style="font-size:10px;color:#888888;margin-top:10px;max-width:520px">This email and any attachments are confidential and intended solely for the addressee. If you received it in error, please notify the sender and delete it.</p></div>`],
];

export default function OrgSignature({ org, users }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [html, setHtml] = useState('');
  const [preview, setPreview] = useState('');
  const [who, setWho] = useState('');
  const [key, setKey] = useState(0);
  const timer = useRef();
  const logoInput = useRef();

  useEffect(() => { api.get(`/api/admin/orgs/${org.id}/signature`).then((d) => { setS(d); setHtml(d.html); setKey((k) => k + 1); }); }, [org.id]);
  useEffect(() => {
    if (!s) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api.post(`/api/admin/orgs/${org.id}/signature/preview`, { html, email: who, vars: s.vars }).then((r) => setPreview(r.html)).catch(() => {}), 300);
  }, [html, who, s]);
  if (!s) return <div className="spinner" />;

  const save = async () => {
    try { const r = await api.put(`/api/admin/orgs/${org.id}/signature`, { html, mode: s.mode, onReplies: s.onReplies, vars: s.vars }); setS({ ...s, ...r }); toast('Company signature saved. Everyone gets it right away.'); }
    catch (e) { toast(e.message, { error: true }); }
  };
  const uploadLogo = async (f) => {
    const fd = new FormData(); fd.append('image', f);
    try { const r = await api.form('/api/sig-assets', fd); setS({ ...s, vars: { ...s.vars, logo: r.url } }); } catch (e) { toast(e.message, { error: true }); }
  };
  const setVar = (k) => (e) => setS({ ...s, vars: { ...s.vars, [k]: e.target.value } });

  return (
    <div className="org-sig-admin">
      <p className="muted">Design one signature for everyone. Each person's name, title and phone are filled in automatically, including new hires the moment you add them.</p>
      <div className="card">
        <h3>How it's used</h3>
        {[['off', 'Off', 'People make their own signatures.'], ['default', 'Default', 'Everyone starts with it, but can switch to their own.'], ['enforced', 'Required', 'Added by the server to every email sent from webmail. People can\'t remove or change it.']].map(([v, l, d]) => (
          <label key={v} className="radio-card"><input type="radio" name="mode" checked={s.mode === v} onChange={() => setS({ ...s, mode: v })} /><div><b>{l}</b><small className="muted">{d}</small></div></label>
        ))}
        <label className="check"><input type="checkbox" checked={s.onReplies} onChange={(e) => setS({ ...s, onReplies: e.target.checked })} /> Also add to replies and forwards</label>
      </div>
      <div className="card">
        <h3>Company details</h3>
        <div className="two-col">
          <label>Company name<input value={s.vars.company} onChange={setVar('company')} /></label>
          <label>Website<input value={s.vars.website} placeholder="https://…" onChange={setVar('website')} /></label>
        </div>
        <label>Address<input value={s.vars.address} onChange={setVar('address')} /></label>
        <div className="logo-row">
          {s.vars.logo ? <img src={s.vars.logo} alt="logo" /> : <span className="muted small">No logo</span>}
          <button className="btn sm" onClick={() => logoInput.current.click()}>{s.vars.logo ? 'Change logo' : 'Upload logo'}</button>
          {s.vars.logo && <button className="btn sm" onClick={() => setS({ ...s, vars: { ...s.vars, logo: '' } })}>Remove</button>}
          <input ref={logoInput} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => { e.target.files[0] && uploadLogo(e.target.files[0]); e.target.value = ''; }} />
          <small className="muted">PNG or JPG, under 512 KB. Hosted for you so it shows in every mail app.</small>
        </div>
      </div>
      <div className="card">
        <div className="sig-head"><h3>Template</h3><div className="spacer" />
          <span className="muted small">Start from:</span>
          {STARTERS.map(([n, t]) => <button key={n} className="chip" onClick={() => { if (!html || confirm('Replace the current template?')) { setHtml(t); setKey((k) => k + 1); } }}>{n}</button>)}
        </div>
        <RichEditor key={key} value={html} onChange={setHtml} placeholders={s.placeholders} minHeight={140} />
        <div className="sig-head"><h3>Preview</h3><div className="spacer" />
          <select aria-label="Preview the signature for" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Sample person</option>
            {users.map((u) => <option key={u.email} value={u.email}>{u.name || u.email}</option>)}
          </select>
        </div>
        <div className="sig-preview big" dangerouslySetInnerHTML={{ __html: preview ? safeHtml(preview) : '<span style="color:#666">Your signature preview appears here</span>' }} />
        <p className="muted small">Signatures are added to mail sent from this webmail. For Outlook desktop or phone apps, each person can copy their filled-in signature from <b>Settings → Signatures</b>.</p>
      </div>
      <div className="step-actions sticky-save"><button className="btn primary" onClick={save}>Save company signature</button></div>
    </div>
  );
}
