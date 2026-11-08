// Builds the 1024px source images that @capacitor/assets turns into every Android and iOS icon and splash size.
// Source: the white Roammail mark from the web app, centred on the brand blue.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
const BLUE = '#173D56', DARK = '#0F1418';
const mark = new URL('../src-art/mark-white.png', import.meta.url).pathname; // cut from site/assets/roammail-logo-full.png
mkdirSync(new URL('../assets', import.meta.url), { recursive: true });
const out = (f) => new URL(`../assets/${f}`, import.meta.url).pathname;
const canvas = (size, bg) => sharp({ create: { width: size, height: size, channels: 4, background: bg } });
const logo = async (w) => sharp(mark).resize({ width: w, kernel: 'lanczos3' }).png().toBuffer();
// App icon (full bleed, no transparency: Apple rejects alpha in the store icon)
await canvas(1024, BLUE).composite([{ input: await logo(600), gravity: 'center' }]).flatten({ background: BLUE }).png().toFile(out('icon-only.png'));
// Android adaptive icon: foreground inside the 66% safe zone, plain background
await canvas(1024, { r: 0, g: 0, b: 0, alpha: 0 }).composite([{ input: await logo(520), gravity: 'center' }]).png().toFile(out('icon-foreground.png'));
await canvas(1024, BLUE).png().toFile(out('icon-background.png'));
// Splash screens
await canvas(2732, BLUE).composite([{ input: await logo(700), gravity: 'center' }]).png().toFile(out('splash.png'));
await canvas(2732, DARK).composite([{ input: await logo(700), gravity: 'center' }]).png().toFile(out('splash-dark.png'));
console.log('assets/ ready');
