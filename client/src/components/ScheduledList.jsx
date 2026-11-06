import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtWhen } from '../snooze.js';
import { useToast } from './Toast.jsx';

export default function ScheduledList() {
  const toast = useToast();
  const [jobs, setJobs] = useState(null);
  const load = () => api.get('/api/scheduled').then(setJobs).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);
  const cancel = async (j, toDrafts) => {
    await api.del('/api/scheduled', { id: j.id, toDrafts: toDrafts ? 1 : '' });
    toast(toDrafts ? 'Moved to Drafts. Open it there to edit.' : 'Scheduled message cancelled');
    load();
  };
  return (
    <section className="list wide-list">
      <div className="list-head"><h2>Scheduled</h2></div>
      <div className="rows">
        {!jobs && <div className="list-msg"><div className="spinner" /></div>}
        {jobs?.length === 0 && <div className="empty"><Icon name="clock" size={48} /><p>Nothing scheduled.</p><small>Use the arrow next to <b>Send</b> to send later.</small></div>}
        {jobs?.map((j) => (
          <div key={j.id} className="row">
            <div className="row-main">
              <div className="row-top"><span className="from">To: {j.summary.to}</span>
                <span className={`date ${j.status === 'failed' ? 'bad' : 'snoozed'}`}><Icon name="clock" size={12} /> {fmtWhen(j.run_at)}</span></div>
              <div className="row-sub"><span className="subject">{j.summary.subject || '(no subject)'}</span></div>
              {j.status === 'failed' && <div className="snippet bad">Not sent: {j.error}</div>}
            </div>
            <div className="sched-actions">
              <button className="btn sm" onClick={() => cancel(j, true)}>Edit</button>
              <button className="btn sm" onClick={() => cancel(j, false)}>Cancel</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
