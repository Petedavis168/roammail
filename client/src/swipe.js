// Phone gestures for the message list: swipe a row left or right to act on it (what each side does is a
// setting), and pull down at the top to check for new mail. Touch only; mouse and keyboard work as before.
const SWIPE_AT = 0.32; // fraction of the row width that counts as a swipe
const PULL_AT = 70;

export const SWIPE_ACTIONS = [['archive', 'Archive', 'archive'], ['del', 'Delete', 'trash'], ['read', 'Read / unread', 'mail'], ['snooze', 'Snooze', 'clock'], ['flag', 'Flag', 'flag'], ['none', 'Nothing', null]];

/** Attach to the scrolling list. getRow(el) -> message for a .row element; onSwipe(message, 'left'|'right'). */
export function attachGestures(list, { getRow, onSwipe, onRefresh, labels }) {
  let start = null; let row = null; let dir = null; let pulling = false;
  const reset = () => {
    if (row) { row.style.removeProperty('--dx'); row.classList.remove('swiping', 'swipe-left', 'swipe-right', 'swipe-go'); }
    list.style.removeProperty('--pull'); list.classList.remove('pulling', 'pull-go');
    start = null; row = null; dir = null; pulling = false;
  };
  const down = (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, at: Date.now(), top: list.scrollTop };
    row = e.target.closest('.row');
  };
  const move = (e) => {
    if (!start) return;
    const t = e.touches[0]; const dx = t.clientX - start.x; const dy = t.clientY - start.y;
    if (!dir) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      dir = Math.abs(dx) > Math.abs(dy) * 1.3 && row ? 'h' : 'v';
      if (dir === 'v' && dy > 0 && start.top <= 0 && onRefresh) pulling = true;
    }
    if (dir === 'h') {
      e.preventDefault(); // keep the page from scrolling sideways
      const side = dx < 0 ? 'left' : 'right';
      if (!labels[side]) return;
      row.classList.add('swiping'); row.classList.toggle('swipe-left', dx < 0); row.classList.toggle('swipe-right', dx > 0);
      row.dataset.swipeLabel = labels[side];
      row.style.setProperty('--dx', `${dx}px`);
      row.classList.toggle('swipe-go', Math.abs(dx) > row.offsetWidth * SWIPE_AT);
    } else if (pulling) {
      const p = Math.max(0, Math.min(110, dy * 0.55));
      list.classList.add('pulling'); list.style.setProperty('--pull', `${p}px`); list.classList.toggle('pull-go', p >= PULL_AT * 0.8);
    }
  };
  const up = () => {
    if (dir === 'h' && row?.classList.contains('swipe-go')) {
      const side = row.classList.contains('swipe-left') ? 'left' : 'right';
      const m = getRow(row);
      if (m) { row.classList.add('swiped'); setTimeout(() => onSwipe(m, side), 120); }
    } else if (pulling && list.classList.contains('pull-go')) onRefresh();
    reset();
  };
  list.addEventListener('touchstart', down, { passive: true });
  list.addEventListener('touchmove', move, { passive: false });
  list.addEventListener('touchend', up);
  list.addEventListener('touchcancel', reset);
  return () => { list.removeEventListener('touchstart', down); list.removeEventListener('touchmove', move); list.removeEventListener('touchend', up); list.removeEventListener('touchcancel', reset); };
}
