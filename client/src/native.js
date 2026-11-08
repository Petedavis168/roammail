// The Roammail phone apps (mobile/) load this web app inside a native shell (Capacitor). The shell injects
// window.Capacitor with its plugins, so nothing here is bundled: in a normal browser every function is a no-op.
const cap = () => window.Capacitor;
export const isNative = () => !!cap()?.isNativePlatform?.();
export const platform = () => (isNative() ? cap().getPlatform() : 'web'); // 'ios' | 'android' | 'web'
const plugin = (name) => cap()?.Plugins?.[name];

// Our own hosts stay inside the app; everything else opens in the in-app browser (Safari view / Chrome tab)
const OWN = /(^|\.)roammail\.net$/i;
const isOwn = (u) => u.origin === location.origin || OWN.test(u.hostname);

async function openExternal(url) {
  const b = plugin('Browser');
  if (b) await b.open({ url, presentationStyle: 'popover' }).catch(() => { location.href = url; });
  else location.href = url;
}

const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
/** Attachments and exports: download with this session, save to the app's cache, then the share sheet (Save to Files, Photos, Drive, another app…). */
export async function saveFile(url, filename) {
  const fs = plugin('Filesystem'); const share = plugin('Share');
  if (!fs || !share) { location.href = url; return; }
  const r = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'mailcow-client' } });
  if (!r.ok) throw new Error('Could not download the file');
  const name = (filename || 'attachment').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'attachment';
  const saved = await fs.writeFile({ path: name, data: await toBase64(await r.blob()), directory: 'CACHE' });
  await share.share({ title: name, files: [saved.uri] }).catch(() => {}); // cancelling the sheet is fine
}

function linkClicks(doc) {
  doc.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (!a || e.defaultPrevented) return;
    let u; try { u = new URL(a.getAttribute('href'), location.href); } catch { return; }
    if (a.hasAttribute('download') || (isOwn(u) && u.pathname === '/api/attachment' && !u.searchParams.get('inline'))) {
      e.preventDefault();
      saveFile(u.href, a.getAttribute('download') || a.textContent.trim()).catch((x) => alert(x.message));
      return;
    }
    if (/^(mailto|tel|sms):/i.test(u.protocol) && !isOwn(u)) return; // the system handles these
    if (/^https?:$/.test(u.protocol) && !isOwn(u)) { e.preventDefault(); openExternal(u.href); }
  }, true);
}
/** Links inside an email (rendered in a same-origin sandboxed iframe). */
export function nativeFrameLinks(doc) { if (isNative() && doc) linkClicks(doc); }

// ---------------------------------------------------------------- push notifications
const TOKEN_KEY = 'nativePushToken';
let registering = null;
export async function nativePushState() {
  const p = plugin('PushNotifications'); if (!p) return 'unsupported';
  const { receive } = await p.checkPermissions();
  return receive === 'granted' && localStorage.getItem(TOKEN_KEY) ? 'on' : receive === 'denied' ? 'blocked' : 'off';
}
export async function nativePushEnable(post) {
  const p = plugin('PushNotifications'); if (!p) throw new Error('Notifications are not available');
  let { receive } = await p.checkPermissions();
  if (receive === 'prompt' || receive === 'prompt-with-rationale') ({ receive } = await p.requestPermissions());
  localStorage.setItem('nativePushAsked', '1');
  if (receive !== 'granted') throw new Error('Notifications are turned off for Roammail in your phone settings');
  if (platform() === 'android') await p.createChannel({ id: 'mail', name: 'New mail', description: 'New messages in your inbox', importance: 4, visibility: 0 }).catch(() => {});
  registering ||= new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) reject(new Error('Could not turn on notifications. Try again.')); }, 20000);
    p.addListener('registration', ({ value }) => { done = true; clearTimeout(t); resolve(value); });
    p.addListener('registrationError', () => { done = true; clearTimeout(t); reject(new Error('Could not turn on notifications. Try again.')); });
    p.register();
  }).finally(() => { registering = null; });
  const token = await registering;
  await post('/api/push/native', { platform: platform(), token });
  localStorage.setItem(TOKEN_KEY, token);
}
export async function nativePushDisable(post) {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) await post('/api/push/native/unregister', { platform: platform(), token }).catch(() => {});
  localStorage.removeItem(TOKEN_KEY);
}
/** Ask once after the first sign-in, as phone apps do; afterwards keep the token fresh. */
export async function nativePushRefresh(post) {
  if (!plugin('PushNotifications')) return;
  if ((await nativePushState()) === 'on' || !localStorage.getItem('nativePushAsked')) await nativePushEnable(post).catch(() => {});
}

// ---------------------------------------------------------------- start-up
export function initNative() {
  if (!isNative()) return;
  document.documentElement.classList.add('native-app', `native-${platform()}`);
  linkClicks(document);
  // Tapping a notification: open its mailbox / message
  plugin('PushNotifications')?.addListener('pushNotificationActionPerformed', ({ notification }) => {
    const url = notification?.data?.url; if (url && url.startsWith('/')) location.href = url;
  });
  // A roammail.net link opened from another app (App Links / Universal Links)
  plugin('App')?.addListener('appUrlOpen', ({ url }) => {
    try { const u = new URL(url); if (OWN.test(u.hostname)) location.href = u.href; } catch { /* ignore */ }
  });
  plugin('StatusBar')?.setStyle?.({ style: 'DARK' }).catch?.(() => {});
}
