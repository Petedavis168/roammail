import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import RecipientInput from '../RecipientInput.jsx';
import { avatarColor, initials } from '../../util.js';
import { t } from '../../i18n.js';

/** Contact groups: name a list of people, then type the name in To to email all of them. */
export default function ContactGroups({ onEmail }) {
  const toast = useToast();
  const [groups, setGroups] = useState(null);
  const [edit, setEdit] = useState(null); // { id?, name, members }
  const load = () => api.get('/api/contact-groups').then(setGroups).catch((e) => { setGroups([]); toast(e.message, { error: true }); });
  useEffect(() => { load(); }, []);
  const save = async () => {
    try {
      const body = { name: edit.name, members: edit.members };
      if (edit.id) await api.put(`/api/contact-groups/${edit.id}`, body); else await api.post('/api/contact-groups', body);
      toast(t('Group saved')); setEdit(null); load();
    } catch (e) { toast(e.message, { error: true }); }
  };
  const del = async (g) => { if (!confirm(`${t('Delete the group')} “${g.name}”? ${t('The people in it are not deleted.')}`)) return; await api.del(`/api/contact-groups/${g.id}`); load(); };

  if (edit) {
    return (
      <section className="list contact-list groups-edit">
        <div className="list-head"><h2>{edit.id ? t('Edit group') : t('New group')}</h2></div>
        <div className="form" style={{ padding: 16 }}>
          <label>{t('Group name')}<input autoFocus value={edit.name} placeholder={t('e.g. Family, Sales team, Book club')} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <div><b className="small">{t('People in this group')}</b>
            <RecipientInput label={t('Add')} value={edit.members} onChange={(members) => setEdit({ ...edit, members })} />
            <p className="muted small">{t('Type a name or email address and press Enter. Paste a whole list at once if you like.')}</p></div>
          <div className="actions"><button className="btn primary" disabled={!edit.name.trim() || !edit.members.length} onClick={save}>{t('Save group')}</button><button className="btn" onClick={() => setEdit(null)}>{t('Cancel')}</button></div>
        </div>
      </section>
    );
  }
  return (
    <section className="list contact-list">
      <div className="list-head"><h2>{t('Groups')}</h2><button className="btn sm primary" onClick={() => setEdit({ name: '', members: [] })}><Icon name="plus" size={14} /> {t('New group')}</button></div>
      <p className="muted small" style={{ padding: '0 16px' }}>{t('Email a whole group at once: type the group’s name in the To line of a new email.')}</p>
      {!groups && <div className="list-msg"><div className="spinner" /></div>}
      {groups?.length === 0 && <div className="empty"><Icon name="users" size={44} /><p>{t('No groups yet.')}</p><small>{t('Make one for your team, family or clients.')}</small></div>}
      <div className="rows">
        {groups?.map((g) => (
          <div key={g.id} className="row contact-row group-row">
            <span className="avatar group-av">👥</span>
            <div className="row-main"><div className="from">{g.name}</div>
              <div className="snippet">{g.members.length} {g.members.length === 1 ? t('person') : t('people')} · {g.members.slice(0, 4).map((m) => m.name || m.address).join(', ')}{g.members.length > 4 ? '…' : ''}</div>
              <div className="group-faces">{g.members.slice(0, 8).map((m) => <span key={m.address} className="avatar xs" title={m.address} style={{ background: avatarColor(m.address) }}>{initials(m)}</span>)}</div>
            </div>
            <button className="btn sm primary" onClick={() => onEmail?.(g.members)}><Icon name="mail" size={14} /> {t('Email group')}</button>
            <button className="btn sm" onClick={() => setEdit({ ...g })}>{t('Edit')}</button>
            <button className="icon-btn" title={t('Delete')} onClick={() => del(g)}><Icon name="trash" size={15} /></button>
          </div>
        ))}
      </div>
    </section>
  );
}
