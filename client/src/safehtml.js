import DOMPurify from 'dompurify';

// Everything placed into the app's own page (compose editor, signature editors, previews) goes through here.
// Email display is separately isolated in a sandboxed iframe; this protects the main page itself.
const OPTS = {
  FORBID_TAGS: ['style', 'script', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset',
    'object', 'embed', 'link', 'meta', 'base', 'svg', 'math', 'template', 'audio', 'video', 'source', 'dialog'],
  FORBID_ATTR: ['id', 'name', 'srcset', 'formaction', 'action', 'autofocus', 'tabindex', 'contenteditable'],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid):|\/api\/attachment\?|\/sig-assets\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

export function safeHtml(html, { blockRemote = false } = {}) {
  let clean = DOMPurify.sanitize(String(html ?? ''), OPTS);
  if (blockRemote) {
    // Same privacy rule as the reading pane: no remote images or CSS backgrounds until the user allows them
    clean = clean.replace(/url\(\s*(?:&quot;|["'])?\s*(?:https?:)?\/\/[^)]*\)/gi, 'none')
      .replace(/<img\b([^>]*?)\ssrc=(["'])(?:https?:)?\/\/[^"']*\2([^>]*)>/gi, '<img$1 alt="[image]"$3>');
  }
  // Neutralize position/overlay tricks that could cover the app UI (fake login boxes)
  return clean.replace(/position\s*:\s*(fixed|absolute|sticky)/gi, 'position:static');
}

/** Paste handler for contentEditable areas: insert sanitized HTML instead of the browser's raw paste. */
export function onSafePaste(e, after) {
  const html = e.clipboardData?.getData('text/html');
  if (!html) return false;
  e.preventDefault();
  document.execCommand('insertHTML', false, safeHtml(html));
  after?.();
  return true;
}
