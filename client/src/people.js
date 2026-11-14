// Click any name or address to open that person's contact card (Mail.jsx shows it).
export function openCard(e, person) {
  e?.stopPropagation?.(); e?.preventDefault?.();
  if (!person?.address) return;
  window.dispatchEvent(new CustomEvent('roammail:card', { detail: { person: { address: person.address, name: person.name || '' }, anchor: e?.currentTarget || null } }));
}
