import { t } from '../i18n.js';
import { useDialog } from '../a11y.js';
const KEYS = [
  ['c / n / Ctrl+N', 'New message'], ['/', 'Search'], ['j / ↓', 'Next message'], ['k / ↑', 'Previous message'],
  ['Enter / o', 'Open'], ['u / Esc', 'Back to list'], ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'],
  ['e', 'Archive'], ['# / Delete', 'Delete'], ['!', 'Report junk'], ['s', 'Flag / star'], ['x', 'Select'],
  ['Shift+I / q', 'Mark read'], ['Shift+U', 'Mark unread'], ['Ctrl+Enter', 'Send (in compose)'], ['?', 'This help'],
];
export default function ShortcutsHelp({ onClose }) {
  const dlg = useDialog(onClose);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div ref={dlg} data-dialog tabIndex={-1} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t("Keyboard shortcuts")}</h2>
        <div className="keys">{KEYS.map(([k, d]) => <div key={k}><kbd>{k}</kbd><span>{d}</span></div>)}</div>
        <h3>{t("Search operators")}</h3>
        <p className="muted small">{t("from:anna · to:bob · subject:invoice · has:attachment · is:unread · is:starred · newer_than:7d · older_than:1y · before:2026-01-01 · after:2025-06-01 · larger:5M · label:Red · in:sent · -word")}</p>
        <button className="btn primary" onClick={onClose}>{t("Got it")}</button>
      </div>
    </div>
  );
}
