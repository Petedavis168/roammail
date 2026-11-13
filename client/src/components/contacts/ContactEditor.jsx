import { useState } from 'react';
import { useDialog } from '../../a11y.js';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { t } from '../../i18n.js';

const blankRow = (type) => ({ value: '', type });
export default function ContactEditor({ contact, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !contact.href;
  const [f, setF] = useState({
    first: contact.first || '', last: contact.last || '', company: contact.company || '', title: contact.title || '',
    emails: contact.emails?.length ? contact.emails : [blankRow('work')], phones: contact.phones?.length ? contact.phones : [blankRow('mobile')],
    address: contact.address || { street: '', city: '', region: '', postal: '', country: '' }, birthday: contact.birthday || '', note: contact.note || '',
    name: contact.name || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setRow = (k, i, patch) => setF({ ...f, [k]: f[k].map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  const save = async (e) => {
    e.preventDefault(); setBusy(true);
    const body = { ...f, name: [f.first, f.last].filter(Boolean).join(' ') || f.name, emails: f.emails.filter((x) => x.value.trim()), phones: f.phones.filter((x) => x.value.trim()) };
    try {
      if (isNew) await api.post('/api/address-contacts', body); else await api.put('/api/address-contacts', { ...body, href: contact.href, etag: contact.etag });
      toast(isNew ? 'Contact added' : 'Contact saved'); onSaved();
    } catch (err) { toast(err.message, { error: true }); } finally { setBusy(false); }
  };
  const Rows = ({ k, types, placeholder, inputType }) => (
    <>
      {f[k].map((r, i) => (
        <div className="ev-row" key={i}>
          <input type={inputType} placeholder={placeholder} value={r.value} onChange={(e) => setRow(k, i, { value: e.target.value })} />
          <select value={r.type} onChange={(e) => setRow(k, i, { type: e.target.value })}>{types.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select>
          {f[k].length > 1 && <button type="button" className="icon-btn" onClick={() => setF({ ...f, [k]: f[k].filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>}
        </div>
      ))}
      <button type="button" className="link left" onClick={() => setF({ ...f, [k]: [...f[k], blankRow(types[0])] })}>{t("+ Add")}{' '}{k === 'emails' ? 'email' : 'phone'}</button>
    </>
  );
  const dlg = useDialog(onClose);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <form ref={dlg} data-dialog tabIndex={-1} role="dialog" aria-modal="true" className="modal contact-editor" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="modal-head"><h2>{isNew ? 'New contact' : 'Edit contact'}</h2><button type="button" className="icon-btn" onClick={onClose}><Icon name="close" /></button></div>
        <div className="form">
          <div className="two-col">
            <label>{t("First name")}<input value={f.first} onChange={set('first')} autoFocus /></label>
            <label>{t("Last name")}<input value={f.last} onChange={set('last')} /></label>
            <label>{t("Company")}<input value={f.company} onChange={set('company')} /></label>
            <label>{t("Job title")}<input value={f.title} onChange={set('title')} /></label>
          </div>
          <b className="small">{t("Email")}</b>
          <Rows k="emails" types={['work', 'home', 'other']} placeholder="name@example.com" inputType="email" />
          <b className="small">{t("Phone")}</b>
          <Rows k="phones" types={['mobile', 'work', 'home', 'other']} placeholder="+1 555 010 2030" inputType="tel" />
          <details><summary className="small">{t("Address, birthday and notes")}</summary>
            <div className="form" style={{ marginTop: 8 }}>
              <input placeholder={t("Street")} value={f.address.street} onChange={(e) => setF({ ...f, address: { ...f.address, street: e.target.value } })} />
              <div className="two-col">
                <input placeholder={t("City")} value={f.address.city} onChange={(e) => setF({ ...f, address: { ...f.address, city: e.target.value } })} />
                <input placeholder={t("State / region")} value={f.address.region} onChange={(e) => setF({ ...f, address: { ...f.address, region: e.target.value } })} />
                <input placeholder={t("Postal code")} value={f.address.postal} onChange={(e) => setF({ ...f, address: { ...f.address, postal: e.target.value } })} />
                <input placeholder={t("Country")} value={f.address.country} onChange={(e) => setF({ ...f, address: { ...f.address, country: e.target.value } })} />
              </div>
              <label>{t("Birthday")}<input type="date" value={f.birthday} onChange={set('birthday')} /></label>
              <label>{t("Notes")}<textarea rows={3} value={f.note} onChange={set('note')} /></label>
            </div>
          </details>
        </div>
        <div className="step-actions"><button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </div>
  );
}
