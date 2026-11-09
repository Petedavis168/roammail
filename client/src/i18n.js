// Languages: English (built in) and Spanish. t('English text') returns the text in the chosen language.
// The language follows the browser unless the person picks one in Settings → General.
import es from './locales/es.js';

const DICTS = { es };
export const LANGS = [['en', 'English'], ['es', 'Español']];
const pick = () => {
  const saved = localStorage.getItem('lang');
  if (saved && (saved === 'en' || DICTS[saved])) return saved;
  return /^es\b/i.test(navigator.language || '') ? 'es' : 'en';
};
export let lang = pick();
document.documentElement.lang = lang;
export function setLang(l) { localStorage.setItem('lang', l); location.reload(); }
export function t(s) { return (lang !== 'en' && DICTS[lang]?.[s]) || s; }
