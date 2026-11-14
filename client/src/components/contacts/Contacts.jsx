import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { avatarColor, initials } from '../../util.js';
import ContactEditor from './ContactEditor.jsx';
import ContactGroups from './ContactGroups.jsx';
import { t } from '../../i18n.js';

export default function Contacts({ me, onEmail, onEmailMany }) {
  const toast = useToast();
  const [tab, setTab] = useState('mine');
  const [list, setList] = useState(null);
  const [dir, setDir] = useState(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);
  const file = useRef();
  const business = (me.orgDomains || []).length > 0;

  const load = (fresh) => api.get('/api/address-contacts', fresh ? { fresh: 1 } : undefined).then(setList).catch((e) => { setList([]); toast(e.message, { error: true }); });
  useEffect(() => { load(); if (business) api.get('/api/directory').then(setDir).catch(() => setDir([])); }, []);

  const items = tab === 'mine' ? (list || []) : (dir || []).map((p) => ({ ...p, emails: [{ value: p.email, type: 'work' }], phones: [p.phone && { value: p.phone, type: 'work' }, p.mobile && { value: p.mobile, type: 'mobile' }].filter(Boolean), company: p.department, directory: true }));
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((c) => !s || [c.name, c.company, c.title, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)].some((v) => String(v || '').toLowerCase().includes(s)));
  }, [items, q]);
  const groups = useMemo(() => {
    const g = new Map();
    for (const c of filtered) { const k = (c.name || c.emails[0]?.value || '#')[0].toUpperCase(); const key = /[A-Z]/.test(k) ? k : '#'; if (!g.has(key)) g.set(key, []); g.get(key).push(c); }
    return [...g.entries()];
  }, [filtered]);
  const current = filtered.find((c) => (c.href || c.email) === sel) || null;

  const importFile = async (f) => {
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try { const r = await api.form('/api/address-contacts/import', fd); toast(`Imported ${r.added} contact${r.added === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped: duplicates or empty)` : ''}`); load(true); }
    catch (e) { toast(e.message, { error: true }); }
  };
  const del = async (c) => {
    if (!confirm(`Delete ${c.name}?`)) return;
    try { await api.del('/api/address-contacts', { href: c.href }); toast(t("Contact deleted")); setSel(null); load(true); } catch (e) { toast(e.message, { error: true }); }
  };

  return (
    <div className="contacts">
      <aside className="cal-side">
        <button className="compose-btn" onClick={() => setEditing({})}><Icon name="plus" />{' '}{t("New contact")}</button>
        <div className="nav-section">
          <div className={`folder ${tab === 'mine' ? 'on' : ''}`} onClick={() => { setTab('mine'); setSel(null); }} role="button"><span className="twisty" /><Icon name="users" /><span className="fname">{t("My contacts")}</span><span className="count muted">{list?.length ?? ''}</span></div>
          <div className={`folder ${tab === 'groups' ? 'on' : ''}`} onClick={() => { setTab('groups'); setSel(null); }} role="button"><span className="twisty" /><span className="ic-emoji">👥</span><span className="fname">{t("Groups")}</span></div>
          {business && <div className={`folder ${tab === 'dir' ? 'on' : ''}`} onClick={() => { setTab('dir'); setSel(null); }} role="button"><span className="twisty" /><Icon name="globe" /><span className="fname">{t("Company directory")}</span><span className="count muted">{dir?.length ?? ''}</span></div>}
        </div>
        <div className="nav-title">{t("Import & export")}</div>
        <div className="side-actions">
          <button className="btn sm" onClick={() => file.current.click()}><Icon name="import" size={14} />{' '}{t("Import .vcf")}</button>
          <a className="btn sm" href="/api/address-contacts/export" download><Icon name="external" size={14} />{' '}{t("Export")}</a>
          <input ref={file} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={(e) => { importFile(e.target.files[0]); e.target.value = ''; }} />
        </div>
        <p className="muted small cal-sync">{t("Export contacts from Gmail (contacts.google.com → Export → vCard) or Outlook and import them here. They sync to your phone too.")}</p>
      </aside>
      {tab === 'groups' ? <ContactGroups onEmail={onEmailMany} /> : <>
      <section className="list contact-list">
        <div className="list-head"><h2>{tab === 'mine' ? 'My contacts' : 'Company directory'}</h2></div>
        <div className="contact-search"><Icon name="search" size={16} /><input placeholder={t("Search name, email, company, phone")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="rows">
          {(tab === 'mine' ? !list : !dir) && <div className="list-msg"><div className="spinner" /></div>}
          {filtered.length === 0 && (tab === 'mine' ? list : dir) && (
            <div className="empty"><Icon name="users" size={48} /><p>{q ? 'No matches.' : tab === 'mine' ? 'No contacts yet.' : 'No coworkers found.'}</p>
              {!q && tab === 'mine' && <small>{t("Add one, import a .vcf file, or open any email and choose “Add to contacts”.")}</small>}</div>
          )}
          {groups.map(([letter, cs]) => [
            <div className="group-head" key={`h${letter}`}>{letter}</div>,
            ...cs.map((c) => (
              <div key={c.href || c.email} className={`row contact-row ${sel === (c.href || c.email) ? 'active' : ''}`} onClick={() => setSel(c.href || c.email)}>
                <span className="avatar" style={{ background: avatarColor(c.emails[0]?.value || c.name) }}>{initials({ name: c.name, address: c.emails[0]?.value })}</span>
                <div className="row-main"><div className="from">{c.name}</div><div className="snippet">{[c.title, c.company].filter(Boolean).join(' · ') || c.emails[0]?.value}</div></div>
              </div>
            )),
          ])}
        </div>
      </section>
      <section className="reading contact-detail">
        {!current ? (
          <div className="empty-pane"><Icon name="users" size={64} /><p>{t("Select a contact")}</p></div>
        ) : (
          <div className="thread">
            <div className="contact-card">
              <span className="avatar xl" style={{ background: avatarColor(current.emails[0]?.value || current.name) }}>{initials({ name: current.name, address: current.emails[0]?.value })}</span>
              <div><h1>{current.name}</h1><div className="muted">{[current.title, current.company].filter(Boolean).join(' · ')}</div></div>
            </div>
            <div className="contact-actions">
              {current.emails[0] && <button className="btn primary" onClick={() => onEmail({ name: current.name, email: current.emails[0].value })}><Icon name="mail" size={16} />{' '}{t("Email")}</button>}
              {current.phones[0] && <a className="btn" href={`tel:${current.phones[0].value.replace(/[^\d+]/g, '')}`}><Icon name="phone" size={16} />{' '}{t("Call")}</a>}
              {!current.directory && <button className="btn" onClick={() => setEditing(current)}><Icon name="pen" size={16} />{' '}{t("Edit")}</button>}
              {!current.directory && <button className="btn ghost" onClick={() => del(current)}><Icon name="trash" size={16} /></button>}
            </div>
            <div className="table contact-fields">
              {current.emails.map((e, i) => <div className="tr two" key={`e${i}`}><span className="muted">{e.type} email</span><span><a href="#" onClick={(x) => { x.preventDefault(); onEmail({ name: current.name, email: e.value }); }}>{e.value}</a></span><span /></div>)}
              {current.phones.map((p, i) => <div className="tr two" key={`p${i}`}><span className="muted">{p.type}</span><span><a href={`tel:${p.value.replace(/[^\d+]/g, '')}`}>{p.value}</a></span><span /></div>)}
              {current.address && Object.values(current.address).some(Boolean) && <div className="tr two"><span className="muted">address</span><span>{[current.address.street, current.address.city, current.address.region, current.address.postal, current.address.country].filter(Boolean).join(', ')}</span><span /></div>}
              {current.birthday && <div className="tr two"><span className="muted">birthday</span><span>{new Date(`${current.birthday}T00:00:00`).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</span><span /></div>}
              {current.note && <div className="tr two"><span className="muted">notes</span><span className="pre">{current.note}</span><span /></div>}
            </div>
          </div>
        )}
      </section>
      </>}
      {editing && <ContactEditor contact={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(true); }} />}
    </div>
  );
}
