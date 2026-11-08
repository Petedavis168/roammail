import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { initNative, isNative } from './native.js';
import { startErrorReporting } from './errors.js';
import '@fontsource-variable/inter';
import './styles.css';

startErrorReporting(); // crashes in the browser or phone app reach the error alarm
initNative(); // phone apps (mobile/): links, attachments, notifications
createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);

// The phone apps use native push instead of the web service worker
if (!isNative() && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
