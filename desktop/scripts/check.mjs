// Quick checks run in CI before building: the security settings are in place and the build config is complete.
import fs from 'node:fs';
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const must = [[/contextIsolation:\s*true/, 'context isolation'], [/sandbox:\s*true/, 'sandbox'], [/nodeIntegration:\s*false/, 'no Node.js in the page'],
  [/setWindowOpenHandler/, 'new windows handled'], [/will-navigate/, 'navigation guarded'], [/requestSingleInstanceLock/, 'single instance'], [/setPermissionRequestHandler/, 'permissions limited']];
let bad = 0;
for (const [re, what] of must) if (!re.test(main)) { console.error(`missing: ${what}`); bad++; }
for (const k of ['appId', 'mac', 'win', 'linux', 'protocols']) if (!pkg.build?.[k]) { console.error(`build config missing: ${k}`); bad++; }
if (!fs.existsSync(new URL('../build/icon.png', import.meta.url))) { console.error('missing build/icon.png'); bad++; }
if (bad) process.exit(1);
console.log('desktop app checks passed');
