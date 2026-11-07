import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setMailbox, mailUrl } from '../api.js';
import { Icon } from '../icons.jsx';
import { usePrefs, catKeyword } from '../prefs.js';
import { useToast } from './Toast.jsx';
import Sidebar from './Sidebar.jsx';
import MessageList from './MessageList.jsx';
import ReadingPane from './ReadingPane.jsx';
import Ribbon from './Ribbon.jsx';
import ComposeManager, { replyDraft } from './Compose.jsx';
import SettingsPanel from './Settings.jsx';
import ShortcutsHelp from './ShortcutsHelp.jsx';
const Admin = lazy(() => import('./admin/Admin.jsx'));
import { initials, avatarColor, folderLabel } from '../util.js';
import { useSignatures } from '../signatures.js';
import { fmtWhen } from '../snooze.js';
import ScheduledList from './ScheduledList.jsx';
import SnoozeMenu from './SnoozeMenu.jsx';
import QuarantineList from './QuarantineList.jsx';
const Calendar = lazy(() => import('./calendar/Calendar.jsx'));
const Contacts = lazy(() => import('./contacts/Contacts.jsx'));

export default function Mail({ me, refreshMe, theme, setTheme, onLogout }) {
  const toast = useToast();
  const [prefs, setPrefs] = usePrefs(me.email);
  const [view, setView] = useState(() => {
    // Business sign-ups continue straight into domain setup
    if (localStorage.getItem('startBusiness')) { localStorage.removeItem('startBusiness'); return 'admin'; }
    return 'mail';
  });
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState('INBOX');
  const [mailbox, setMailboxState] = useState('');
  const [sharedBoxes, setSharedBoxes] = useState([]);
  useEffect(() => { api.get('/api/shared-mailboxes').then(setSharedBoxes).catch(() => {}); }, []);
  const switchMailbox = (m) => { setMailbox(m); setMailboxState(m); setFolder('INBOX'); };
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState(null); // active query string
  const [searchInput, setSearchInput] = useState('');
  const [list, setList] = useState({ messages: [], total: 0, page: 0, loading: true, folder: 'INBOX' });
  const [selected, setSelected] = useState(new Set());
  const [active, setActive] = useState(null); // uid
  const [composers, setComposers] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth > 900);
  const [userMenu, setUserMenu] = useState(false);
  const searchRef = useRef();
  const goPending = useRef(0);
  const [sigData, reloadSigs] = useSignatures();
  const [snoozeMap, setSnoozeMap] = useState({});
  const [snoozeFor, setSnoozeFor] = useState(null); // uids awaiting a snooze time
  const [qCount, setQCount] = useState(0);
  useEffect(() => { api.get('/api/spam').then((r) => setQCount(r.quarantineCount)).catch(() => {}); }, []);
  const reqId = useRef(0);

  const isAdmin = me.superAdmin || me.orgs?.some((o) => o.role === 'admin');
  const inOrg = me.orgs?.length > 0;
  const listFolder = list.folder;
  const msgs = list.messages;
  const activeMsg = msgs.find((m) => m.uid === active) || null;
  const special = (use) => folders.find((f) => f.specialUse === use)?.path;
  const currentFolderObj = folders.find((f) => f.path === folder);

  // ---------- loading ----------
  const loadFolders = useCallback(() => api.folders().then(setFolders).catch(() => {}), []);

  const load = useCallback(async ({ page = 0, append = false, quiet = false } = {}) => {
    const id = ++reqId.current;
    if (!quiet) setList((l) => ({ ...l, loading: true, ...(append ? {} : { messages: page ? l.messages : [] }) }));
    try {
      const r = search ? await api.search(search, folder) : await api.messages(folder, page, filter);
      if (id !== reqId.current) return;
      setList((l) => ({
        messages: append ? [...l.messages, ...r.messages.filter((m) => !l.messages.some((x) => x.uid === m.uid))] : r.messages,
        total: r.total, page, loading: false, folder: r.folder || folder,
      }));
    } catch (e) {
      if (id !== reqId.current) return;
      setList((l) => ({ ...l, loading: false }));
      toast(e.message, { error: true });
    }
  }, [folder, filter, search, toast]);

  useEffect(() => { loadFolders(); }, [loadFolders, mailbox]);
  useEffect(() => { setSelected(new Set()); setActive(null); if (!folder.startsWith('@')) load(); }, [load]);
  const loadSnoozed = useCallback(() => api.get('/api/snoozed').then((jobs) => {
    const m = {};
    for (const j of jobs) for (const u of j.summary.uids || []) m[u] = j;
    setSnoozeMap(m);
  }).catch(() => {}), []);
  useEffect(() => { if (folder.toLowerCase() === 'snoozed') loadSnoozed(); }, [folder, list.messages.length, loadSnoozed]);

  // ---------- live updates ----------
  const loadRef = useRef(load);
  loadRef.current = load;
  const folderRef = useRef(folder);
  folderRef.current = folder;
  useEffect(() => {
    let es; let retry;
    const connect = () => {
      es = new EventSource(mailUrl('/api/events'));
      es.addEventListener('new', (e) => {
        const d = JSON.parse(e.data);
        loadFolders();
        if (folderRef.current === 'INBOX') loadRef.current({ quiet: true });
        const m = d.messages?.[0];
        if (m && prefs.notifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(m.from?.[0]?.name || m.from?.[0]?.address || 'New mail', { body: m.subject || '', icon: '/favicon.svg' });
        }
      });
      es.addEventListener('changed', () => { loadFolders(); if (folderRef.current === 'INBOX') loadRef.current({ quiet: true }); });
      es.onerror = () => { es.close(); retry = setTimeout(connect, 15000); };
    };
    connect();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    return () => { es?.close(); clearTimeout(retry); };
  }, [loadFolders, prefs.notifications, mailbox]);

  // Page title with unread count
  useEffect(() => {
    const inbox = folders.find((f) => f.specialUse === '\\Inbox');
    document.title = `${inbox?.unread ? `(${inbox.unread}) ` : ''}${view === 'admin' ? 'Admin' : folder === '@scheduled' ? 'Scheduled' : folder === '@quarantine' ? 'Spam quarantine' : folderLabel(currentFolderObj || { name: 'Inbox' })} - ${me.email}`;
  }, [folders, currentFolderObj, me.email, view]);

  // ---------- helpers ----------
  const targetUids = useCallback((uid) => (Array.isArray(uid) ? uid : uid ? [uid] : selected.size ? [...selected] : active ? [active] : []), [selected, active]);
  const patchMsgs = (uids, fn) => setList((l) => ({ ...l, messages: l.messages.map((m) => (uids.includes(m.uid) ? { ...m, ...fn(m) } : m)) }));
  const dropMsgs = (uids) => {
    setList((l) => {
      const idx = l.messages.findIndex((m) => m.uid === active);
      const rest = l.messages.filter((m) => !uids.includes(m.uid));
      if (active && uids.includes(active)) {
        // Outlook/Gmail: move to the next (older) message after removing the open one
        const next = rest[Math.min(idx, rest.length - 1)];
        setActive(prefs.readingPane !== 'off' && next ? next.uid : null);
      }
      return { ...l, messages: rest, total: Math.max(0, l.total - uids.length) };
    });
    setSelected(new Set());
  };

  const act = {
    async read(seen, uid) {
      const uids = targetUids(uid); if (!uids.length) return;
      patchMsgs(uids, () => ({ seen }));
      await api.flags(listFolder, uids, seen ? ['\\Seen'] : [], seen ? [] : ['\\Seen']).catch((e) => toast(e.message, { error: true }));
      loadFolders();
    },
    async flag(uid) {
      const uids = targetUids(uid); if (!uids.length) return;
      const on = !msgs.find((m) => m.uid === uids[0])?.flagged;
      patchMsgs(uids, () => ({ flagged: on }));
      await api.flags(listFolder, uids, on ? ['\\Flagged'] : [], on ? [] : ['\\Flagged']).catch((e) => toast(e.message, { error: true }));
    },
    async category(name, uid) {
      const uids = targetUids(uid); if (!uids.length) return;
      const on = !msgs.find((m) => m.uid === uids[0])?.categories?.includes(catKeyword(name).slice(4));
      const kw = catKeyword(name);
      patchMsgs(uids, (m) => ({ categories: on ? [...new Set([...(m.categories || []), kw.slice(4)])] : (m.categories || []).filter((c) => c !== kw.slice(4)) }));
      await api.flags(listFolder, uids, on ? [kw] : [], on ? [] : [kw]).catch((e) => toast(e.message, { error: true }));
    },
    async move(to, uid, label) {
      const uids = targetUids(uid); if (!uids.length) return;
      const from = listFolder;
      dropMsgs(uids);
      try {
        const r = await api.move(from, uids, to);
        loadFolders();
        const newUids = uids.map((u) => r.uidMap?.[u]).filter(Boolean);
        toast(`${uids.length > 1 ? `${uids.length} conversations` : 'Conversation'} ${label || `moved to ${folderLabel(folders.find((f) => f.path === r.to) || { name: r.to })}`}`, {
          action: newUids.length ? 'Undo' : undefined,
          onAction: async () => { await api.move(r.to, newUids, from); loadFolders(); load({ quiet: true }); },
        });
      } catch (e) { toast(e.message, { error: true }); load({ quiet: true }); }
    },
    archive(uid) { return act.move('@archive', uid, 'archived'); },
    async del(uid) {
      const uids = targetUids(uid); if (!uids.length) return;
      const from = listFolder;
      dropMsgs(uids);
      try {
        const r = await api.remove(from, uids);
        loadFolders();
        const newUids = uids.map((u) => r.uidMap?.[u]).filter(Boolean);
        toast(r.permanent ? 'Permanently deleted' : `${uids.length > 1 ? `${uids.length} conversations` : 'Conversation'} moved to Deleted Items`, {
          action: newUids.length ? 'Undo' : undefined,
          onAction: async () => { await api.move(r.to, newUids, from); loadFolders(); load({ quiet: true }); },
        });
      } catch (e) { toast(e.message, { error: true }); load({ quiet: true }); }
    },
    junk(uid) { return act.move('@junk', uid, 'marked as junk'); },
    async notJunk(uid, sender) {
      const addr = sender || msgs.find((m) => m.uid === (Array.isArray(uid) ? uid[0] : uid || active))?.from?.[0]?.address;
      await act.move('INBOX', uid, 'moved to Inbox');
      if (addr) {
        toast(`Always trust ${addr}?`, { duration: 9000, action: 'Trust sender', onAction: () => api.post('/api/spam/senders', { list: 'safe', value: addr }).then(() => toast(`Mail from ${addr} will never go to Junk`)).catch((e) => toast(e.message, { error: true })) });
      }
    },
    snooze(uid) { const uids = targetUids(uid); if (uids.length) setSnoozeFor(uids); },
    async doSnooze(until) {
      const uids = snoozeFor; setSnoozeFor(null);
      if (!uids?.length) return;
      dropMsgs(uids);
      try {
        await api.post('/api/snooze', { folder: listFolder, uids, until });
        loadFolders();
        toast(`Snoozed until ${fmtWhen(until)}`);
      } catch (e) { toast(e.message, { error: true }); load({ quiet: true }); }
    },
    async unsnooze(uid) {
      const job = snoozeMap[uid]; if (!job) return;
      await api.post('/api/snoozed/wake', { id: job.id }).catch((e) => toast(e.message, { error: true }));
      toast('Moved back to your inbox'); load({ quiet: true }); loadFolders();
    },
    async block(address) {
      if (!confirm(`Block ${address}? The server will reject their future messages, in every app.`)) return;
      try { await api.post('/api/block', { address }); toast(`Blocked ${address}`); act.junk(); } catch (e) { toast(e.message, { error: true }); }
    },
    async emptyFolder() {
      if (!confirm(`Permanently delete everything in ${folderLabel(currentFolderObj || { name: folder })}?`)) return;
      await api.post('/api/empty', { folder: listFolder });
      load(); loadFolders();
    },
    async markAllRead() {
      await api.post('/api/mark-all-read', { folder: listFolder });
      setList((l) => ({ ...l, messages: l.messages.map((m) => ({ ...m, seen: true })) }));
      loadFolders();
    },
  };

  // ---------- compose ----------
  const compose = (initial = {}) => setComposers((c) => {
    if (c.length >= 3) { toast('Close a draft before opening another'); return c; }
    return [...c, { id: Date.now() + Math.random(), initial }];
  });
  const reply = (msg, mode) => compose(replyDraft({ folder: listFolder, ...msg }, mode, me.email));

  const openMessage = (m) => {
    if (m.draft || listFolder === special('\\Drafts')) {
      api.get('/api/message', { folder: listFolder, uid: m.uid }).then((full) => compose({
        to: full.to, cc: full.cc, bcc: full.bcc, subject: full.subject === '(no subject)' ? '' : full.subject,
        html: full.html || (full.text || '').replace(/\n/g, '<br>'), draftUid: m.uid, inReplyTo: full.inReplyTo,
      }));
      return;
    }
    setActive(m.uid);
    if (!m.seen) { patchMsgs([m.uid], () => ({ seen: true })); setTimeout(loadFolders, 800); }
  };

  // ---------- search ----------
  const runSearch = (q) => { setSearch(q.trim() || null); setSearchInput(q); };
  const clearSearch = () => { setSearch(null); setSearchInput(''); };

  // ---------- keyboard shortcuts (Gmail + Outlook) ----------
  useEffect(() => {
    const onKey = (e) => {
      if (view !== 'mail') return;
      const t = e.target;
      if (!(t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName)) && e.key === 'g') { goPending.current = Date.now(); return; }
      if (goPending.current && Date.now() - goPending.current < 1500 && !e.ctrlKey && !e.metaKey) {
        goPending.current = 0;
        if (e.key === 'c') { e.preventDefault(); setView('calendar'); return; }
        if (e.key === 'p') { e.preventDefault(); setView('contacts'); return; }
        if (e.key === 'i') { e.preventDefault(); setFolder('INBOX'); return; }
      }
      if (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); compose(); }
        return;
      }
      const idx = msgs.findIndex((m) => m.uid === active);
      const go = (i) => { const m = msgs[Math.max(0, Math.min(msgs.length - 1, i))]; if (m) openMessage(m); };
      const k = e.key;
      const map = {
        c: () => compose(), n: () => compose(),
        j: () => go(idx + 1), ArrowDown: () => go(idx + 1),
        k: () => go(idx < 0 ? 0 : idx - 1), ArrowUp: () => go(idx < 0 ? 0 : idx - 1),
        o: () => idx < 0 && go(0), Enter: () => idx < 0 && go(0),
        e: () => act.archive(), '#': () => act.del(), Delete: () => act.del(), '!': () => act.junk(),
        r: () => activeMsg && reply(activeMsg, 'reply'), a: () => activeMsg && reply(activeMsg, 'all'), f: () => activeMsg && reply(activeMsg, 'forward'),
        s: () => act.flag(), b: () => act.snooze(), u: () => setActive(null), Escape: () => { setActive(null); setSelected(new Set()); },
        I: () => act.read(true), U: () => act.read(false), q: () => act.read(true),
        x: () => active && setSelected((s) => { const n = new Set(s); n.has(active) ? n.delete(active) : n.add(active); return n; }),
        '/': () => searchRef.current?.focus(), '?': () => setShowHelp(true),
      };
      if (map[k]) { e.preventDefault(); map[k](); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const paneClass = `pane-${active ? prefs.readingPane : prefs.readingPane === 'off' ? 'off' : prefs.readingPane}`;

  return (
    <div className={`app density-${prefs.density}`}>
      <header className="topbar">
        <button className="icon-btn on-dark" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle navigation"><Icon name="menu" /></button>
        <div className="brand" onClick={() => { setView('mail'); setFolder('INBOX'); clearSearch(); }}><img src="/roammail-mark-white.png" alt="" /> <span>Roammail</span></div>
        {view === 'mail' ? (
          <form className="search" onSubmit={(e) => { e.preventDefault(); runSearch(searchInput); }}>
            <Icon name="search" />
            <input ref={searchRef} value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search mail  (from:  to:  subject:  has:attachment  is:unread  newer_than:7d)" aria-label="Search mail" />
            {search && <button type="button" className="icon-btn" onClick={clearSearch} aria-label="Clear search"><Icon name="close" /></button>}
          </form>
        ) : <div className="spacer" />}
        <div className="topbar-right">
          {(isAdmin || !inOrg) && (
            <button className={`top-btn ${view === 'admin' ? 'on' : ''}`} onClick={() => setView(view === 'admin' ? 'mail' : 'admin')} title="Admin & business email">
              <Icon name={view === 'admin' ? 'mail' : 'shield'} /> <span>{view === 'admin' ? 'Back to mail' : isAdmin ? 'Admin' : 'Business email'}</span>
            </button>
          )}
          <button className="icon-btn on-dark" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle dark mode"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <button className="icon-btn on-dark" onClick={() => setShowSettings(true)} title="Settings"><Icon name="settings" /></button>
          <button className="icon-btn on-dark" onClick={() => setShowHelp(true)} title="Keyboard shortcuts (?)">?</button>
          <div className="user-menu-wrap">
            <button className="avatar sm" style={{ background: avatarColor(me.email) }} onClick={() => setUserMenu((u) => !u)} title={me.email}>
              {initials({ name: prefs.displayName || me.name, address: me.email })}
            </button>
            {userMenu && (
              <div className="menu right" onMouseLeave={() => setUserMenu(false)}>
                <div className="menu-head"><b>{prefs.displayName || me.name || me.email.split('@')[0]}</b><small>{me.email}</small></div>
                <button onClick={() => { setShowSettings(true); setUserMenu(false); }}><Icon name="settings" /> Settings</button>
                {(isAdmin || !inOrg) && <button onClick={() => { setView('admin'); setUserMenu(false); }}><Icon name="shield" /> {isAdmin ? 'Admin portal' : 'Set up business email'}</button>}
                <button onClick={onLogout}><Icon name="logout" /> Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="shell">
      <nav className="app-rail" aria-label="Apps">
        {[['mail', 'mail', 'Mail'], ['calendar', 'calendar', 'Calendar'], ['contacts', 'users', 'Contacts']].map(([v, i, l]) => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={l} aria-label={l}><Icon name={i} size={20} /><small>{l}</small></button>
        ))}
      </nav>
      {view === 'admin' ? (
        <Suspense fallback={<div className="spinner" />}><Admin me={me} refreshMe={refreshMe} onExit={() => setView('mail')} /></Suspense>
      ) : view === 'calendar' ? (
        <Suspense fallback={<div className="spinner" />}><Calendar me={me} /></Suspense>
      ) : view === 'contacts' ? (
        <Suspense fallback={<div className="spinner" />}><Contacts me={me} onEmail={(c) => { compose({ to: [{ name: c.name, address: c.email }] }); setView('mail'); }} /></Suspense>
      ) : (
        <div className="body">
          {sidebarOpen && (
            <Sidebar folders={folders} current={search ? null : folder} onCompose={() => compose()} reload={loadFolders}
              me={me} mailboxes={sharedBoxes} mailbox={mailbox} onMailbox={switchMailbox}
              onSelect={(p) => { setFolder(p); clearSearch(); setFilter(''); if (window.innerWidth <= 900) setSidebarOpen(false); }}
              onDropMessages={(dest, uids) => act.move(dest, uids)} onScheduled={() => { setFolder('@scheduled'); clearSearch(); }} onQuarantine={() => { setFolder('@quarantine'); clearSearch(); }} qCount={qCount}
              categories={prefs.categories} onCategory={(c) => runSearch(`label:${catKeyword(c.name).slice(4)}`)} />
          )}
          <main className={`main ${paneClass}`}>
            <Ribbon
              hasSelection={!!(selected.size || active)} folderUse={currentFolderObj?.specialUse} folders={folders}
              onCompose={() => compose()} act={act} categories={prefs.categories}
              onReply={(mode) => activeMsg && reply(activeMsg, mode)} canReply={!!activeMsg}
              onRefresh={() => { load(); loadFolders(); }}
              readingPane={prefs.readingPane} setReadingPane={(v) => setPrefs({ readingPane: v })}
            />
            <div className="panes">
              {folder === '@quarantine' && !search ? <QuarantineList onChanged={setQCount} /> : folder === '@scheduled' && !search ? <ScheduledList onCompose={compose} /> : <MessageList
                snoozeMap={folder.toLowerCase() === 'snoozed' ? snoozeMap : null}
                list={list} title={search ? `Results for "${search}"` : folderLabel(currentFolderObj || { name: folder })}
                search={search} onClearSearch={clearSearch}
                folderUse={currentFolderObj?.specialUse} filter={filter} setFilter={setFilter}
                selected={selected} setSelected={setSelected} active={active} onOpen={openMessage}
                act={act} categories={prefs.categories} density={prefs.density}
                onLoadMore={() => !search && list.messages.length < list.total && !list.loading && load({ page: list.page + 1, append: true })}
                onEmpty={act.emptyFolder} onMarkAllRead={act.markAllRead}
              />}
              {!folder.startsWith('@') && (prefs.readingPane !== 'off' || active) ? (
                <ReadingPane
                  key={`${listFolder}:${active}`} folder={listFolder} msg={activeMsg} me={me} prefs={prefs} setPrefs={setPrefs}
                  conversation={prefs.conversation} onReply={reply} act={act} categories={prefs.categories}
                  onClose={() => setActive(null)} isJunk={currentFolderObj?.specialUse === '\\Junk'} orgDomains={me.orgDomains || []}
                />
              ) : null}
            </div>
          </main>
        </div>
      )}
      </div>

      {snoozeFor && <SnoozeMenu onPick={act.doSnooze} onClose={() => setSnoozeFor(null)} />}
      <ComposeManager composers={composers} setComposers={setComposers} me={me} prefs={prefs} sigData={sigData}
        onSent={() => { loadFolders(); if (listFolder === special('\\Sent') || listFolder === special('\\Drafts')) load({ quiet: true }); }} />
      {showSettings && <SettingsPanel prefs={prefs} setPrefs={setPrefs} me={me} folders={folders} sigData={sigData} reloadSigs={reloadSigs} onClose={() => setShowSettings(false)} />}
      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}
