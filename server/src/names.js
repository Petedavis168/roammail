// Anti-impersonation rule for free addresses: "john@roammail.net" looks like it belongs to Roammail (or to a specific
// trusted person), which scammers love. On the free domain, an address that is only a first name, even with dots,
// dashes or underscores (j.o.h.n), is reserved for Roammail staff, who get it through Admin → Staff addresses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'first-names.txt');
const NAMES = new Set(fs.readFileSync(FILE, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#')));
const EXTRA = new Set(String(process.env.STAFF_ONLY_NAMES || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean));

/** True when the address (local part) is just a first name. */
export const isBareFirstName = (local) => {
  const s = String(local || '').toLowerCase().replace(/[._-]/g, '');
  return NAMES.has(s) || EXTRA.has(s);
};
export const FIRST_NAME_HINT = 'Addresses that are only a first name are kept for Roammail staff, to protect people from scammers. Add your last name or an initial, like john.smith or johns.';
