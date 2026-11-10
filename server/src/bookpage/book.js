// Public booking page: pick a meeting type, a day, a time; fill in your details; done. Also the guest's cancel page.
// Plain JavaScript, no framework: it has to load fast on any phone. All text from the server is inserted as text.
(() => {
  const app = document.getElementById('app');
  const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['book', slug, type?] or ['book', 'manage', token]
  const guestTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let tz = guestTz;

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  };
  const show = (...kids) => { app.replaceChildren(h('div', { class: 'bk-card' }, ...kids)); window.scrollTo(0, 0); };
  const msg = (text) => show(h('div', { class: 'bk-msg' }, text));
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { ...opts, headers: { 'X-Requested-With': 'mailcow-client', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
    return d;
  };
  const LOC = { video: 'Video call', phone: 'Phone call', in_person: 'In person', custom: '' };
  const icon = { video: '🎥', phone: '📞', in_person: '📍', custom: '📍' };
  const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const fmtTime = (d) => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  const fmtDay = (s) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${s}T12:00:00Z`));
  const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const meta = (t) => h('div', { class: 'bk-meta' }, h('span', {}, `⏱ ${dur(t.duration)}`), h('span', {}, `${icon[t.location]} ${t.location === 'custom' || t.location === 'in_person' ? t.locationDetail || LOC[t.location] : LOC[t.location]}`));

  // ---------------------------------------------------------------- cancel link
  async function manage(token) {
    let b;
    try { b = await api(`/api/public/booking/${encodeURIComponent(token)}`); } catch (e) { return msg(e.message); }
    const summary = h('div', { class: 'bk-summary' }, h('b', {}, b.type), b.with ? ` with ${b.with}` : '', h('br'), b.when, b.location ? [h('br'), b.location] : '');
    if (b.status !== 'confirmed') return show(h('div', { class: 'bk-done' }, h('h2', {}, 'This booking is cancelled'), summary, b.bookAgain ? h('p', {}, h('a', { href: b.bookAgain }, 'Book another time')) : ''));
    if (b.past) return show(h('div', { class: 'bk-done' }, h('h2', {}, 'This meeting has already happened'), summary));
    const reason = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Let them know why (optional)' });
    const err = h('div');
    const btn = h('button', { class: 'bk-btn', onclick: async () => {
      btn.disabled = true; err.replaceChildren();
      try {
        await api(`/api/public/booking/${encodeURIComponent(token)}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.value }) });
        show(h('div', { class: 'bk-done' }, h('h2', {}, 'Cancelled'), h('p', {}, 'We’ve let them know and removed it from their calendar.'), summary, b.bookAgain ? h('p', {}, h('a', { href: b.bookAgain }, 'Book another time')) : ''));
      } catch (e) { err.replaceChildren(h('div', { class: 'bk-err' }, e.message)); btn.disabled = false; }
    } }, 'Cancel this meeting');
    show(h('div', { class: 'bk-done' }, h('h2', {}, 'Your booking'), summary, h('div', { class: 'bk-form', style: { margin: '0 auto' } }, err, h('label', {}, 'Reason', reason), btn,
      b.bookAgain ? h('p', {}, h('a', { href: b.bookAgain }, 'Need a different time? Cancel, then book again.')) : '')));
  }

  // ---------------------------------------------------------------- the page
  async function page(slug, typeSlug) {
    let p;
    try { p = await api(`/api/public/book/${encodeURIComponent(slug)}`); } catch (e) { return msg(e.message); }
    document.title = `Book a time with ${p.title || 'me'}`;
    const head = h('div', { class: 'bk-head' }, h('div', { class: 'bk-avatar', 'aria-hidden': 'true' }, initials(p.title)), h('h1', {}, p.title || 'Book a time'), p.intro ? h('p', {}, p.intro) : '');
    if (!p.open) return show(head, h('div', { class: 'bk-msg' }, 'Not taking bookings right now. Please check back later.'));
    if (!p.types.length) return show(head, h('div', { class: 'bk-msg' }, 'No meeting types are available right now.'));
    const type = typeSlug ? p.types.find((t) => t.slug === typeSlug) : p.types.length === 1 ? p.types[0] : null;
    if (typeSlug && !type) return show(head, h('div', { class: 'bk-msg' }, 'That meeting type isn’t available. ', h('a', { href: `/book/${encodeURIComponent(slug)}` }, 'See all options')));
    if (!type) {
      return show(head, h('ul', { class: 'bk-types' }, p.types.map((t) => h('li', {}, h('a', { class: 'bk-type', style: { '--c': t.color }, href: `/book/${encodeURIComponent(slug)}/${encodeURIComponent(t.slug)}` },
        h('h2', {}, t.name), meta(t), t.description ? h('p', {}, t.description) : '')))));
    }
    picker(p, type, slug);
  }

  function picker(p, type, slug) {
    document.documentElement.style.setProperty('--brand', type.color || '#1d4ed8');
    const today = new Date();
    let month = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1));
    let slots = {}; let selected = null; let loading = false;
    const side = h('div', { class: 'bk-side' },
      p.types.length > 1 ? h('button', { class: 'bk-back', onclick: () => { history.pushState(null, '', `/book/${encodeURIComponent(slug)}`); page(slug); } }, '← All meeting types') : '',
      h('div', { class: 'bk-meta' }, p.title || ''), h('h2', {}, type.name), meta(type), type.description ? h('p', {}, type.description) : '');
    const cal = h('div', { class: 'bk-cal' });
    const times = h('div', { class: 'bk-times' });
    const zones = (() => { let z = []; try { z = Intl.supportedValuesOf('timeZone'); } catch { /* old browser */ } return z.includes(tz) ? z : [tz, ...z]; })();
    const tzSel = h('select', { 'aria-label': 'Time zone', onchange: (e) => { tz = e.target.value; load(); } }, zones.map((z) => h('option', { value: z, selected: z === tz }, z.replace(/_/g, ' '))));

    async function load() {
      loading = true; draw();
      const from = new Date(Math.max(Date.now(), month.getTime() - 864e5));
      try {
        const r = await api(`/api/public/book/${encodeURIComponent(slug)}/${encodeURIComponent(type.slug)}/slots?from=${encodeURIComponent(from.toISOString())}&days=31`);
        slots = {};
        for (const s of r.slots) { const d = new Date(s); (slots[ymd(d)] ||= []).push(d); }
        if (!selected || !slots[selected]) selected = Object.keys(slots).sort().find((k) => k.slice(0, 7) === month.toISOString().slice(0, 7)) || null;
      } catch (e) { slots = {}; times.replaceChildren(h('div', { class: 'bk-err' }, e.message)); }
      loading = false; draw();
    }
    function draw() {
      const y = month.getUTCFullYear(); const m = month.getUTCMonth();
      const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const label = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(month);
      const thisMonth = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)).getTime();
      const days = [];
      for (let i = 0; i < first; i++) days.push(h('span'));
      for (let d = 1; d <= n; d++) {
        const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const open = !!slots[key];
        days.push(h('button', { class: `bk-day${open ? ' open' : ''}${key === selected ? ' sel' : ''}${key === ymd(today) ? ' today' : ''}`, disabled: !open, 'aria-label': `${fmtDay(key)}${open ? ', times available' : ''}`,
          onclick: () => { selected = key; draw(); } }, String(d)));
      }
      cal.replaceChildren(
        h('div', { class: 'bk-cal-head' },
          h('button', { class: 'bk-nav', 'aria-label': 'Previous month', disabled: month.getTime() <= thisMonth, onclick: () => { month = new Date(Date.UTC(y, m - 1, 1)); selected = null; load(); } }, '‹'),
          h('b', {}, label),
          h('button', { class: 'bk-nav', 'aria-label': 'Next month', onclick: () => { month = new Date(Date.UTC(y, m + 1, 1)); selected = null; load(); } }, '›')),
        h('div', { class: 'bk-days' }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('span', { class: 'bk-dow' }, x)), days),
        h('div', { class: 'bk-tz' }, 'Times shown in ', tzSel));
      if (loading) { times.replaceChildren(h('div', { class: 'bk-msg' }, 'Finding times…')); return; }
      if (!selected) { times.replaceChildren(h('div', { class: 'bk-msg' }, Object.keys(slots).length ? 'Pick a day' : 'No times left this month. Try the next one.')); return; }
      times.replaceChildren(h('h3', {}, fmtDay(selected)), ...(slots[selected] || []).map((d) => h('button', { class: 'bk-time', onclick: () => form(p, type, slug, d) }, fmtTime(d))));
    }
    show(h('div', { class: 'bk-grid' }, side, cal, times));
    load();
  }

  function form(p, type, slug, start) {
    const when = `${new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(start)} (${tz.replace(/_/g, ' ')})`;
    const f = {
      name: h('input', { autocomplete: 'name', required: true, maxlength: 100 }), email: h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: 200 }),
      phone: h('input', { type: 'tel', autocomplete: 'tel', maxlength: 40, required: type.location === 'phone' }), notes: h('textarea', { rows: 4, maxlength: 2000 }),
      website: h('input', { tabindex: '-1', autocomplete: 'off' }),
    };
    const err = h('div');
    const btn = h('button', { class: 'bk-btn', type: 'submit' }, 'Confirm booking');
    const submit = async (e) => {
      e.preventDefault(); btn.disabled = true; btn.textContent = 'Booking…'; err.replaceChildren();
      try {
        const r = await api(`/api/public/book/${encodeURIComponent(slug)}/${encodeURIComponent(type.slug)}`, { method: 'POST', body: JSON.stringify({
          start: start.toISOString(), timezone: tz, name: f.name.value, email: f.email.value, phone: f.phone.value, notes: f.notes.value, website: f.website.value }) });
        show(h('div', { class: 'bk-done' }, h('div', { class: 'tick', 'aria-hidden': 'true' }, '✓'), h('h2', {}, 'You’re booked'),
          h('p', {}, `A confirmation with a calendar invite is on its way to ${f.email.value}.`),
          h('div', { class: 'bk-summary' }, h('b', {}, type.name), p.title ? ` with ${p.title}` : '', h('br'), r.when, r.location ? [h('br'), /^https?:\/\//.test(r.location) ? h('a', { href: r.location, rel: 'noopener', target: '_blank' }, r.location) : r.location] : ''),
          h('p', {}, h('a', { href: r.manageUrl }, 'Need to cancel?'))));
      } catch (e2) { err.replaceChildren(h('div', { class: 'bk-err' }, e2.message)); btn.disabled = false; btn.textContent = 'Confirm booking'; }
    };
    show(h('div', { class: 'bk-grid', style: { gridTemplateColumns: 'minmax(0, 280px) 1fr' } },
      h('div', { class: 'bk-side' }, h('button', { class: 'bk-back', onclick: () => picker(p, type, slug) }, '← Pick another time'), h('div', { class: 'bk-meta' }, p.title || ''),
        h('h2', {}, type.name), meta(type), h('p', {}, h('b', {}, `🗓 ${when}`))),
      h('form', { class: 'bk-form', onsubmit: submit }, err,
        h('label', {}, 'Your name', f.name), h('label', {}, 'Email', f.email),
        h('label', {}, type.location === 'phone' ? 'Phone number (we’ll call you)' : 'Phone (optional)', f.phone),
        h('label', {}, 'Anything to share before the meeting? (optional)', f.notes),
        h('label', { class: 'bk-hp', 'aria-hidden': 'true' }, 'Leave this empty', f.website), btn)));
    f.name.focus();
  }

  // ---------------------------------------------------------------- start
  const route = () => {
    const p2 = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (p2[1] === 'manage' && p2[2]) return manage(p2[2]);
    if (p2[1]) return page(p2[1], p2[2]);
    return msg('Booking page not found');
  };
  window.addEventListener('popstate', route);
  void parts;
  route();
})();
