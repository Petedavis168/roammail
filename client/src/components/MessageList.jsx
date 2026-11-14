import { useEffect, useRef } from 'react';
import { Icon } from '../icons.jsx';
import { fmtDate, dateGroup, personName, avatarColor, initials } from '../util.js';
import { fmtWhen } from '../snooze.js';
import NeedsReply from './NeedsReply.jsx';
import Nudges from './Nudges.jsx';
import { attachGestures, SWIPE_ACTIONS } from '../swipe.js';
import { t } from '../i18n.js';

export default function MessageList({ list, title, search, onClearSearch, folderUse, filter, setFilter, selected, setSelected,
  active, onOpen, act, categories, density, onLoadMore, onEmpty, onMarkAllRead, snoozeMap, allInboxes, isInbox, onBump, inboxTab, setInboxTab, onSwipe, swipe = {}, onRefresh, unreadInbox = 0, onCatchUp, onHover, team, meEmail }) {
  const ref = useRef();
  const hoverT = useRef();
  const { messages, loading, total } = list;
  const showTo = folderUse === '\\Sent' || folderUse === '\\Drafts';
  const catColor = (n) => categories.find((c) => c.name.replace(/[^A-Za-z0-9_-]/g, '') === n)?.color || '#888';

  // Phone gestures: swipe a row, pull down to refresh
  const live = useRef({});
  live.current = { messages, onSwipe, onRefresh };
  const label = (k) => { const a = SWIPE_ACTIONS.find((x) => x[0] === k); return a && a[0] !== 'none' ? t(a[1]) : null; };
  useEffect(() => {
    if (!ref.current || !onSwipe) return undefined;
    return attachGestures(ref.current, {
      getRow: (el) => live.current.messages.find((m) => String(m.uid) === el.dataset.uid),
      onSwipe: (m, side) => live.current.onSwipe(m, side),
      onRefresh: () => live.current.onRefresh?.(),
      labels: { left: label(swipe.left || 'archive'), right: label(swipe.right || 'read') },
    });
  }, [!!onSwipe, swipe.left, swipe.right]);

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
        <label className="chk" title={t("Select all")}>
          <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(messages.map((m) => m.uid)))} />
        </label>
        <h2 title={title}>{title}</h2>
        {search ? (
          <button className="link" onClick={onClearSearch}>{t("Clear")}</button>
        ) : allInboxes ? null : (
          <div className="filters">
            {[['', 'All'], ['unread', 'Unread'], ['flagged', 'Flagged'], ['attachments', 'Files']].map(([v, l]) => (
              <button key={v} className={`chip ${filter === v ? 'on' : ''}`} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
        )}
      </div>
      {inboxTab && (
        <div className="inbox-tabs" role="tablist" aria-label={t('Inbox tabs')}>
          {[['primary', 'inbox', 'Primary'], ['updates', 'bell', 'Updates'], ['newsletters', 'list', 'Newsletters']].map(([k, ic, l]) => (
            <button key={k} role="tab" aria-selected={inboxTab === k} className={inboxTab === k ? 'on' : ''} onClick={() => setInboxTab(k)}>
              <Icon name={ic} size={16} /> <span>{t(l)}</span>{list.tabs?.[k] > 0 && <b className="tab-count">{list.tabs[k] > 99 ? '99+' : list.tabs[k]}</b>}
            </button>
          ))}
        </div>
      )}
      {isInbox && onCatchUp && unreadInbox >= 15 && (
        <button className="catchup-banner" onClick={onCatchUp}><Icon name="spark" size={16} /><span><b>{unreadInbox} {t('unread')}</b> · {t('Catch up in a couple of minutes')}</span><Icon name="chevron" size={16} /></button>
      )}
      {isInbox && onBump && (!inboxTab || inboxTab === 'primary') && <Nudges onBump={onBump} />}
      {isInbox && (!inboxTab || inboxTab === 'primary') && <NeedsReply messages={messages} onOpen={onOpen} />}
      {selected.size > 0 && !allInboxes && (
        <div className="selbar">
          <b>{selected.size} selected</b>
          <button onClick={() => act.archive()}><Icon name="archive" size={16} />{' '}{t("Archive")}</button>
          <button onClick={() => act.del()}><Icon name="trash" size={16} />{' '}{t("Delete")}</button>
          <button onClick={() => act.read(true)}><Icon name="mailOpen" size={16} />{' '}{t("Read")}</button>
          <button onClick={() => act.read(false)}><Icon name="mail" size={16} />{' '}{t("Unread")}</button>
          <button onClick={() => setSelected(new Set())}>{t("Cancel")}</button>
        </div>
      )}
      {(folderUse === '\\Trash' || folderUse === '\\Junk') && messages.length > 0 && !search && (
        <div className="banner">{t("Items here can be removed permanently.")}{' '}<button className="link" onClick={onEmpty}>{t("Empty folder now")}</button></div>
      )}
      <div className="rows" ref={ref} onScroll={onScroll}>
        <div role="list" aria-label={t("Messages")}>
        {messages.map((m) => {
          const group = dateGroup(m.date);
          const header = group !== lastGroup ? <div className="group-head" role="listitem" key={`g-${group}-${m.uid}`}>{group}</div> : null;
          lastGroup = group;
          const who = showTo ? m.to : m.from;
          const person = who?.[0] || { name: '', address: '' };
          return [
            header,
            <div key={m.uid} data-uid={m.uid} role="listitem" aria-current={active === m.uid ? 'true' : undefined}
              className={`row ${m.seen ? '' : 'unread'} ${active === m.uid ? 'active' : ''} ${selected.has(m.uid) ? 'selected' : ''}`}
              onClick={(e) => onRowClick(m, e)} draggable={!allInboxes}
              onMouseEnter={onHover ? () => { clearTimeout(hoverT.current); hoverT.current = setTimeout(() => onHover(m), 120); } : undefined}
              onMouseLeave={onHover ? () => clearTimeout(hoverT.current) : undefined} onDragStart={(e) => onDragStart(m, e)}
              onContextMenu={allInboxes ? undefined : (e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('roammail:rowmenu', { detail: { m, x: e.clientX, y: e.clientY } })); }}>
              <div className="row-left" onClick={(e) => toggle(m.uid, e)}>
                {density === 'compact' ? null : (
                  <span className="avatar" style={{ background: avatarColor(person.address) }}>{initials(person)}</span>
                )}
                <input type="checkbox" checked={selected.has(m.uid)} readOnly tabIndex={-1} aria-label={t("Select")} />
              </div>
              <div className="row-main">
                <div className="row-top">
                  <span className="from">{showTo ? 'To: ' : ''}{who?.length ? who.map(personName).join(', ') : '(unknown)'}</span>
                  <span className="row-icons">
                    {(() => { const k = String(m.messageId || '').replace(/^<|>$/g, '').toLowerCase(); const a = team?.assign?.[k]; const n = team?.notes?.[k]; return <>
                      {a && <span className={`team-chip ${a.email === String(meEmail || '').toLowerCase() ? 'mine' : ''}`} title={`${t('Assigned to')} ${a.name}`}>→ {a.email === String(meEmail || '').toLowerCase() ? t('Me') : a.name}</span>}
                      {n > 0 && <span className="team-chip notes" title={t('Team notes')}>✎ {n}</span>}
                    </>; })()}
                    {m.hasAttachments && <Icon name="clip" size={14} />}
                    {m.answered && <Icon name="reply" size={14} />}
                  </span>
                  {snoozeMap?.[m.uid] ? <span className="date snoozed" title={t("Snoozed until")}><Icon name="clock" size={12} /> {fmtWhen(snoozeMap[m.uid].run_at)}</span>
                    : <span className="date">{fmtDate(m.date)}</span>}
                </div>
                <div className="row-sub">
                  {!m.seen && <span className="unread-dot" role="img" aria-label={t("Unread")} />}
                  <span className="subject">{m.draft && <span className="draft-tag">{t("[Draft]")}{' '}</span>}{m.subject}</span>
                  {density !== 'compact' && m.snippet && <span className="snippet"> — {m.snippet}</span>}
                  {m.categories?.map((c) => <span key={c} className="cat" style={{ '--c': catColor(c) }}>{c}</span>)}
                </div>
                {allInboxes && <div className="acct-tag">{m.account}</div>}
              </div>
              {!allInboxes && <><div className="row-actions" onClick={(e) => e.stopPropagation()}>
                {snoozeMap?.[m.uid] ? <button title={t("Unsnooze now")} onClick={() => act.unsnooze(m.uid)}><Icon name="inbox" size={16} /></button>
                  : <button title={t("Snooze")} onClick={() => act.snooze(m.uid)}><Icon name="clock" size={16} /></button>}
                <button title={t("Archive")} onClick={() => act.archive(m.uid)}><Icon name="archive" size={16} /></button>
                <button title={t("Delete")} onClick={() => act.del(m.uid)}><Icon name="trash" size={16} /></button>
                <button title={m.seen ? 'Mark unread' : 'Mark read'} onClick={() => act.read(!m.seen, m.uid)}><Icon name={m.seen ? 'mail' : 'mailOpen'} size={16} /></button>
              </div>
              <button className={`flag-btn ${m.flagged ? 'on' : ''}`} title={m.flagged ? 'Unflag' : 'Flag'} onClick={(e) => { e.stopPropagation(); act.flag(m.uid); }}>
                <Icon name="flag" size={16} fill={m.flagged ? 'currentColor' : 'none'} />
              </button></>}
            </div>,
          ];
        })}
        </div>
        {loading && messages.length === 0 && (
          <div aria-label="Loading" role="status">{[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skel-row"><span className="skel circle" /><div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}><span className="skel line" style={{ width: `${40 + (i * 13) % 30}%` }} /><span className="skel line" style={{ width: `${70 + (i * 7) % 25}%` }} /></div></div>
          ))}</div>
        )}
        {loading && messages.length > 0 && <div className="list-msg"><div className="spinner" /></div>}
        {!loading && messages.length === 0 && (
          <div className="empty">
            <Icon name={search ? 'search' : filter ? 'filter' : folderUse === '\\Junk' ? 'shield' : 'inbox'} size={40} />
            <b>{search ? 'No results' : filter ? 'Nothing matches this filter' : folderUse === '\\Inbox' ? "You're all caught up" : folderUse === '\\Junk' ? 'No junk' : folderUse === '\\Drafts' ? 'No drafts' : folderUse === '\\Sent' ? 'Nothing sent yet' : 'This folder is empty'}</b>
            <p className="muted">{search ? 'Try fewer words, or a search tip like from: or has:attachment.' : filter ? 'Switch back to All to see everything.' : folderUse === '\\Inbox' ? 'New mail will show up here.' : folderUse === '\\Junk' ? 'Suspected spam lands here, so your inbox stays clean.' : ''}</p>
            {filter && !search && <button className="btn sm" onClick={() => setFilter('')}>{t("Show all")}</button>}
          </div>
        )}
        {!loading && !search && messages.length > 0 && messages.length >= total && <div className="list-msg muted">{total} message{total === 1 ? '' : 's'}</div>}
        {!loading && !search && folderUse === '\\Inbox' && messages.some((m) => !m.seen) && (
          <div className="list-msg"><button className="link" onClick={onMarkAllRead}>{t("Mark all as read")}</button></div>
        )}
      </div>
    </section>
  );
}
