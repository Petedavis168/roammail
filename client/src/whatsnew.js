// "What's new" in the app: newest first. Add an entry with each release people would notice.
// id must only ever grow; the dot on the help button shows while there's an entry newer than the last one seen.
export const WHATS_NEW = [
  { id: 6, date: '2026-11-13', title: 'Faster everything', body: 'The app downloads 4× less, your inbox shows instantly when you come back to it, and the next unread emails open the moment you click.' },
  { id: 5, date: '2026-11-13', title: 'Help, right here', body: 'Press the ? button any time to ask a question, read a guide or reach our team, without leaving your mail.' },
  { id: 4, date: '2026-11-12', title: 'Disappearing emails', body: 'In a new email, open ⋯ → Disappearing email. Choose 1 hour, a day, a week, or gone after it’s read.', link: 'disappearing' },
  { id: 3, date: '2026-11-12', title: 'Smart reminders and Read later', body: 'Write “I’ll send it Friday” and we offer a reminder. Save anything for later with ⋯ → Read later.', link: 'read-later' },
  { id: 2, date: '2026-11-11', title: 'Private between Roammail users', body: 'Email between two Roammail addresses never leaves our servers. Look for the Private badge.', link: 'private-badge' },
  { id: 1, date: '2026-11-10', title: 'Refer a friend, get a month free', body: 'Settings → Refer a friend. When they join and use their account for a week, you both get a month of Premium.', link: 'refer' },
];
const KEY = 'whatsnew-seen';
export const unseenCount = () => { const seen = Number(localStorage.getItem(KEY) || 0); return WHATS_NEW.filter((x) => x.id > seen).length; };
export const markSeen = () => localStorage.setItem(KEY, String(WHATS_NEW[0]?.id || 0));
