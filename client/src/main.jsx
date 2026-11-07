import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import '@fontsource-variable/inter';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
