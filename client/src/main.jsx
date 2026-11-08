import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initNative, isNative } from './native.js';
import '@fontsource-variable/inter';
import './styles.css';

initNative(); // phone apps (mobile/): links, attachments, notifications
createRoot(document.getElementById('root')).render(<App />);

// The phone apps use native push instead of the web service worker
if (!isNative() && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
