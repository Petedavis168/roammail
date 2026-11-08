import { useState } from 'react';
import { Icon } from '../icons.jsx';
import { folderIcon, folderLabel } from '../util.js';
import { t } from '../i18n.js';

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
    <div className="toolbar" role="toolbar" aria-label={t("Message actions")}>
      {hasSelection ? (
        <>
          {count > 1 && <span className="tb-count">{count} selected</span>}
          {folderUse !== '\\Archive' && <Tool icon="archive" label={t("Archive (e)")} onClick={() => act.archive()} />}
          <Tool icon="trash" label={t("Delete (#)")} onClick={() => act.del()} />
          <Tool icon="clock" label={t("Snooze (b)")} onClick={() => act.snooze()} />
          <Dropdown icon="move" label={t("Move to")}>
            {folders.filter((f) => !f.flags.includes('\\Noselect')).map((f) => (
              <button key={f.path} onClick={() => act.move(f.path)}><Icon name={folderIcon(f)} /> {folderLabel(f)}</button>
            ))}
          </Dropdown>
          <Tool icon="flag" label={t("Flag (s)")} onClick={() => act.flag()} />
          <Dropdown icon="more" label={t("More actions")}>
            {folderUse === '\\Junk'
              ? <button onClick={() => act.notJunk()}><Icon name="inbox" />{' '}{t("Not junk")}</button>
              : <button onClick={() => act.junk()}><Icon name="junk" />{' '}{t("Report junk (!)")}</button>}
            <button onClick={() => act.read(true)}><Icon name="mailOpen" />{' '}{t("Mark as read")}</button>
            <button onClick={() => act.read(false)}><Icon name="mail" />{' '}{t("Mark as unread")}</button>
            {categories.length > 0 && <div className="menu-note">{t("Label")}</div>}
            {categories.map((c) => <button key={c.name} onClick={() => act.category(c.name)}><span className="cat-dot" style={{ background: c.color }} /> {c.name}</button>)}
          </Dropdown>
        </>
      ) : <span className="tb-hint">{t("Select a message for actions")}</span>}
      <div className="tb-spacer" />
      <Tool icon="refresh" label={t("Refresh")} onClick={onRefresh} />
      <Dropdown icon="max" label={t("View options")} right>
        <div className="menu-note">{t("Reading pane")}</div>
        {[['right', 'Right'], ['bottom', 'Bottom'], ['off', 'Off']].map(([v, l]) => (
          <button key={v} onClick={() => setReadingPane(v)}><Icon name="check" style={{ opacity: readingPane === v ? 1 : 0 }} /> {l}</button>
        ))}
        <div className="menu-note">{t("Density")}</div>
        {[['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([v, l]) => (
          <button key={v} onClick={() => setDensity(v)}><Icon name="check" style={{ opacity: density === v ? 1 : 0 }} /> {l}</button>
        ))}
      </Dropdown>
    </div>
  );
}
