import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { initNative } from './native.js';
import { startErrorReporting } from './errors.js';
import '@fontsource-variable/inter';
import './styles.css';

startErrorReporting(); // crashes in the browser or phone app reach the error alarm
initNative(); // phone apps (mobile/): links, attachments, notifications
createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);

// Service worker: offline mail and the app shell (web and phone apps); web push on the web (the apps use native push)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // keep this page and its code for offline use (signed-in app pages only)
  if (/^\/\d{8}\//.test(location.pathname) || /^\/\d{6}-\d{3}-[A-Z]{2}\//.test(location.pathname)) {
    navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'shell' })).catch(() => {});
  }
}
