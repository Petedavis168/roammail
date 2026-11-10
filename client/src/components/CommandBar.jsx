// Command bar (Ctrl+K / ⌘K): type to jump anywhere — folders, Calendar, Contacts, Subscriptions, any settings page,
// write a new email, or search your mail. Arrow keys to move, Enter to go, Esc to close.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons.jsx';
import { t } from '../i18n.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Simple fuzzy match: every typed word appears in the label or its keywords; earlier hits rank higher. */
function score(item, q) {
  if (!q) return 1;
  const hay = norm(`${item.label} ${item.keywords || ''}`);
  let s = 0;
  for (const w of norm(q).split(/\s+/).filter(Boolean)) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += i === 0 ? 3 : hay[i - 1] === ' ' ? 2 : 1;
  }
  return s;
}

export default function CommandBar({ onClose, folders, actions, settingsTabs }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); }, []);

  const items = useMemo(() => {
    const base = [
      { group: 'Actions', label: t('New email'), icon: 'pen', keywords: 'compose write send new mail', run: actions.compose },
      { group: 'Go to', label: t('Inbox'), icon: 'inbox', keywords: 'mail', run: () => actions.folder('INBOX') },
      ...folders.filter((f) => f.path !== 'INBOX').map((f) => ({ group: 'Go to', label: f.label || f.name || f.path, icon: 'folder', keywords: `folder ${f.specialUse || ''}`, run: () => actions.folder(f.path) })),
      { group: 'Go to', label: t('Scheduled'), icon: 'clock', keywords: 'send later', run: () => actions.folder('@scheduled') },
      { group: 'Go to', label: t('Subscriptions'), icon: 'list', keywords: 'newsletters unsubscribe mailing lists', run: () => actions.folder('@subscriptions') },
      { group: 'Go to', label: t('Aliases'), icon: 'shield', keywords: 'hide my email alias', run: () => actions.folder('@aliases') },
      { group: 'Go to', label: t('Calendar'), icon: 'calendar', keywords: 'events meetings', run: () => actions.view('calendar') },
      { group: 'Go to', label: t('Contacts'), icon: 'users', keywords: 'people address book', run: () => actions.view('contacts') },
      ...settingsTabs.map(([id, label, icon]) => ({ group: 'Settings', label: `${t('Settings')}: ${t(label)}`, icon, keywords: `${id} preferences options`, run: () => actions.settings(id) })),
      { group: 'Actions', label: t('Switch light / dark mode'), icon: 'moon', keywords: 'theme dark light', run: actions.toggleTheme },
      { group: 'Actions', label: t('Keyboard shortcuts'), icon: 'key', keywords: 'help keys', run: actions.shortcuts },
    ];
    const list = base.map((it) => ({ ...it, s: score(it, q) })).filter((it) => it.s > 0).sort((a, b) => b.s - a.s).slice(0, 12);
    if (q.trim()) list.push({ group: 'Search', label: `${t('Search mail for')} “${q.trim()}”`, icon: 'search', run: () => actions.search(q.trim()) });
    return list;
  }, [q, folders, actions, settingsTabs]);

  useEffect(() => { setI(0); }, [q]);
  const go = (it) => { onClose(); setTimeout(() => it?.run?.(), 0); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[i]); }
  };

  let lastGroup = '';
  return (
    <div className="cmd-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label={t('Command bar')}>
      <div className="cmd">
        <div className="cmd-input"><Icon name="search" size={18} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('Type a command, folder, setting or search…')} aria-label={t('Command')} role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={`cmd-${i}`} />
          <kbd>Esc</kbd>
        </div>
        <div className="cmd-list" id="cmd-list" role="listbox">
          {items.map((it, n) => {
            const head = it.group !== lastGroup ? <div className="cmd-group" key={`g${n}`}>{t(it.group)}</div> : null;
            lastGroup = it.group;
            return [head, (
              <button key={n} id={`cmd-${n}`} role="option" aria-selected={n === i} className={`cmd-item ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={() => go(it)}>
                <Icon name={it.icon} size={16} /><span>{it.label}</span>{n === i && <small>↵</small>}
              </button>
            )];
          })}
          {!items.length && <div className="cmd-empty">{t('Nothing found')}</div>}
        </div>
      </div>
    </div>
  );
}
