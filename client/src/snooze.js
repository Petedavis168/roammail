// Snooze / schedule presets (Gmail-style)
export function presets(kind = 'snooze') {
  const now = new Date();
  const at = (d, h, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
  const add = (days) => { const x = new Date(now); x.setDate(x.getDate() + days); return x; };
  const list = [];
  if (now.getHours() < 17) list.push([kind === 'snooze' ? 'Later today' : 'This afternoon', at(now, now.getHours() < 13 ? 13 : 18)]);
  list.push(['Tomorrow morning', at(add(1), 8)]);
  if (kind === 'send') list.push(['Tomorrow afternoon', at(add(1), 13)]);
  const sat = (6 - now.getDay() + 7) % 7 || 7;
  if (kind === 'snooze' && now.getDay() !== 6 && now.getDay() !== 0) list.push(['This weekend', at(add(sat), 9)]);
  const mon = (8 - now.getDay()) % 7 || 7;
  list.push(['Next week', at(add(mon), 8)]);
  return list.filter(([, d]) => d > now);
}
export const fmtWhen = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function localInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
