// Smart reminders: spot promises in an email you're sending ("I'll send the contract by Friday") and offer to remind
// you. Runs on the device only; nothing is sent anywhere.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const VERB = "(send|get back to you|get back|call|ring|follow up|share|have|finish|review|look (into|at)|check|confirm|update you|reply|email|forward|prepare|draft|sign|pay|book|schedule)";
const WHEN = '(today|tonight|this afternoon|tomorrow|(?:by|on|before|first thing) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|eod|end of (?:the )?day|end of (?:the )?week|the weekend)|next week|this week|end of (?:the )?week|later today|monday|tuesday|wednesday|thursday|friday)';
const RE = new RegExp(`\\b(?:i'?ll|i will|i'm going to|i am going to|we'll|we will|let me)\\s+(?:\\w+\\s+){0,3}?${VERB}\\b([^.!?\\n]{0,80}?)\\b${WHEN}\\b`, 'i');

const at = (d, h, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
/** When the promise is due, from the words used. */
export function dueFrom(word, now = new Date()) {
  const w = word.toLowerCase();
  if (/today|tonight|this afternoon|eod|end of (the )?day|later today/.test(w)) return at(now, now.getHours() < 15 ? 16 : Math.min(21, now.getHours() + 2));
  if (/tomorrow/.test(w)) { const d = new Date(now); d.setDate(d.getDate() + 1); return at(d, 9); }
  if (/next week/.test(w)) { const d = new Date(now); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return at(d, 9); }
  if (/this week|end of (the )?week|weekend/.test(w)) { const d = new Date(now); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7)); return at(d, 14); }
  const day = DAYS.findIndex((x) => w.includes(x));
  if (day >= 0) { const d = new Date(now); d.setDate(d.getDate() + (((day - d.getDay() + 7) % 7) || 7)); return at(d, 9); }
  return null;
}

/** The first promise in what I wrote (not the quoted part), with when it's due. */
export function findPromise(text, now = new Date()) {
  const mine = String(text || '').split(/\n(?:On .{4,200} wrote:|-{2,} ?(?:Original|Forwarded) message)/)[0].replace(/^>.*$/gm, '').slice(0, 5000);
  const m = RE.exec(mine);
  if (!m) return null;
  const due = dueFrom(m[m.length - 1], now);
  if (!due || due < now) return null;
  const sentence = mine.slice(Math.max(0, mine.lastIndexOf('\n', m.index) + 1), m.index + m[0].length).trim().replace(/\s+/g, ' ');
  return { text: sentence.slice(0, 140), due: due.getTime() };
}
