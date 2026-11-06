import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/** Loads the user's personal + company signatures once and exposes helpers. */
export function useSignatures() {
  const [data, setData] = useState(null);
  const reload = useCallback(() => api.get('/api/signature').then(setData).catch(() => setData({ personal: { signatures: [] }, org: null })), []);
  useEffect(() => { reload(); }, [reload]);
  return [data, reload];
}

/** HTML for a signature choice: 'company' | personal id | null */
export function signatureHtml(data, choice) {
  if (!data || !choice) return '';
  if (choice === 'company') return data.org?.mode === 'default' ? data.org.html : '';
  return data.personal?.signatures?.find((s) => s.id === choice)?.html || '';
}

/** Which signature to start a message with. Enforced company signatures are added by the server instead. */
export function defaultChoice(data, isReply) {
  if (!data) return null;
  const p = data.personal || {};
  const pick = isReply ? p.defaultReply : p.defaultNew;
  if (pick !== undefined && pick !== null) return pick;
  if (data.org?.mode === 'default' && (!isReply || data.org.onReplies)) return 'company';
  return null;
}
