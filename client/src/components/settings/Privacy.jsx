import { useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { useToast } from '../Toast.jsx';

export default function Privacy({ me }) {
  const toast = useToast();
  const [del, setDel] = useState({ open: false, password: '', confirm: '' });
  const business = (me.orgDomains || []).length > 0;
  return (
    <div className="settings-section">
      <h3>Download your mail</h3>
      <p className="muted small">Get a copy of every message in every folder as a single <b>.mbox</b> file. Gmail, Apple Mail and Thunderbird can import it. Large mailboxes can take a few minutes.</p>
      <div><a className="btn" href="/api/export" download><Icon name="import" size={16} /> Download all my mail</a></div>

      <h3>Your privacy</h3>
      <ul className="privacy-points">
        <li>We don't sell your data or show ads.</li>
        <li>Pictures in emails are blocked until you allow them, so senders can't track when you read their mail.</li>
        <li>Sign-in records are kept only to protect your account, then deleted automatically.</li>
      </ul>
      <p className="small"><a href="/legal/privacy" target="_blank">Privacy Policy</a> · <a href="/legal/terms" target="_blank">Terms</a> · <a href="/legal/acceptable-use" target="_blank">Acceptable Use</a> · <a href="/legal/security" target="_blank">Security</a></p>

      <h3>Delete your account</h3>
      {business ? (
        <p className="muted small">Your mailbox belongs to your organization. Ask your administrator if you need it removed.</p>
      ) : !del.open ? (
        <div><button className="btn danger" onClick={() => setDel({ ...del, open: true })}><Icon name="trash" size={16} /> Delete my account…</button></div>
      ) : (
        <form className="card form danger-zone" onSubmit={async (e) => {
          e.preventDefault();
          try { await api.post('/api/account/delete', { password: del.password, confirm: del.confirm }); alert('Your account has been deleted. Goodbye!'); location.href = '/'; }
          catch (err) { toast(err.message, { error: true }); }
        }}>
          <b>This permanently deletes {me.email} and all of its email.</b>
          <span className="muted small">It can't be undone. Download your mail first if you want to keep it. The address can't be reused by anyone else for a while.</span>
          <label>Your password<input type="password" required autoComplete="current-password" value={del.password} onChange={(e) => setDel({ ...del, password: e.target.value })} /></label>
          <label>Type DELETE to confirm<input required value={del.confirm} onChange={(e) => setDel({ ...del, confirm: e.target.value })} /></label>
          <div className="step-actions"><button type="button" className="btn" onClick={() => setDel({ open: false, password: '', confirm: '' })}>Cancel</button>
            <button className="btn danger" disabled={del.confirm !== 'DELETE'}>Delete forever</button></div>
        </form>
      )}
    </div>
  );
}
