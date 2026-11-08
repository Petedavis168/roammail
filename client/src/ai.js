// AI help status, shared by the reading pane, inbox and settings (fetched once, refreshed after changes).
import { api } from './api.js';

let cached = null;
const listeners = new Set();
export async function aiStatus(force) {
  if (!cached || force) cached = api.get('/api/ai/status').catch(() => ({ available: false }));
  return cached;
}
export async function setAiEnabled(on) {
  const s = await api.put('/api/ai/enabled', { on });
  cached = Promise.resolve(s);
  listeners.forEach((f) => f(s));
  return s;
}
export function onAiChange(f) { listeners.add(f); return () => listeners.delete(f); }
export const aiConsentText = 'AI help sends the emails you choose to summarise or reply to, and the first lines of unread inbox messages when you ask what needs a reply, to Anthropic (Claude) to produce the answer. Nothing is sent until you click an AI button, and Anthropic does not train on it.';
