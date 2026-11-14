// After we release an update, copies of Roammail that were already open keep running the old version until reloaded.
// Every few minutes (and whenever the tab comes back into view) we check /version.json; if it changed, a small bar
// offers to reload. Signing in always loads the newest version anyway.
/* global __BUILD_ID__ */
const CURRENT = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';
let shown = false;

async function check() {
  if (shown || !CURRENT || document.hidden) return;
  try {
    const r = await fetch('/version.json', { cache: 'no-store' });
    if (!r.ok) return;
    const { build } = await r.json();
    if (build && build !== CURRENT) show();
  } catch { /* offline: try later */ }
}

function show() {
  shown = true;
  const bar = document.createElement('div');
  bar.className = 'update-bar'; bar.setAttribute('role', 'status');
  const text = document.createElement('span'); text.textContent = 'A new version of Roammail is ready.';
  const btn = document.createElement('button'); btn.textContent = 'Reload'; btn.className = 'btn sm primary';
  btn.onclick = async () => {
    try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch { /* still reload */ }
    location.reload();
  };
  const later = document.createElement('button'); later.textContent = 'Later'; later.className = 'link';
  later.onclick = () => { bar.remove(); shown = false; setTimeout(check, 30 * 60e3); };
  bar.append(text, btn, later);
  document.body.append(bar);
}

export function watchForUpdates() {
  setInterval(check, 5 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setTimeout(check, 60e3);
}
