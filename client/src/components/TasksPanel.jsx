// Tasks, notes and follow-ups side panel (item 9). T opens/closes it; Shift+T adds a task from the open message.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { parseWhen, fmtDue } from '../when.js';
import { evStart } from './calendar/dates.js';
import { useToast } from './Toast.jsx';
import { t } from '../i18n.js';

function CalendarPeek() {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    const from = new Date(); const to = new Date(); to.setHours(23, 59, 59, 999); to.setDate(to.getDate() + 1);
    api.get('/api/calendar/events', { from: new Date(from.setHours(0, 0, 0, 0)).toISOString(), to: to.toISOString() })
      .then((r) => setEvents(r.filter((e) => evStart(e) >= new Date(Date.now() - 3600e3) || e.allDay).sort((a, b) => evStart(a) - evStart(b)).slice(0, 4)))
      .catch(() => setEvents([]));
  }, []);
  if (!events?.length) return null;
  return (
    <div className="peek">
      <div className="peek-title"><Icon name="calendar" size={14} />{' '}{t("Coming up")}</div>
      {events.map((e) => (
        <div key={`${e.uid}-${e.start}`} className="peek-ev"><span>{e.allDay ? 'All day' : `${fmtDue(evStart(e).getTime())}`}</span><b>{e.title || '(no title)'}</b></div>
      ))}
    </div>
  );
}

function TaskRow({ t, onChange, onDelete, onOpenMessage }) {
  const overdue = !t.done && t.dueAt && t.dueAt < Date.now();
  return (
    <div className={`task ${t.done ? 'done' : ''}`}>
      <input type="checkbox" checked={t.done} onChange={() => onChange(t, { done: !t.done })} aria-label={t.done ? 'Mark not done' : 'Mark done'} />
      <div className="task-main">
        <div className="task-title">{t.title}</div>
        <div className="task-meta">
          {t.dueAt && <span className={overdue ? 'bad' : ''}><Icon name="clock" size={12} /> {fmtDue(t.dueAt)}</span>}
          {t.remindAt && !t.done && <span title={t("Reminder")}><Icon name="alert" size={12} /> {fmtDue(t.remindAt)}</span>}
          {t.message && <button className="link" onClick={() => onOpenMessage(t.message)}><Icon name="mail" size={12} /> {t.message.subject || 'Message'}</button>}
        </div>
      </div>
      <button className="icon-btn xs" onClick={() => onDelete(t)} title={t("Delete task")} aria-label={t("Delete task")}><Icon name="close" size={14} /></button>
    </div>
  );
}

function Tasks({ seed, onSeedUsed, onOpenMessage }) {
  const toast = useToast();
  const [data, setData] = useState({ open: [], done: [] });
  const [text, setText] = useState('');
  const [link, setLink] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const inputRef = useRef();
  const load = () => api.get('/api/tasks').then(setData).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (seed) { setText(seed.title); setLink(seed.message); onSeedUsed(); setTimeout(() => inputRef.current?.focus(), 0); } }, [seed]);
  const parsed = useMemo(() => parseWhen(text), [text]);
  const add = async (e) => {
    e.preventDefault();
    if (!parsed.title) return;
    try {
      await api.post('/api/tasks', { title: parsed.title, dueAt: parsed.at, remindAt: parsed.at, message: link });
      setText(''); setLink(null); load();
    } catch (err) { toast(err.message, { error: true }); }
  };
  const change = async (t, patch) => { await api.patch(`/api/tasks/${t.id}`, patch).catch((e) => toast(e.message, { error: true })); load(); };
  const del = async (t) => { await api.del(`/api/tasks/${t.id}`); load(); };
  return (
    <>
      <form className="quick-add" onSubmit={add}>
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Add a task, e.g. \"Call Ann tomorrow 3pm\"")} aria-label={t("New task")} />
        {(parsed.label || link) && (
          <div className="qa-hints">
            {parsed.label && <span className="pill"><Icon name="clock" size={12} /> {parsed.label}</span>}
            {link && <span className="pill"><Icon name="mail" size={12} /> {link.subject || 'This message'} <button type="button" className="link" onClick={() => setLink(null)} aria-label={t("Unlink message")}>×</button></span>}
          </div>
        )}
      </form>
      {!data.open.length && <div className="panel-empty">{t("No open tasks. Press")}{' '}<kbd>{t("Shift")}</kbd>+<kbd>T</kbd>{' '}{t("on a message to turn it into one.")}</div>}
      {data.open.map((t) => <TaskRow key={t.id} t={t} onChange={change} onDelete={del} onOpenMessage={onOpenMessage} />)}
      {data.done.length > 0 && <button className="link panel-more" onClick={() => setShowDone((x) => !x)}>{showDone ? 'Hide' : 'Show'}{' '}{t("completed (")}{data.done.length})</button>}
      {showDone && data.done.map((t) => <TaskRow key={t.id} t={t} onChange={change} onDelete={del} onOpenMessage={onOpenMessage} />)}
    </>
  );
}

function NoteList({ notes, onSave, onDelete }) {
  const [editing, setEditing] = useState(null);
  return notes.map((n) => (
    <div key={n.id} className="note">
      {editing === n.id ? (
        <NoteEditor initial={n.body} onSave={async (body) => { await onSave(n, body); setEditing(null); }} onCancel={() => setEditing(null)} />
      ) : (
        <>
          <div className="note-body" onDoubleClick={() => setEditing(n.id)}>{n.body}</div>
          <div className="task-meta">
            <span>{fmtDue(n.updatedAt)}</span>
            {n.contact && <span><Icon name="users" size={12} /> {n.contact}</span>}
            {n.threadSubject && <span><Icon name="mail" size={12} /> {n.threadSubject}</span>}
            <button className="link" onClick={() => setEditing(n.id)}>{t("Edit")}</button>
            <button className="link" onClick={() => onDelete(n)}>{t("Delete")}</button>
          </div>
        </>
      )}
    </div>
  ));
}
function NoteEditor({ initial = '', onSave, onCancel, placeholder }) {
  const [body, setBody] = useState(initial);
  return (
    <form className="note-editor" onSubmit={(e) => { e.preventDefault(); if (body.trim()) onSave(body).then(() => setBody('')); }}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder || 'Write a note'} rows={3} aria-label={t("Note")}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') e.currentTarget.form.requestSubmit(); }} />
      <div className="row-btns">{onCancel && <button type="button" className="btn sm ghost" onClick={onCancel}>{t("Cancel")}</button>}<button className="btn sm primary" disabled={!body.trim()}>{t("Save")}</button></div>
    </form>
  );
}

function Notes({ context }) {
  const toast = useToast();
  const [notes, setNotes] = useState([]);
  const sender = context?.from?.[0]?.address?.toLowerCase();
  const thread = context?.messageId;
  const load = () => api.get('/api/notes', context ? { contact: sender, thread } : {}).then(setNotes).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, [sender, thread]);
  const add = (extra) => async (body) => { await api.post('/api/notes', { body, ...extra }).catch((e) => toast(e.message, { error: true })); load(); };
  const save = async (n, body) => { await api.patch(`/api/notes/${n.id}`, { body }); load(); };
  const del = async (n) => { if (confirm(t("Delete this note?"))) { await api.del(`/api/notes/${n.id}`); load(); } };
  if (!context) {
    return (
      <>
        <NoteEditor onSave={add({})} placeholder={t("A quick note to yourself")} />
        {!notes.length && <div className="panel-empty">{t("No notes yet. Open a message to add notes about the conversation or the sender.")}</div>}
        <NoteList notes={notes} onSave={save} onDelete={del} />
      </>
    );
  }
  const onThread = notes.filter((n) => thread && n.thread === `<${String(thread).replace(/^<|>$/g, '')}>`);
  const onSender = notes.filter((n) => !onThread.includes(n));
  return (
    <>
      {thread && <>
        <h4 className="panel-h">{t("This conversation")}</h4>
        <NoteEditor onSave={add({ thread, threadSubject: context.subject })} placeholder={t("Notes on this conversation")} />
        <NoteList notes={onThread} onSave={save} onDelete={del} />
      </>}
      {sender && <>
        <h4 className="panel-h">{t("About")}{' '}{context.from[0].name || sender}</h4>
        <NoteEditor onSave={add({ contact: sender })} placeholder={`Notes about ${context.from[0].name || sender}`} />
        <NoteList notes={onSender} onSave={save} onDelete={del} />
      </>}
    </>
  );
}

function Followups() {
  const toast = useToast();
  const [list, setList] = useState([]);
  const load = () => api.get('/api/followups').then(setList).catch((e) => toast(e.message, { error: true }));
  useEffect(() => { load(); }, []);
  const label = { waiting: 'Waiting for a reply', checking: 'Checking…', due: 'No reply yet', replied: 'They replied', done: 'Done' };
  return (
    <>
      {!list.length && <div className="panel-empty">{t("Nothing to follow up. Open a message you sent and choose")}{' '}<b>{t("Remind me if no reply")}</b>{' '}{t("from the ⋯ menu.")}</div>}
      {list.map((f) => (
        <div key={f.id} className={`task fu-${f.status}`}>
          <Icon name={f.status === 'replied' ? 'check' : f.status === 'due' ? 'alert' : 'clock'} size={16} />
          <div className="task-main">
            <div className="task-title">{f.subject || '(no subject)'}</div>
            <div className="task-meta"><span>{label[f.status] || f.status}</span>{f.status === 'waiting' && <span>{fmtDue(f.remindAt)}</span>}{f.recipients && <span>{f.recipients}</span>}</div>
          </div>
          {f.status === 'due' && <button className="link" onClick={async () => { await api.patch(`/api/followups/${f.id}`, { status: 'done' }); load(); }}>{t("Done")}</button>}
          <button className="icon-btn xs" title={t("Remove")} aria-label={t("Remove follow-up")} onClick={async () => { await api.del(`/api/followups/${f.id}`); load(); }}><Icon name="close" size={14} /></button>
        </div>
      ))}
    </>
  );
}

export default function TasksPanel({ tab, setTab, onClose, context, seed, onSeedUsed, onOpenMessage }) {
  return (
    <aside className="tasks-panel" aria-label={t("Tasks, notes and follow-ups")}>
      <div className="panel-head">
        <div className="tabs" role="tablist">
          {[['tasks', 'Tasks'], ['notes', 'Notes'], ['followups', 'Follow-ups']].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <button className="icon-btn" onClick={onClose} title={t("Close (T)")} aria-label={t("Close panel")}><Icon name="close" /></button>
      </div>
      <div className="panel-body">
        {tab === 'tasks' && <><CalendarPeek /><Tasks seed={seed} onSeedUsed={onSeedUsed} onOpenMessage={onOpenMessage} /></>}
        {tab === 'notes' && <Notes context={context} />}
        {tab === 'followups' && <Followups />}
      </div>
    </aside>
  );
}
