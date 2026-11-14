// Protected email page: ask for the password, then show the email (in a sandboxed frame), its attachments and a
// secure reply box. Plain JavaScript; all text from the server is inserted as text.
(() => {
  const app = document.getElementById('app');
  const id = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  };
  const show = (...kids) => app.replaceChildren(h('div', { class: 'sc-card' }, ...kids));
  const api = async (path, body, raw) => {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'X-Requested-With': 'mailcow-client', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (raw && r.ok) return r;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
    return d;
  };
  const date = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  async function start() {
    let info;
    try { info = await api(`/api/public/secure/${encodeURIComponent(id)}`); } catch (e) { return show(h('div', { class: 'sc-msg' }, e.message)); }
    const msgs = { revoked: 'The sender has withdrawn this email.', expired: 'This protected email has expired.', locked: 'Too many wrong passwords were tried, so this email is locked. Ask the sender to send it again.' };
    if (msgs[info.state]) return show(h('div', { class: 'sc-lock' }, h('div', { class: 'sc-icon' }, '🔒'), h('h1', {}, 'Not available'), h('p', {}, msgs[info.state])));
    // Disappearing message: the key is in the link (after #), so it opens straight away
    const k = new URLSearchParams(location.hash.slice(1)).get('k');
    if (k) {
      history.replaceState(null, '', location.pathname); // don't leave the key in the address bar or history
      try { return read(await api(`/api/public/secure/${encodeURIComponent(id)}/open`, { password: k }), true); } catch (e) { return show(h('div', { class: 'sc-msg' }, e.message)); }
    }
    const pw = h('input', { type: 'password', autocomplete: 'off', 'aria-label': 'Password', placeholder: 'Password', required: true });
    const err = h('div');
    const btn = h('button', { class: 'sc-btn', type: 'submit' }, 'Open');
    const form = h('form', { class: 'sc-lock', onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; btn.textContent = 'Opening…'; err.replaceChildren();
      try { read(await api(`/api/public/secure/${encodeURIComponent(id)}/open`, { password: pw.value })); }
      catch (x) { err.replaceChildren(h('div', { class: 'sc-err' }, x.message)); btn.disabled = false; btn.textContent = 'Open'; pw.select(); }
    } },
    h('div', { class: 'sc-icon', 'aria-hidden': 'true' }, '🔒'),
    h('h1', {}, `${info.from} sent you a protected email`),
    h('p', {}, `Enter the password ${info.from.split(' ')[0]} sent you separately. Available until ${date(info.expiresAt)}.`),
    info.hint ? h('div', { class: 'sc-hint' }, `Hint: ${info.hint}`) : '', err, pw, btn);
    show(form);
    pw.focus();
  }

  function read(m, disappearing) {
    document.title = m.subject || 'Protected email';
    if (disappearing) setTimeout(() => { const n = document.createElement('div'); n.className = 'sc-hint'; n.textContent = `⏳ This message disappears ${Number(m.expiresAt) - Date.now() < 20 * 60e3 ? 'in a few minutes' : `on ${date(m.expiresAt)}`}. Save anything you need now.`; app.prepend(n); }, 0);
    const head = h('div', { class: 'sc-head' }, h('h1', {}, m.subject || '(no subject)'),
      h('div', { class: 'sc-meta' }, `From ${m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address} · ${date(m.sentAt)}`));
    let body;
    if (m.html) {
      // shown in a sandboxed frame: no scripts, no access to this page; links open in a new tab
      body = h('iframe', { sandbox: 'allow-popups allow-popups-to-escape-sandbox', title: 'Email', referrerpolicy: 'no-referrer' });
      body.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;margin:18px 24px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>${m.html}`;
      body.addEventListener('load', () => { try { body.style.height = `${body.contentDocument.documentElement.scrollHeight + 10}px`; } catch { body.style.height = '480px'; } });
    } else body = h('pre', {}, m.text || '');
    const atts = m.attachments.length ? h('div', { class: 'sc-atts' }, m.attachments.map((a) => h('button', { class: 'sc-att', onclick: async () => {
      try {
        const r = await api(`/api/public/secure/${encodeURIComponent(id)}/attachment`, { token: m.token, index: a.index }, true);
        const url = URL.createObjectURL(await r.blob());
        const link = h('a', { href: url, download: a.filename }); document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (e) { alert(e.message); }
    } }, `📎 ${a.filename} (${size(a.size)})`))) : '';
    const text = h('textarea', { rows: 4, maxlength: 20000, placeholder: `Write a reply to ${m.from.name || m.from.address}…`, 'aria-label': 'Reply' });
    const status = h('div');
    const send = h('button', { class: 'sc-btn sm', onclick: async () => {
      send.disabled = true; status.replaceChildren();
      try { await api(`/api/public/secure/${encodeURIComponent(id)}/reply`, { token: m.token, text: text.value }); text.value = ''; status.replaceChildren(h('p', { class: 'sc-meta' }, '✓ Reply sent securely.')); }
      catch (e) { status.replaceChildren(h('div', { class: 'sc-err' }, e.message)); } finally { send.disabled = false; }
    } }, 'Send secure reply');
    show(head, h('div', { class: 'sc-body' }, body), atts, h('div', { class: 'sc-reply' }, h('b', {}, 'Reply securely'), text, status, send));
  }
  start();
})();
