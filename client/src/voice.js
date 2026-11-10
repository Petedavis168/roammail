// Spoken new-mail alert ("You've got mail!"), using the device's own text-to-speech voices. Plays while Roammail is
// open (browsers don't let a closed page make sounds; the phone's notification sound covers that).
export const PHRASES = ['You’ve got mail!', 'New mail!', 'You have new email.'];
let last = 0;
export const voices = () => (window.speechSynthesis ? speechSynthesis.getVoices() : []);
/** The cheeriest-sounding voice we can find, unless one was picked. */
function pickVoice(name) {
  const all = voices();
  if (name) { const v = all.find((x) => x.name === name); if (v) return v; }
  const en = all.filter((v) => /^en(-|_|$)/i.test(v.lang));
  return en.find((v) => /Samantha|Alex|Aaron|Google US English|Microsoft (Guy|Mark|David)|Daniel/i.test(v.name)) || en.find((v) => v.default) || en[0] || all[0] || null;
}
export function sayNewMail({ phrase, voice, force } = {}) {
  if (!window.speechSynthesis) return false;
  if (!force && Date.now() - last < 15000) return false; // a burst of mail = one announcement
  last = Date.now();
  const u = new SpeechSynthesisUtterance(phrase || PHRASES[0]);
  const v = pickVoice(voice); if (v) u.voice = v;
  u.rate = 0.95; u.pitch = 1.05; u.volume = 1;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
  return true;
}
