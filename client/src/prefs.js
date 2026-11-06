import { useEffect, useState } from 'react';

const DEFAULTS = {
  readingPane: 'right',      // right | bottom | off
  density: 'comfortable',    // comfortable | compact
  conversation: true,
  undoSeconds: 5,
  signature: '',
  displayName: '',
  showImages: 'ask',         // ask | always
  notifications: true,
  categories: [
    { name: 'Red', color: '#d13438' }, { name: 'Orange', color: '#ca5010' }, { name: 'Yellow', color: '#c19c00' },
    { name: 'Green', color: '#498205' }, { name: 'Blue', color: '#0f6cbd' }, { name: 'Purple', color: '#8764b8' },
  ],
  trustedSenders: [],
};

export function usePrefs(email) {
  const key = `prefs:${email}`;
  const [prefs, setPrefs] = useState(() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return DEFAULTS; }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(prefs)); }, [key, prefs]);
  const update = (patch) => setPrefs((p) => ({ ...p, ...(typeof patch === 'function' ? patch(p) : patch) }));
  return [prefs, update];
}

export const catKeyword = (name) => `cat_${name.replace(/[^A-Za-z0-9_-]/g, '')}`;
