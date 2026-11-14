import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useToast } from '../Toast.jsx';

/** A legal / confidentiality notice under every email your team sends. */
export default function CompanyFooter({ org }) {
  const toast = useToast();
  const [f, setF] = useState(null);
  useEffect(() => { api.get(`/api/admin/orgs/${org.id}/footer`).then(setF).catch(() => {}); }, [org.id]);
  if (!f) return null;
  const save = async () => { try { setF(await api.put(`/api/admin/orgs/${org.id}/footer`, f)); toast(f.enabled ? 'Company footer is on' : 'Company footer is off'); } catch (e) { toast(e.message, { error: true }); } };
  return (
    <div className="card form" style={{ marginTop: 18 }}>
      <b>Company footer (disclaimer)</b>
      <p className="muted small">A short notice added under every email your team sends, after their signature. Typical uses: confidentiality notices, licence numbers, registered office details.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Add a footer to every email</label>
      <textarea rows={4} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="This email and any attachments are confidential and intended only for the named recipient. If you received it by mistake, please tell the sender and delete it." />
      <label className="check"><input type="checkbox" checked={f.externalOnly} onChange={(e) => setF({ ...f, externalOnly: e.target.checked })} /> Only on emails to people outside the company</label>
      {f.text && <div className="footer-preview">{f.text}</div>}
      <div className="actions"><button className="btn primary" onClick={save}>Save footer</button></div>
    </div>
  );
}
