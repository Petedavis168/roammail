import { useEffect, useRef } from 'react';
import { Icon } from '../icons.jsx';
import { fmtDate, dateGroup, personName, avatarColor, initials } from '../util.js';
import { fmtWhen } from '../snooze.js';

export default function MessageList({ list, title, search, onClearSearch, folderUse, filter, setFilter, selected, setSelected,
  active, onOpen, act, categories, density, onLoadMore, onEmpty, onMarkAllRead, snoozeMap, allInboxes }) {
  const ref = useRef();
  const { messages, loading, total } = list;
  const showTo = folderUse === '\\Sent' || folderUse === '\\Drafts';
  const catColor = (n) => categories.find((c) => c.name.replace(/[^A-Za-z0-9_-]/g, '') === n)?.color || '#888';

  useEffect(() => {
    const el = ref.current?.querySelector('.row.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) onLoadMore();
  };

  const toggle = (uid, e) => {
    e.stopPropagation();
    setSelected((s) => {
      const n = new Set(s);
      if (e.shiftKey && s.size) {
        const last = [...s].pop();
        const a = messages.findIndex((m) => m.uid === last);
        const b = messages.findIndex((m) => m.uid === uid);
        for (const m of messages.slice(Math.min(a, b), Math.max(a, b) + 1)) n.add(m.uid);
      } else if (n.has(uid)) n.delete(uid); else n.add(uid);
      return n;
    });
  };
  const allSelected = messages.length > 0 && selected.size === messages.length;

  const onRowClick = (m, e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return toggle(m.uid, e);
    onOpen(m);
  };

  const onDragStart = (m, e) => {
    const uids = selected.has(m.uid) ? [...selected] : [m.uid];
    e.dataTransfer.setData('application/x-mail-uids', JSON.stringify({ folder: list.folder, uids }));
    e.dataTransfer.effectAllowed = 'move';
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = uids.length > 1 ? `${uids.length} messages` : m.subject;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove(), 0);
  };

  let lastGroup = null;
  return (
    <section className="list">
      <div className="list-head">
        <label className="chk" title="Select all">
          <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(messages.map((m) => m.uid)))} />
        </label>
        <h2 title={title}>{title}</h2>
        {search ? (
          <button className="link" onClick={onClearSearch}>Clear</button>
        ) : allInboxes ? null : (
          <div className="filters">
            {[['', 'All'], ['unread', 'Unread'], ['flagged', 'Flagged'], ['attachments', 'Files']].map(([v, l]) => (
              <button key={v} className={`chip ${filter === v ? 'on' : ''}`} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
        )}
      </div>
      {selected.size > 0 && !allInboxes && (
        <div className="selbar">
          <b>{selected.size} selected</b>
          <button onClick={() => act.archive()}><Icon name="archive" size={16} /> Archive</button>
          <button onClick={() => act.del()}><Icon name="trash" size={16} /> Delete</button>
          <button onClick={() => act.read(true)}><Icon name="mailOpen" size={16} /> Read</button>
          <button onClick={() => act.read(false)}><Icon name="mail" size={16} /> Unread</button>
          <button onClick={() => setSelected(new Set())}>Cancel</button>
        </div>
      )}
      {(folderUse === '\\Trash' || folderUse === '\\Junk') && messages.length > 0 && !search && (
        <div className="banner">Items here can be removed permanently. <button className="link" onClick={onEmpty}>Empty folder now</button></div>
      )}
      <div className="rows" ref={ref} onScroll={onScroll}>
        <div role="list" aria-label="Messages">
        {messages.map((m) => {
          const group = dateGroup(m.date);
          const header = group !== lastGroup ? <div className="group-head" role="listitem" key={`g-${group}-${m.uid}`}>{group}</div> : null;
          lastGroup = group;
          const who = showTo ? m.to : m.from;
          const person = who?.[0] || { name: '', address: '' };
          return [
            header,
            <div key={m.uid} role="listitem" aria-current={active === m.uid ? 'true' : undefined}
              className={`row ${m.seen ? '' : 'unread'} ${active === m.uid ? 'active' : ''} ${selected.has(m.uid) ? 'selected' : ''}`}
              onClick={(e) => onRowClick(m, e)} draggable={!allInboxes} onDragStart={(e) => onDragStart(m, e)}>
              <div className="row-left" onClick={(e) => toggle(m.uid, e)}>
                {density === 'compact' ? null : (
                  <span className="avatar" style={{ background: avatarColor(person.address) }}>{initials(person)}</span>
                )}
                <input type="checkbox" checked={selected.has(m.uid)} readOnly tabIndex={-1} aria-label="Select" />
              </div>
              <div className="row-main">
                <div className="row-top">
                  <span className="from">{showTo ? 'To: ' : ''}{who?.length ? who.map(personName).join(', ') : '(unknown)'}</span>
                  <span className="row-icons">
                    {m.hasAttachments && <Icon name="clip" size={14} />}
                    {m.answered && <Icon name="reply" size={14} />}
                  </span>
                  {snoozeMap?.[m.uid] ? <span className="date snoozed" title="Snoozed until"><Icon name="clock" size={12} /> {fmtWhen(snoozeMap[m.uid].run_at)}</span>
                    : <span className="date">{fmtDate(m.date)}</span>}
                </div>
                <div className="row-sub">
                  {!m.seen && <span className="unread-dot" role="img" aria-label="Unread" />}
                  <span className="subject">{m.draft && <span className="draft-tag">[Draft] </span>}{m.subject}</span>
                  {density !== 'compact' && m.snippet && <span className="snippet"> — {m.snippet}</span>}
                  {m.categories?.map((c) => <span key={c} className="cat" style={{ '--c': catColor(c) }}>{c}</span>)}
                </div>
                {allInboxes && <div className="acct-tag">{m.account}</div>}
              </div>
              {!allInboxes && <><div className="row-actions" onClick={(e) => e.stopPropagation()}>
                {snoozeMap?.[m.uid] ? <button title="Unsnooze now" onClick={() => act.unsnooze(m.uid)}><Icon name="inbox" size={16} /></button>
                  : <button title="Snooze" onClick={() => act.snooze(m.uid)}><Icon name="clock" size={16} /></button>}
                <button title="Archive" onClick={() => act.archive(m.uid)}><Icon name="archive" size={16} /></button>
                <button title="Delete" onClick={() => act.del(m.uid)}><Icon name="trash" size={16} /></button>
                <button title={m.seen ? 'Mark unread' : 'Mark read'} onClick={() => act.read(!m.seen, m.uid)}><Icon name={m.seen ? 'mail' : 'mailOpen'} size={16} /></button>
              </div>
              <button className={`flag-btn ${m.flagged ? 'on' : ''}`} title={m.flagged ? 'Unflag' : 'Flag'} onClick={(e) => { e.stopPropagation(); act.flag(m.uid); }}>
                <Icon name="flag" size={16} fill={m.flagged ? 'currentColor' : 'none'} />
              </button></>}
            </div>,
          ];
        })}
        </div>
        {loading && <div className="list-msg"><div className="spinner" /></div>}
        {!loading && messages.length === 0 && (
          <div className="empty">
            <Icon name={search ? 'search' : filter ? 'filter' : folderUse === '\\Junk' ? 'shield' : 'inbox'} size={40} />
            <b>{search ? 'No results' : filter ? 'Nothing matches this filter' : folderUse === '\\Inbox' ? "You're all caught up" : folderUse === '\\Junk' ? 'No junk' : folderUse === '\\Drafts' ? 'No drafts' : folderUse === '\\Sent' ? 'Nothing sent yet' : 'This folder is empty'}</b>
            <p className="muted">{search ? 'Try fewer words, or a search tip like from: or has:attachment.' : filter ? 'Switch back to All to see everything.' : folderUse === '\\Inbox' ? 'New mail will show up here.' : folderUse === '\\Junk' ? 'Suspected spam lands here, so your inbox stays clean.' : ''}</p>
            {filter && !search && <button className="btn sm" onClick={() => setFilter('')}>Show all</button>}
          </div>
        )}
        {!loading && !search && messages.length > 0 && messages.length >= total && <div className="list-msg muted">{total} message{total === 1 ? '' : 's'}</div>}
        {!loading && !search && folderUse === '\\Inbox' && messages.some((m) => !m.seen) && (
          <div className="list-msg"><button className="link" onClick={onMarkAllRead}>Mark all as read</button></div>
        )}
      </div>
    </section>
  );
}
