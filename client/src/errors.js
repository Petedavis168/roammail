// Report crashes in the browser and the phone apps to the server log (and from there to the error alarm).
// Only the error message, where it happened and the page path are sent: no email content.
import { platform } from './native.js';

let sent = 0;
function report(message, source) {
  if (!message || sent >= 10) return; // at most 10 reports per page load
  sent++;
  const version = (document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') || '').replace(/^.*index-|\.js$/g, '');
  fetch('/api/client-error', {
    method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mailcow-client' },
    body: JSON.stringify({ message: String(message).slice(0, 300), source: String(source || '').slice(0, 200), page: location.pathname, app: platform(), version }),
  }).catch(() => {});
}

export function startErrorReporting() {
  window.addEventListener('error', (e) => {
    if (!e.message || /ResizeObserver loop/.test(e.message)) return; // harmless browser noise
    report(e.message, e.filename ? `${e.filename.replace(location.origin, '')}:${e.lineno}:${e.colno}` : '');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r?.status && r.status < 500) return; // API answered with a normal "no" (wrong password etc.)
    if (r?.name === 'AbortError' || /Failed to fetch|NetworkError|Load failed/i.test(String(r?.message || r))) return; // offline
    report(r?.message || String(r), (r?.stack || '').split('\n')[1]?.trim());
  });
}
export const reportError = report;
