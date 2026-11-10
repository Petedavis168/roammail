// Roammail for Mac, Windows and Linux: a secure window onto roammail.net, plus what a desktop mail app should do:
// open email links (mailto:) as a new email, show the unread count on the dock/taskbar, keep one window, open other
// websites in your normal browser, and work with keyboard shortcuts and the system menu.
//
// Security: the page runs with no access to your computer (sandboxed, no Node.js, context isolation). Only Roammail's
// own addresses (and Microsoft/Google sign-in for businesses) open inside the app; everything else goes to your browser.
const { app, BrowserWindow, Menu, shell, session, nativeTheme } = require('electron');
const path = require('node:path');

const BASE = (process.env.ROAMMAIL_URL || 'https://roammail.net').replace(/\/$/, '');
const ROOT = new URL(BASE).hostname.replace(/^(app|www|login)\./, '');
const SIGN_IN_PROVIDERS = ['login.microsoftonline.com', 'accounts.google.com'];
const ours = (u) => { try { const h = new URL(u).hostname; return h === ROOT || h.endsWith(`.${ROOT}`); } catch { return false; } };
const inApp = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' || BASE.startsWith('http://')) && (ours(u) || SIGN_IN_PROVIDERS.includes(x.hostname)); } catch { return false; } };
const external = (u) => { try { const p = new URL(u).protocol; if (['https:', 'http:', 'mailto:', 'tel:'].includes(p)) shell.openExternal(u); } catch { /* ignore */ } };

let win = null;
let pendingMailto = process.argv.find((a) => /^mailto:/i.test(a)) || null;
const composeUrl = (m) => `${BASE}/app?compose=1&mailto=${encodeURIComponent(m)}`;

function openMailto(m) {
  if (!/^mailto:/i.test(m || '')) return;
  if (!win) { pendingMailto = m; return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  win.loadURL(composeUrl(m));
}

if (!app.requestSingleInstanceLock()) app.quit(); // one Roammail window; a second launch focuses the first
app.on('second-instance', (_e, argv) => {
  const m = argv.find((a) => /^mailto:/i.test(a));
  if (m) openMailto(m);
  else if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
app.on('open-url', (e, url) => { e.preventDefault(); openMailto(url); }); // macOS
app.setAsDefaultProtocolClient('mailto'); // offer Roammail as the default email app (the OS asks the person)

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 380, minHeight: 500, show: false, title: 'Roammail',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1b' : '#f4f7f9',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(pendingMailto ? composeUrl(pendingMailto) : `${BASE}/app`);
  pendingMailto = null;

  // Other websites open in the person's browser, never inside the app
  // (links meant for other people, like booking pages and protected emails, open in the browser too)
  win.webContents.setWindowOpenHandler(({ url }) => {
    const appPage = ours(url) && !/^\/(secure|book)\//.test(new URL(url).pathname);
    if (appPage) win.loadURL(url); else external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!inApp(url)) { e.preventDefault(); external(url); } });
  win.webContents.on('will-redirect', (e, url) => { if (!inApp(url)) { e.preventDefault(); external(url); } });

  // Unread count on the dock / taskbar, read from the page title: "(3) Inbox - you@roammail.net"
  win.on('page-title-updated', (_e, title) => {
    const n = Number((/^\((\d+)\)/.exec(title) || [])[1] || 0);
    app.setBadgeCount(n);
  });

  // No connection: a friendly page with a retry button
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { retry: url || `${BASE}/app` } });
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Only the permissions mail needs: notifications, writing to the clipboard, and full screen for videos
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(ours(wc.getURL()) && ['notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => !!wc && ours(wc.getURL()) && ['notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Email', accelerator: 'CmdOrCtrl+N', click: () => win?.loadURL(`${BASE}/app?compose=1`) },
      { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Roammail Help', click: () => external(`${BASE}/help`) }, { label: 'Privacy', click: () => external(`${BASE}/privacy`) }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); else win.show(); }); // macOS: click the dock icon
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Nothing in the app may create its own windows or webviews
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
