// Natural dates for tasks: "Call Ann tomorrow 3pm", "Send report fri", "in 2 hours", "next week", "12/24 9am".
// parseWhen(text) finds a date phrase at the end (or start) of the text and returns { title, at, label }.
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_RE = '(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday)?';
const TIME_RE = '(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?';
const MORNING = 9; // default hour when only a day is given

function withTime(d, h, m, ap, fallback = MORNING) {
  let hour = h === undefined ? fallback : Number(h);
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  if (h !== undefined && !ap && hour >= 1 && hour <= 7) hour += 12; // "at 3" means 3 pm
  d.setHours(hour, Number(m || 0), 0, 0);
  return d;
}

const PATTERNS = [
  // in 3 days / in 2 hours / in 30 minutes / in a week
  [/\bin\s+(an?|\d+)\s+(minute|min|hour|hr|day|week|month)s?\b/i, (m, now) => {
    const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
    const unit = m[2].toLowerCase(); const d = new Date(now);
    if (/^min/.test(unit)) d.setMinutes(d.getMinutes() + n);
    else if (/^(hour|hr)/.test(unit)) d.setHours(d.getHours() + n);
    else if (unit === 'day') { d.setDate(d.getDate() + n); withTime(d); }
    else if (unit === 'week') { d.setDate(d.getDate() + 7 * n); withTime(d); }
    else { d.setMonth(d.getMonth() + n); withTime(d); }
    return d;
  }],
  [new RegExp(`\\b(today|tonight|tomorrow|tmrw|tmr)(?:\\s+${TIME_RE})?\\b`, 'i'), (m, now) => {
    const d = new Date(now); const w = m[1].toLowerCase();
    if (w.startsWith('tm') || w === 'tomorrow') d.setDate(d.getDate() + 1);
    return withTime(d, m[2], m[3], m[4]?.toLowerCase(), w === 'tonight' ? 20 : w === 'today' ? Math.min(23, now.getHours() + 3) : MORNING);
  }],
  [/\bnext\s+week\b/i, (m, now) => { const d = new Date(now); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return withTime(d); }],
  [/\b(this\s+)?weekend\b/i, (m, now) => { const d = new Date(now); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); return withTime(d, 10); }],
  [new RegExp(`\\b(next\\s+)?(${DAY_RE})(?:\\s+${TIME_RE})?\\b`, 'i'), (m, now) => {
    const name = m[2].toLowerCase().slice(0, 3);
    const target = DAYS.findIndex((x) => x.startsWith(name));
    const d = new Date(now); let add = (target - d.getDay() + 7) % 7 || 7;
    if (m[1]) add += add < 7 ? 7 : 0;
    d.setDate(d.getDate() + add);
    return withTime(d, m[3], m[4], m[5]?.toLowerCase());
  }],
  // 12/24, 24/12 is ambiguous: month/day like the US browser locale; also "dec 24"
  [new RegExp(`\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?(?:\\s+${TIME_RE})?\\b`, 'i'), (m, now) => {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getFullYear();
    const d = withTime(new Date(y, Number(m[1]) - 1, Number(m[2])), m[4], m[5], m[6]?.toLowerCase());
    if (!m[3] && d < now) d.setFullYear(d.getFullYear() + 1);
    return Number.isNaN(d.getTime()) ? null : d;
  }],
  [new RegExp(`\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+(\\d{1,2})(?:\\s+${TIME_RE})?\\b`, 'i'), (m, now) => {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase().slice(0, 3));
    const d = withTime(new Date(now.getFullYear(), mon, Number(m[2])), m[3], m[4], m[5]?.toLowerCase());
    if (d < now) d.setFullYear(d.getFullYear() + 1);
    return d;
  }],
  // just a time: "at 3pm" / "5pm" (today, or tomorrow if already past)
  [/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (m, now) => {
    const d = withTime(new Date(now), m[1], m[2], m[3].toLowerCase());
    if (d < now) d.setDate(d.getDate() + 1);
    return d;
  }],
];

export function parseWhen(text, now = new Date()) {
  const s = String(text || '');
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const at = fn(m, now);
    if (!at || Number.isNaN(at.getTime())) continue;
    const title = `${s.slice(0, m.index)}${s.slice(m.index + m[0].length)}`.replace(/\s+(on|by|due)\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
    return { title: title || s.trim(), at: at.getTime(), label: fmtDue(at.getTime(), now) };
  }
  return { title: s.trim(), at: null, label: '' };
}

export function fmtDue(ms, now = new Date()) {
  if (!ms) return '';
  const d = new Date(ms);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 864e5);
  const time = d.getHours() || d.getMinutes() ? d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined }) : '';
  const name = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
    : diff > 1 && diff < 7 ? d.toLocaleDateString([], { weekday: 'long' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  return time ? `${name} ${time}` : name;
}
