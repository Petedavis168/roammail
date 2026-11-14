import { useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';
import { t } from '../../i18n.js';

import PrivacyReport from './PrivacyReport.jsx';

export default function Privacy({ me }) {
  const toast = useToast();
  const [del, setDel] = useState({ open: false, password: '', confirm: '' });
  const business = (me.orgDomains || []).length > 0;
  return (
    <div className="settings-section">
      <PrivacyReport />
      <h3>{t("Download your mail")}</h3>
      <p className="muted small">{t("Get a copy of every message in every folder as a single")}{' '}<b>{t(".mbox")}</b>{' '}{t("file. Gmail, Apple Mail and Thunderbird can import it. Large mailboxes can take a few minutes.")}</p>
      <div><a className="btn" href="/api/export" download><Icon name="import" size={16} />{' '}{t("Download all my mail")}</a></div>

      <h3>{t("Your privacy")}</h3>
      <ul className="privacy-points">
        <li>{t("We don't sell your data or show ads.")}</li>
        <li>{t("Pictures in emails are blocked until you allow them, so senders can't track when you read their mail.")}</li>
        <li>{t("Sign-in records are kept only to protect your account, then deleted automatically.")}</li>
      </ul>
      <p className="small"><a href="/legal/privacy" target="_blank">{t("Privacy Policy")}</a> · <a href="/legal/terms" target="_blank">{t("Terms")}</a> · <a href="/legal/acceptable-use" target="_blank">{t("Acceptable Use")}</a> · <a href="/legal/security" target="_blank">{t("Security")}</a></p>

      <h3>{t("Delete your account")}</h3>
      {business ? (
        <p className="muted small">{t("Your mailbox belongs to your organization. Ask your administrator if you need it removed.")}</p>
      ) : !del.open ? (
        <div><button className="btn danger" onClick={() => setDel({ ...del, open: true })}><Icon name="trash" size={16} />{' '}{t("Delete my account…")}</button></div>
      ) : (
        <form className="card form danger-zone" onSubmit={async (e) => {
          e.preventDefault();
          try { await api.post('/api/account/delete', { password: del.password, confirm: del.confirm }); alert(t("Your account has been deleted. Goodbye!")); location.href = '/'; }
          catch (err) { toast(err.message, { error: true }); }
        }}>
          <b>{t("This permanently deletes")}{' '}{me.email}{' '}{t("and all of its email.")}</b>
          <span className="muted small">{t("It can't be undone. Download your mail first if you want to keep it. The address can't be reused by anyone else for a while.")}</span>
          <label>{t("Your password")}<input type="password" required autoComplete="current-password" value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} /></label>
          <label>{t("Type DELETE to confirm")}<input required value={del.confirm} onChange={(e) => setDel({ ...del, confirm: e.target.value })} /></label>
          <div className="step-actions"><button type="button" className="btn" onClick={() => setDel({ open: false, password: '', confirm: '' })}>{t("Cancel")}</button>
            <button className="btn danger" disabled={del.confirm !== 'DELETE'}>{t("Delete forever")}</button></div>
        </form>
      )}
    </div>
  );
}
