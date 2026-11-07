import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { folderIcon, folderLabel, SPECIAL_ORDER } from '../util.js';
import { useToast } from './Toast.jsx';

export default function Sidebar({ folders, current, onSelect, onCompose, reload, onDropMessages, categories, onCategory, onScheduled, onQuarantine, qCount, me, mailboxes = [], mailbox = '', onMailbox }) {
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(() => JSON.parse(localStorage.getItem('collapsed') || '{}'));
  const [dragOver, setDragOver] = useState(null);
  const [menu, setMenu] = useState(null);

  const { specials, tree, snoozedFolder } = useMemo(() => {
    const specials = SPECIAL_ORDER.map((u) => folders.find((f) => f.specialUse === u)).filter(Boolean);
    const others = folders.filter((f) => !specials.includes(f) && f.path.toLowerCase() !== 'snoozed');
    const byParent = new Map();
    for (const f of others) {
      const key = f.parent && others.some((o) => o.path === f.parent) ? f.parent : '';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(f);
    }
    for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return { specials, tree: byParent, snoozedFolder: folders.find((f) => f.path.toLowerCase() === 'snoozed') };
  }, [folders]);

  const toggle = (p) => setCollapsed((c) => { const n = { ...c, [p]: p === '@labels' ? c[p] !== false ? false : true : !c[p] }; localStorage.setItem('collapsed', JSON.stringify(n)); return n; });

  const createFolder = async (parent) => {
    const name = prompt(parent ? `New subfolder in "${parent.name}"` : 'New folder name');
    if (!name?.trim()) return;
    try {
      await api.post('/api/folders', { path: parent ? `${parent.path}${parent.delimiter || '/'}${name.trim()}` : name.trim() });
      reload();
    } catch (e) { toast(e.message, { error: true }); }
  };
  const rename = async (f) => {
    const name = prompt('Rename folder', f.name);
    if (!name?.trim() || name === f.name) return;
    const newPath = f.parent ? `${f.parent}${f.delimiter || '/'}${name.trim()}` : name.trim();
    try { await api.patch('/api/folders', { path: f.path, newPath }); reload(); } catch (e) { toast(e.message, { error: true }); }
  };
  const remove = async (f) => {
    if (!confirm(`Delete folder "${f.name}" and everything in it?`)) return;
    try { await api.del('/api/folders', { path: f.path }); reload(); if (current === f.path) onSelect('INBOX'); } catch (e) { toast(e.message, { error: true }); }
  };

  const dropProps = (f) => ({
    onDragOver: (e) => { if (e.dataTransfer.types.includes('application/x-mail-uids')) { e.preventDefault(); setDragOver(f.path); } },
    onDragLeave: () => setDragOver(null),
    onDrop: (e) => {
      e.preventDefault(); setDragOver(null);
      const data = JSON.parse(e.dataTransfer.getData('application/x-mail-uids') || '{}');
      if (data.folder !== f.path && data.uids?.length) onDropMessages(f.path, data.uids);
    },
  });

  const Row = ({ f, depth = 0 }) => {
    const kids = tree.get(f.path) || [];
    const unread = f.specialUse === '\\Drafts' ? f.total : f.unread;
    return (
      <>
        <div className={`folder ${current === f.path ? 'on' : ''} ${dragOver === f.path ? 'drop' : ''}`} style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => !f.flags.includes('\\Noselect') && onSelect(f.path)} {...dropProps(f)}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ f, x: e.clientX, y: e.clientY }); }}
          role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(f.path)}>
          {kids.length ? (
            <span className="twisty" onClick={(e) => { e.stopPropagation(); toggle(f.path); }}><Icon name={collapsed[f.path] ? 'chevron' : 'down'} size={12} /></span>
          ) : <span className="twisty" />}
          <Icon name={folderIcon(f)} />
          <span className="fname">{folderLabel(f)}</span>
          {unread > 0 && <span className={`count ${f.specialUse === '\\Drafts' ? 'muted' : ''}`}>{unread}</span>}
        </div>
        {!collapsed[f.path] && kids.map((k) => <Row key={k.path} f={k} depth={depth + 1} />)}
      </>
    );
  };

  return (
    <nav className="sidebar" onClick={() => setMenu(null)}>
      <button className="compose-btn" onClick={onCompose}><Icon name="pen" /> New mail</button>
      {(mailboxes.length > 0 || (me?.accounts || []).length > 1) && (
        <label className="mailbox-pick" title="Switch between your accounts and shared mailboxes">
          <Icon name="users" size={14} />
          <select value={mailbox} onChange={(e) => onMailbox(e.target.value)} aria-label="Mailbox">
            {(me?.accounts || []).map((a) => <option key={a.mailboxId} value={a.mailboxId}>{a.email}</option>)}
            {mailboxes.map((b) => <option key={b.mailboxId} value={b.mailboxId}>{b.name ? `${b.name} (${b.email})` : b.email}{b.archive ? ' (archive, read only)' : b.canSend ? '' : ' (read only)'}</option>)}
          </select>
        </label>
      )}
      <div className="nav-section">
        {specials.map((f) => <Row key={f.path} f={f} />)}
        <div className={`folder ${current === '@scheduled' ? 'on' : ''}`} style={{ paddingLeft: 10 }} onClick={onScheduled} role="button" tabIndex={0}>
          <span className="twisty" /><Icon name="clock" /><span className="fname">Scheduled</span>
        </div>
        {snoozedFolder && <Row f={snoozedFolder} />}
        {!specials.some((f) => f.specialUse === '\\Junk') && (
          <div className={`folder ${current === '@quarantine' ? 'on' : ''}`} style={{ paddingLeft: 10 }} onClick={onQuarantine} role="button" tabIndex={0}>
            <span className="twisty" /><Icon name="shield" /><span className="fname">Quarantine</span>{qCount > 0 && <span className="count muted">{qCount}</span>}
          </div>
        )}
      </div>
      {(tree.get('') || []).length > 0 && <div className="nav-title">Folders</div>}
      <div className="nav-section">
        {(tree.get('') || []).map((f) => <Row key={f.path} f={f} />)}
        <div className="folder add-row" style={{ paddingLeft: 10 }} onClick={() => createFolder(null)} role="button" tabIndex={0}>
          <span className="twisty" /><Icon name="plus" /><span className="fname">New folder</span>
        </div>
      </div>
      <button className="nav-title toggle" onClick={() => toggle('@labels')} aria-expanded={collapsed['@labels'] === false}>
        <span>Labels</span><Icon name={collapsed['@labels'] === false ? 'down' : 'chevron'} size={12} />
      </button>
      {collapsed['@labels'] === false && (
        <div className="nav-section">
          {categories.map((c) => (
            <div key={c.name} className="folder" onClick={() => onCategory(c)} role="button" tabIndex={0}>
              <span className="twisty" /><span className="cat-dot" style={{ background: c.color }} /><span className="fname">{c.name}</span>
            </div>
          ))}
        </div>
      )}
      {menu && (
        <div className="menu" style={{ position: 'fixed', left: menu.x, top: menu.y }}>
          <button onClick={() => createFolder(menu.f)}><Icon name="plus" /> New subfolder</button>
          {!menu.f.specialUse && <button onClick={() => rename(menu.f)}><Icon name="pen" /> Rename</button>}
          {!menu.f.specialUse && <button onClick={() => remove(menu.f)}><Icon name="trash" /> Delete folder</button>}
        </div>
      )}
    </nav>
  );
}
