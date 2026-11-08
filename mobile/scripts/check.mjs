// Quick consistency check (runs in CI before the store builds; needs no Android SDK or Xcode).
import { readFileSync, existsSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fail = []; const ok = (cond, msg) => { if (!cond) fail.push(msg); };
const cfg = JSON.parse(read('capacitor.config.json'));
const id = cfg.appId;
ok(/^[a-z]+(\.[a-z0-9]+)+$/.test(id), `appId looks wrong: ${id}`);
ok(read('android/app/build.gradle').includes(`applicationId "${id}"`), 'Android applicationId differs from capacitor.config.json');
ok(read('ios/App/App.xcodeproj/project.pbxproj').split(`PRODUCT_BUNDLE_IDENTIFIER = ${id};`).length - 1 === 2, 'iOS bundle id differs from capacitor.config.json');
ok(read('ios/App/App.xcodeproj/project.pbxproj').includes('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;'), 'iOS entitlements not wired');
const ent = read('ios/App/App/App.entitlements');
ok(ent.includes('aps-environment') && ent.includes('applinks:roammail.net'), 'iOS entitlements missing push or app links');
ok(read('ios/App/App/AppDelegate.swift').includes('capacitorDidRegisterForRemoteNotifications'), 'iOS AppDelegate does not forward the push token');
const plist = read('ios/App/App/Info.plist');
for (const k of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'ITSAppUsesNonExemptEncryption']) ok(plist.includes(k), `Info.plist missing ${k}`);
const manifest = read('android/app/src/main/AndroidManifest.xml');
ok(manifest.includes('android:host="roammail.net"'), 'Android App Links intent filter missing');
ok(manifest.includes('POST_NOTIFICATIONS'), 'Android 13+ notification permission missing');
const host = new URL(cfg.server.url).hostname;
ok(cfg.server.allowNavigation.includes(host) && cfg.server.allowNavigation.includes(`login.${host}`), 'allowNavigation must include the app and login hosts');
ok(existsSync(new URL(`../www/${cfg.server.errorPath}`, import.meta.url)), 'offline page missing');
ok(existsSync(new URL('../assets/icon-only.png', import.meta.url)), 'icon source missing (npm run assets)');
if (fail.length) { console.error(`✗ ${fail.join('\n✗ ')}`); process.exit(1); }
console.log(`✓ ${id} → ${cfg.server.url}: Android and iOS projects consistent`);
