import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { api } from '../api.js';
import { escapeHtml } from '../util.js';

// Render an email safely: sanitized HTML in a sandboxed iframe (no scripts),
// remote images blocked until the user allows them (privacy / tracking pixels).
export function prepareHtml(msg, allowRemote, disableLinks) {
  let blocked = 0;
  const cidMap = Object.fromEntries((msg.attachments || []).filter((a) => a.cid).map((a) => [a.cid, api.attachmentUrl(msg.folder, msg.uid, a.index, true)]));
  const source = msg.html || `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${linkify(escapeHtml(msg.text || ''))}</pre>`;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer');
      if (disableLinks && node.hasAttribute('href')) {
        node.setAttribute('title', `Link disabled because this message is in Junk: ${node.getAttribute('href')}`);
        node.removeAttribute('href');
        node.setAttribute('style', `${node.getAttribute('style') || ''};color:#888;text-decoration:line-through;cursor:not-allowed`);
      }
    }
    for (const attr of ['src', 'background', 'poster']) {
      const v = node.getAttribute?.(attr);
      if (!v) continue;
      if (v.startsWith('cid:')) node.setAttribute(attr, cidMap[v.slice(4)] || '');
      else if (/^https?:/i.test(v) && !allowRemote) { node.setAttribute(`data-blocked-${attr}`, v); node.removeAttribute(attr); blocked++; }
    }
    if (node.hasAttribute?.('srcset') && !allowRemote) { node.removeAttribute('srcset'); }
    const style = node.getAttribute?.('style');
    if (style && !allowRemote && /url\(\s*['"]?https?:/i.test(style)) { node.setAttribute('style', style.replace(/url\(\s*['"]?https?:[^)]*\)/gi, 'none')); blocked++; }
  });
  let clean = DOMPurify.sanitize(source, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style'], FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select'], ADD_ATTR: ['target'] });
  DOMPurify.removeHook('afterSanitizeAttributes');
  if (!allowRemote) clean = clean.replace(/url\(\s*['"]?https?:[^)]*\)/gi, () => { blocked++; return 'none'; });
  return { html: clean, blocked };
}

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}

const BASE_CSS = `<style>
  html,body{margin:0;padding:0;background:#fff;color:#1f1f1f;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
  body{padding:2px}
  img{max-width:100%;height:auto}
  blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555}
  pre{white-space:pre-wrap}
  table{max-width:100%}
</style>`;

export default function MessageBody({ msg, allowRemote, onBlocked, disableLinks }) {
  const ref = useRef();
  const [height, setHeight] = useState(120);
  const { html, blocked } = useMemo(() => prepareHtml(msg, allowRemote, disableLinks), [msg, allowRemote, disableLinks]);
  useEffect(() => { onBlocked?.(blocked); }, [blocked, onBlocked]);

  const srcDoc = html.replace(/<head>/i, `<head><base target="_blank">${BASE_CSS}`);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro;
    const fit = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      setHeight(Math.max(60, doc.documentElement.scrollHeight + 4));
    };
    const onLoad = () => {
      fit();
      const doc = frame.contentDocument;
      doc?.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
      if (doc?.body) { ro = new ResizeObserver(fit); ro.observe(doc.body); }
    };
    frame.addEventListener('load', onLoad);
    return () => { frame.removeEventListener('load', onLoad); ro?.disconnect(); };
  }, [srcDoc]);

  return (
    <iframe ref={ref} className="msg-frame" title="Message content" srcDoc={srcDoc} style={{ height }}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" />
  );
}
