import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { t as tr } from '../i18n.js';

const Ctx = createContext(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const id = useRef(0);
  const dismiss = useCallback((tid) => setToasts((t) => t.filter((x) => x.id !== tid)), []);
  const toast = useCallback((message, { action, onAction, duration = 5000, error } = {}) => {
    const tid = ++id.current;
    setToasts((t) => [...t.slice(-3), { id: tid, message, action, onAction, error }]);
    if (duration) setTimeout(() => dismiss(tid), duration);
    return tid;
  }, [dismiss]);
  toast.dismiss = dismiss;

  return (
    <Ctx.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            <span>{t.message}</span>
            {t.action && <button onClick={() => { t.onAction?.(); dismiss(t.id); }}>{t.action}</button>}
            <button className="toast-x" onClick={() => dismiss(t.id)} aria-label={tr("Dismiss")}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
