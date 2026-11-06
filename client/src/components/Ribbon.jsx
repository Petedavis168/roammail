import { useState } from 'react';
import { Icon } from '../icons.jsx';
import { folderIcon, folderLabel } from '../util.js';

function Dropdown({ label, icon, disabled, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dd" onMouseLeave={() => setOpen(false)}>
      <button className="rb" disabled={disabled} onClick={() => setOpen((o) => !o)}><Icon name={icon} /> <span>{label}</span> <Icon name="down" size={12} /></button>
      {open && <div className="menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

export default function Ribbon({ hasSelection, folderUse, folders, onCompose, act, categories, onReply, canReply, onRefresh, readingPane, setReadingPane }) {
  const sel = !hasSelection;
  return (
    <div className="ribbon" role="toolbar" aria-label="Message actions">
      <button className="rb primary" onClick={onCompose}><Icon name="pen" /> <span>New mail</span></button>
      <span className="rb-sep" />
      <button className="rb" disabled={sel} onClick={() => act.del()} title="Delete (#)"><Icon name="trash" /> <span>Delete</span></button>
      <button className="rb" disabled={sel || folderUse === '\\Archive'} onClick={() => act.archive()} title="Archive (e)"><Icon name="archive" /> <span>Archive</span></button>
      {folderUse === '\\Junk'
        ? <button className="rb" disabled={sel} onClick={() => act.notJunk()}><Icon name="inbox" /> <span>Not junk</span></button>
        : <button className="rb" disabled={sel} onClick={() => act.junk()} title="Report junk (!)"><Icon name="junk" /> <span>Junk</span></button>}
      <button className="rb" disabled={sel} onClick={() => act.snooze()} title="Snooze (b)"><Icon name="clock" /> <span>Snooze</span></button>
      <Dropdown label="Move to" icon="move" disabled={sel}>
        {folders.filter((f) => !f.flags.includes('\\Noselect')).map((f) => (
          <button key={f.path} onClick={() => act.move(f.path)}><Icon name={folderIcon(f)} /> {folderLabel(f)}</button>
        ))}
      </Dropdown>
      <span className="rb-sep" />
      <button className="rb" disabled={!canReply} onClick={() => onReply('reply')} title="Reply (r)"><Icon name="reply" /> <span>Reply</span></button>
      <button className="rb" disabled={!canReply} onClick={() => onReply('all')} title="Reply all (a)"><Icon name="replyAll" /> <span>Reply all</span></button>
      <button className="rb" disabled={!canReply} onClick={() => onReply('forward')} title="Forward (f)"><Icon name="forward" /> <span>Forward</span></button>
      <span className="rb-sep" />
      <button className="rb" disabled={sel} onClick={() => act.read(true)} title="Mark as read (Shift+I)"><Icon name="mailOpen" /> <span>Read</span></button>
      <button className="rb" disabled={sel} onClick={() => act.read(false)} title="Mark as unread (Shift+U)"><Icon name="mail" /> <span>Unread</span></button>
      <button className="rb" disabled={sel} onClick={() => act.flag()} title="Flag / star (s)"><Icon name="flag" /> <span>Flag</span></button>
      <Dropdown label="Categorize" icon="tag" disabled={sel}>
        {categories.map((c) => <button key={c.name} onClick={() => act.category(c.name)}><span className="cat-dot" style={{ background: c.color }} /> {c.name}</button>)}
      </Dropdown>
      <div className="rb-spacer" />
      <button className="rb" onClick={onRefresh} title="Refresh"><Icon name="refresh" /></button>
      <Dropdown label="View" icon="max">
        {[['right', 'Reading pane on right'], ['bottom', 'Reading pane on bottom'], ['off', 'Hide reading pane']].map(([v, l]) => (
          <button key={v} onClick={() => setReadingPane(v)}>{readingPane === v ? <Icon name="check" /> : <Icon name="check" style={{ opacity: 0 }} />} {l}</button>
        ))}
      </Dropdown>
    </div>
  );
}
