// "Install the Roammail app": the browser's own install prompt where there is one (Chrome, Edge, Android),
// step-by-step instructions on iPhone/iPad (Safari has no prompt) and nothing once it's installed.
let deferred = null;
const subs = new Set();
const tell = () => subs.forEach((f) => f());
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; tell(); });
window.addEventListener('appinstalled', () => { deferred = null; localStorage.setItem('pwaInstalled', '1'); tell(); });

export const isInstalled = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true || !!window.RoammailNative || !!window.Capacitor;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** 'prompt' (one tap), 'ios' (show how), or null (installed, or this browser can't). */
export const installMode = () => (isInstalled() ? null : deferred ? 'prompt' : isIOS() ? 'ios' : null);
export const onInstallChange = (f) => { subs.add(f); return () => subs.delete(f); };
export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
  deferred = null; tell();
  return outcome === 'accepted';
}
