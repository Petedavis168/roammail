// Store screenshots from the local test stack (server/dev/start-stack.sh): a demo mailbox with sample mail,
// captured at iPhone 6.9" (1320x2868) and Android phone (1080x2340) sizes into mobile/store/screenshots/.
// Run: node mobile/scripts/screenshots.mjs   (BASE_URL defaults to http://localhost:3000)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const nodemailer = require('nodemailer');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PW = 'Shot-Demo-2026!x';
const OUT = new URL('../store/screenshots/', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'Content-Type': 'application/json', 'X-Forwarded-For': `198.18.${Date.now() % 250}.${1 + (process.pid % 250)}`, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) cookie = c.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
};

const username = `maya.carter${Date.now() % 100000}`;
const s = await call('POST', '/api/signup', { name: 'Maya Carter', username, password: PW, acceptTerms: true, birthday: '1988-04-12', recoveryEmail: 'maya@example.org', phone: '+15555550142' });
if (s.status !== 200) throw new Error(`signup ${s.status} ${JSON.stringify(s.data)}`);
const email = s.data.email;
await call('POST', '/api/setup/2fa/remind', {}); await call('POST', '/api/setup/step', { step: 'done' });
await sleep(1500);

const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: Number(process.env.SMTP_PORT || 3025), secure: false, tls: { rejectUnauthorized: false } });
const mail = [
  ['Daniel Ortiz', 'daniel@northwindbuilders.com', 'Site visit Thursday at 9:30', 'Hi Maya,\n\nConfirming Thursday at 9:30 for the walkthrough on Elm Street. I\'ll bring the updated plans and the tile samples you asked about.\n\nSee you then,\nDaniel'],
  ['Priya Shah', 'priya@brightlineaccounting.com', 'Q3 invoices are ready', 'Hi Maya,\n\nThe Q3 invoices are ready for your review. Everything reconciles except two small items I flagged in the notes.\n\nThanks!\nPriya'],
  ['Jordan Lee', 'jordan@lee-design.studio', 'New logo concepts', 'Morning! Three new logo directions are attached in the shared folder. My favourite is option B, but curious what you think.\n\nJordan'],
  ['Harbor Coffee Co.', 'orders@harborcoffee.com', 'Your order #4821 has shipped', 'Good news, your order is on its way and should arrive Friday.\n\nThanks for supporting a local roaster.'],
  ['Sam Rivera', 'sam.rivera@greenleafevents.com', 'Lunch next week?', 'Hey Maya, it\'s been too long. Free for lunch Tuesday or Wednesday? There\'s a new place on 5th I\'ve been wanting to try.\n\nSam'],
  ['Alex Kim', 'alex@kimlegal.com', 'Contract draft for review', 'Hi Maya,\n\nPlease find the draft service agreement below. The main changes are in sections 4 and 7. Happy to walk through it on a call.\n\nBest,\nAlex'],
];
for (const [name, from, subject, text] of mail.reverse()) { await smtp.sendMail({ from: `"${name}" <${from}>`, to: email, subject, text }); await sleep(250); }
await sleep(1500);

// a few events this week for the calendar shot
const cals = (await call('GET', '/api/calendars')).data;
const calHref = (Array.isArray(cals) ? cals : cals?.calendars || [])[0]?.href;
if (calHref) {
  const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const at = (day, h, m = 0) => { const d = new Date(monday); d.setDate(d.getDate() + day); d.setHours(h, m); return d.toISOString(); };
  for (const [day, h, m, len, title, location] of [[0, 9, 0, 1, 'Team stand-up', 'Office'], [1, 11, 0, 1.5, 'Client call: Northwind', ''], [2, 13, 0, 1, 'Lunch with Sam', '5th Street'], [3, 9, 30, 1.5, 'Site visit: Elm Street', '412 Elm St'], [4, 15, 0, 1, 'Q3 review with Priya', ''], [5, 10, 0, 2, 'Farmers market', '']]) {
    const start = at(day, h, m); const end = new Date(new Date(start).getTime() + len * 3600e3).toISOString();
    const r = await call('POST', '/api/calendar/events', { calendar: calHref, title, location, start, end, allDay: false, attendees: [], sendInvites: false });
    if (r.status !== 200) console.warn('event', r.status, r.data);
  }
}

const browser = await chromium.launch();
const shots = [
  { dir: 'iphone-6.9', viewport: { width: 440, height: 956 }, scale: 3, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', mobile: true },
  { dir: 'android-phone', viewport: { width: 360, height: 780 }, scale: 3, ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36', mobile: true },
];
const { hostname } = new URL(BASE);
for (const d of shots) {
  mkdirSync(`${OUT}${d.dir}`, { recursive: true });
  const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.scale, isMobile: d.mobile, hasTouch: true, userAgent: d.ua, colorScheme: 'light' });
  const [n, v] = cookie.split('=');
  await ctx.addCookies([{ name: n, value: v, domain: hostname, path: '/' }]);
  const page = await ctx.newPage();
  const snap = async (name) => { await sleep(900); await page.screenshot({ path: `${OUT}${d.dir}/${name}.png` }); console.log(`${d.dir}/${name}.png`); };
  await page.goto(`${BASE}/app`); await page.waitForSelector('text=Site visit Thursday', { timeout: 20000 });
  await snap('1-inbox');
  await page.click('text=Site visit Thursday'); await page.waitForSelector('text=walkthrough', { timeout: 10000 }).catch(() => {});
  await snap('2-message');
  const url = new URL(page.url()); const id = url.pathname.split('/')[1];
  await page.goto(`${BASE}/${id}/calendar`); await page.click('.cal-toolbar >> text=Day').catch(() => {});
  await page.waitForSelector('.cal-toolbar');
  for (let i = 0; i < 7; i++) { // step back to the day with the site visit
    await sleep(900); if (await page.locator('text=Site visit: Elm Street').count()) break;
    await page.click('.cal-toolbar .icon-btn[title^="Previous"]');
  }
  await snap('3-calendar');
  await page.goto(`${BASE}/${id}/inbox`); await page.waitForSelector('text=Site visit Thursday');
  const compose = page.locator('.compose-fab');
  if (await compose.count()) {
    await compose.click(); await sleep(600);
    await page.keyboard.type('priya@brightlineaccounting.com'); await page.keyboard.press('Enter');
    await page.locator('input[placeholder="Subject"], input[aria-label="Subject"]').first().fill('Re: Q3 invoices are ready').catch(() => {});
    await page.locator('[contenteditable="true"]').first().click().catch(() => {});
    await page.keyboard.type('Thanks Priya! I\'ll go through them tonight and send the two notes back by Friday.\n\nMaya');
    await snap('4-compose');
  }
  await ctx.close();
}
await browser.close();
console.log(`demo account: ${email}`);
