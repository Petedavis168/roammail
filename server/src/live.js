// Push a small live event to someone's open Roammail windows (set up by routes.js, which owns the live connections).
let sender = () => {};
export const setLiveSender = (fn) => { sender = fn; };
export const pushLive = (email, event, data) => { try { sender(String(email).toLowerCase(), event, data); } catch { /* not connected */ } };
