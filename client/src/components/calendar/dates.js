export const DAY = 864e5;
export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const startOfWeek = (d) => addDays(startOfDay(d), -((new Date(d).getDay() + 6) % 7)); // weeks start Monday
export const startOfMonth = (d) => { const x = startOfDay(d); x.setDate(1); return x; };
export const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
export const fmt = (d, o) => new Date(d).toLocaleString([], o);
export const timeLabel = (d) => fmt(d, { hour: 'numeric', minute: '2-digit' });
export function localInput(d, dateOnly) {
  const x = new Date(d); const p = (n) => String(n).padStart(2, '0');
  const date = `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  return dateOnly ? date : `${date}T${p(x.getHours())}:${p(x.getMinutes())}`;
}
/** All-day events come back as YYYY-MM-DD (local dates); timed ones as ISO instants. */
export const evStart = (e) => (e.allDay ? new Date(`${e.start}T00:00:00`) : new Date(e.start));
export const evEnd = (e) => (e.allDay ? new Date(`${e.end}T00:00:00`) : new Date(e.end));
