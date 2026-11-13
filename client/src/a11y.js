// Accessibility helpers.
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/**
 * For pop-up windows: Escape closes it, Tab stays inside it, focus moves into it when it opens and goes back to
 * whatever was focused before when it closes. Put the returned ref on the dialog element.
 */
export function useDialog(onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector('[autofocus]') || el.querySelector(FOCUSABLE);
      (first || el).focus?.({ preventScroll: true });
    }
    const key = (e) => {
      if (!ref.current) return;
      if (e.key === 'Escape') {
        // only the top-most dialog closes
        const dialogs = [...document.querySelectorAll('[data-dialog]')];
        if (dialogs[dialogs.length - 1] !== ref.current) return;
        e.stopPropagation(); e.preventDefault(); closeRef.current?.();
      } else if (e.key === 'Tab') {
        const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0]; const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (before?.isConnected) before.focus?.({ preventScroll: true }); };
  }, []);
  return ref;
}
