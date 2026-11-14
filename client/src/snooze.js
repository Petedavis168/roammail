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

/**
 * "Send when they're most likely to read it": from the times this person usually writes to you, pick the next
 * slot in the coming week when they're most active (sent ~10 minutes before, so it's at the top of their inbox).
 * Not enough history: a weekday morning, when most email gets read.
 */
export function bestSendTime(times, now = new Date()) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const t of times || []) { const d = new Date(t); grid[d.getDay()][d.getHours()] += 1; }
  const n = (times || []).length;
  const hourTotal = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) for (let w = 0; w < 7; w++) hourTotal[h] += grid[w][h];
  const score = (w, h) => grid[w][h] * 2 + (grid[w][(h + 23) % 24] + grid[w][(h + 1) % 24]) * 0.7 + hourTotal[h] * 0.35;
  const earliest = new Date(now.getTime() + 30 * 60e3);
  let best = null;
  if (n >= 4) {
    for (let i = 0; i < 7 * 24; i++) {
      const slot = new Date(now); slot.setMinutes(0, 0, 0); slot.setHours(slot.getHours() + i + 1);
      const send = new Date(slot.getTime() - 10 * 60e3);
      if (send < earliest) continue;
      const s = score(slot.getDay(), slot.getHours());
      if (s > 0 && (!best || s > best.s + 0.01)) best = { s, at: send, hour: slot.getHours() };
    }
  }
  if (best) return { at: best.at.getTime(), usual: true, hour: best.hour, count: n };
  const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 50, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return { at: d.getTime(), usual: false, hour: 9, count: n };
}
