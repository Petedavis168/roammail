import { useState } from 'react';
import { presets, fmtWhen, localInputValue } from '../snooze.js';
import { Icon } from '../icons.jsx';

export default function SnoozeMenu({ onPick, onClose }) {
  const [custom, setCustom] = useState(() => localInputValue(new Date(Date.now() + 3 * 3600e3)));
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2><Icon name="clock" /> Snooze until…</h2><button className="icon-btn" onClick={onClose}><Icon name="close" /></button></div>
        <div className="snooze-list">
          {presets('snooze').map(([l, d]) => (
            <button key={l} onClick={() => onPick(d.getTime())}><span>{l}</span><small className="muted">{fmtWhen(d)}</small></button>
          ))}
        </div>
        <div className="pick-time">
          <input type="datetime-local" value={custom} min={localInputValue(new Date())} onChange={(e) => setCustom(e.target.value)} />
          <button className="btn primary" onClick={() => onPick(new Date(custom).getTime())}>Snooze</button>
        </div>
        <p className="muted small">The message leaves your inbox and comes back, unread and at the top, at that time.</p>
      </div>
    </div>
  );
}
