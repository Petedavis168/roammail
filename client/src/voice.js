// New-mail alert: a soft two-note chime, then a spoken "You've got mail!" in the most natural voice the device has.
// Devices ship both robotic voices and natural (neural) ones; we rank them so the natural ones win:
//   Microsoft Edge "… Online (Natural)", Apple "Premium" / "Enhanced" / Siri voices, Google's voices, then the rest.
// Plays while Roammail is open (browsers don't let a closed page make sounds; the phone's notification covers that).
export const PHRASES = ['You’ve got mail!', 'New mail!', 'You have new email.'];
export const STYLES = [['voice', 'Chime + voice'], ['chime', 'Chime only'], ['speak', 'Voice only']];
let last = 0;

export const voices = () => (window.speechSynthesis ? speechSynthesis.getVoices() : []);

/** Higher = sounds more human. */
export function voiceQuality(v) {
  const n = `${v.name} ${v.voiceURI || ''}`;
  let s = 0;
  if (/natural|neural|online/i.test(n)) s += 60; // Microsoft Edge neural voices (Aria, Jenny, Guy, Ava, Andrew…)
  if (/premium/i.test(n)) s += 55; // Apple premium
  if (/enhanced|siri/i.test(n)) s += 45; // Apple enhanced / Siri
  if (/google/i.test(n)) s += 30; // Chrome's Google voices
  if (/\b(Ava|Andrew|Emma|Brian|Jenny|Aria|Guy|Samantha|Zoe|Evan|Nathan|Allison|Ava|Karen|Daniel|Serena)\b/i.test(n)) s += 10;
  if (/espeak|compact|eloquence|fred|albert|bad news|bells|boing|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|kathy|grandma|grandpa|rocko|shelley|flo|reed|sandy/i.test(n)) s -= 80; // novelty / robotic
  if (!v.localService) s += 5; // cloud voices are usually the neural ones
  if (/^en[-_]US/i.test(v.lang)) s += 4; else if (/^en/i.test(v.lang)) s += 2;
  return s;
}
export const naturalVoices = () => voices().filter((v) => /^en/i.test(v.lang)).sort((a, b) => voiceQuality(b) - voiceQuality(a));
export const isNatural = (v) => voiceQuality(v) >= 30;

function pickVoice(name) {
  const all = voices();
  if (name) { const v = all.find((x) => x.name === name); if (v) return v; }
  return naturalVoices()[0] || all[0] || null;
}

/** A soft, friendly two-note chime (made on the fly, no sound file). */
export function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return 0;
    const ctx = new Ctx();
    const note = (freq, at, dur) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2; const g2 = ctx.createGain(); g2.gain.value = 0.18; // a little shimmer
      o.connect(g); o2.connect(g2); g2.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + at;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.22, t0 + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.start(t0); o2.start(t0); o.stop(t0 + dur + 0.05); o2.stop(t0 + dur + 0.05);
    };
    note(880, 0, 0.35); // A5
    note(1318.5, 0.14, 0.55); // E6
    setTimeout(() => ctx.close().catch(() => {}), 1200);
    return 450;
  } catch { return 0; }
}

export function sayNewMail({ phrase, voice, style = 'voice', force } = {}) {
  if (!force && Date.now() - last < 15000) return false; // a burst of mail = one announcement
  last = Date.now();
  const wait = style === 'speak' ? 0 : chime();
  if (style === 'chime' || !window.speechSynthesis) return true;
  setTimeout(() => {
    const u = new SpeechSynthesisUtterance(phrase || PHRASES[0]);
    const v = pickVoice(voice); if (v) { u.voice = v; u.lang = v.lang; }
    // natural voices sound best at their own pace; robotic ones a touch slower and warmer
    const natural = v && isNatural(v);
    u.rate = natural ? 1.0 : 0.92; u.pitch = natural ? 1.0 : 1.08; u.volume = 1;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }, wait);
  return true;
}
