import { Icon } from '../icons.jsx';

export default function SettingsPanel({ prefs, setPrefs, me, onClose }) {
  const set = (k) => (e) => setPrefs({ [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h2>Settings</h2><button className="icon-btn" onClick={onClose}><Icon name="close" /></button></div>
        <div className="drawer-body">
          <h3>Layout</h3>
          <label className="row-field">Reading pane
            <select value={prefs.readingPane} onChange={set('readingPane')}>
              <option value="right">Show on the right</option><option value="bottom">Show on the bottom</option><option value="off">Hidden (open messages full width)</option>
            </select></label>
          <label className="row-field">Density
            <select value={prefs.density} onChange={set('density')}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
          <label className="check"><input type="checkbox" checked={prefs.conversation} onChange={set('conversation')} /> Conversation view (group replies together)</label>

          <h3>Writing</h3>
          <label className="row-field">Your name (shown to recipients)<input value={prefs.displayName} placeholder={me.name || me.email} onChange={set('displayName')} /></label>
          <label className="row-field col">Signature<textarea rows={4} value={prefs.signature} onChange={set('signature')} placeholder="Jane Doe&#10;Acme Inc. · (555) 123-4567" /></label>
          <label className="row-field">Undo send
            <select value={prefs.undoSeconds} onChange={set('undoSeconds')}>
              {[0, 5, 10, 20, 30].map((s) => <option key={s} value={s}>{s ? `${s} seconds` : 'Off'}</option>)}
            </select></label>

          <h3>Privacy</h3>
          <label className="row-field">External images
            <select value={prefs.showImages} onChange={set('showImages')}><option value="ask">Ask before showing</option><option value="always">Always show</option></select></label>
          {prefs.trustedSenders.length > 0 && (
            <div className="trusted">
              <small className="muted">Always show images from:</small>
              {prefs.trustedSenders.map((s) => (
                <span key={s} className="rchip">{s}<button onClick={() => setPrefs((p) => ({ trustedSenders: p.trustedSenders.filter((x) => x !== s) }))}>×</button></span>
              ))}
            </div>
          )}
          <label className="check"><input type="checkbox" checked={prefs.notifications} onChange={set('notifications')} /> Desktop notifications for new mail</label>

          <h3>Categories</h3>
          {prefs.categories.map((c, i) => (
            <div key={i} className="cat-edit">
              <input type="color" value={c.color} onChange={(e) => setPrefs((p) => ({ categories: p.categories.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) }))} />
              <input value={c.name} onChange={(e) => setPrefs((p) => ({ categories: p.categories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))} />
              <button className="icon-btn" onClick={() => setPrefs((p) => ({ categories: p.categories.filter((_, j) => j !== i) }))}><Icon name="trash" size={16} /></button>
            </div>
          ))}
          <button className="btn" onClick={() => setPrefs((p) => ({ categories: [...p.categories, { name: 'New', color: '#038387' }] }))}><Icon name="plus" size={16} /> Add category</button>

          <h3>Use on your phone or desktop app</h3>
          <p className="muted small">Your account also works in Outlook, Apple Mail, Thunderbird and phone mail apps. Use your email address and password; most apps set themselves up automatically.</p>
        </div>
      </aside>
    </div>
  );
}
