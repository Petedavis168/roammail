import { api } from './api.js';
import { isNative, nativePushState, nativePushEnable, nativePushDisable, nativePushRefresh } from './native.js';
const post = (u, b) => api.post(u, b);

const b64ToBytes = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
export const pushSupported = () => isNative() || 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function pushState() {
  if (isNative()) return nativePushState();
  if (!pushSupported()) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : Notification.permission === 'denied' ? 'blocked' : 'off';
}
export async function enablePush() {
  if (isNative()) return nativePushEnable(post);
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked in your browser settings');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.get('/api/push/key');
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
}
export async function disablePush() {
  if (isNative()) return nativePushDisable(post);
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}
/** Re-send the subscription now and then so the server's copy of it stays fresh (it expires after 30 days). */
export async function refreshPush() { if (isNative()) return nativePushRefresh(post); if (await pushState() === 'on') await enablePush().catch(() => {}); }
