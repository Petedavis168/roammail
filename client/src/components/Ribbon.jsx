import { useState } from 'react';
import { Icon } from '../icons.jsx';
import { folderIcon, folderLabel } from '../util.js';

// Icon-only buttons with a tooltip; names stay available to screen readers.
function Tool({ icon, label, onClick, disabled, active }) {
  return (
    <button className={`tb ${active ? 'on' : ''}`} onClick={onClick} disabled={disabled} title={label} aria-label={label}>
      <Icon name={icon} size={18} />
    </button>
  );
}

function Dropdown({ icon, label, children, right }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dd" onMouseLeave={() => setOpen(false)}>
      <Tool icon={icon} label={label} onClick={() => setOpen((o) => !o)} active={open} />
      {open && <div className={`menu ${right ? 'right' : ''}`} onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

/** Message toolbar. Actions only appear once something is selected; Reply/Forward live in the reading pane. */
export default function Ribbon({ hasSelection, count = 0, folderUse, folders, act, categories, onRefresh, readingPane, setReadingPane, density, setDensity }) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Message actions">
      {hasSelection ? (
        <>
          {count > 1 && <span className="tb-count">{count} selected</span>}
          {folderUse !== '\\Archive' && <Tool icon="archive" label="Archive (e)" onClick={() => act.archive()} />}
          <Tool icon="trash" label="Delete (#)" onClick={() => act.del()} />
          <Tool icon="clock" label="Snooze (b)" onClick={() => act.snooze()} />
          <Dropdown icon="move" label="Move to">
            {folders.filter((f) => !f.flags.includes('\\Noselect')).map((f) => (
              <button key={f.path} onClick={() => act.move(f.path)}><Icon name={folderIcon(f)} /> {folderLabel(f)}</button>
            ))}
          </Dropdown>
          <Tool icon="flag" label="Flag (s)" onClick={() => act.flag()} />
          <Dropdown icon="more" label="More actions">
            {folderUse === '\\Junk'
              ? <button onClick={() => act.notJunk()}><Icon name="inbox" /> Not junk</button>
              : <button onClick={() => act.junk()}><Icon name="junk" /> Report junk (!)</button>}
            <button onClick={() => act.read(true)}><Icon name="mailOpen" /> Mark as read</button>
            <button onClick={() => act.read(false)}><Icon name="mail" /> Mark as unread</button>
            {categories.length > 0 && <div className="menu-note">Label</div>}
            {categories.map((c) => <button key={c.name} onClick={() => act.category(c.name)}><span className="cat-dot" style={{ background: c.color }} /> {c.name}</button>)}
          </Dropdown>
        </>
      ) : <span className="tb-hint">Select a message for actions</span>}
      <div className="tb-spacer" />
      <Tool icon="refresh" label="Refresh" onClick={onRefresh} />
      <Dropdown icon="max" label="View options" right>
        <div className="menu-note">Reading pane</div>
        {[['right', 'Right'], ['bottom', 'Bottom'], ['off', 'Off']].map(([v, l]) => (
          <button key={v} onClick={() => setReadingPane(v)}><Icon name="check" style={{ opacity: readingPane === v ? 1 : 0 }} /> {l}</button>
        ))}
        <div className="menu-note">Density</div>
        {[['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([v, l]) => (
          <button key={v} onClick={() => setDensity(v)}><Icon name="check" style={{ opacity: density === v ? 1 : 0 }} /> {l}</button>
        ))}
      </Dropdown>
    </div>
  );
}
