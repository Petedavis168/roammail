// The only thing the page learns about the desktop app: that it is one, and which system it runs on.
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('roammailDesktop', { platform: process.platform, version: process.versions.electron ? 'desktop' : '' });
