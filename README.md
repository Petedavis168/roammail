# Roammail: email, calendar and contacts for mailcow

*Your business. Delivered.* Powered by Friendly Web Services.

A fast web email client that feels like Outlook and Gmail combined, plus self-service
sign-up, one-page business domain setup, and an admin portal. It runs on top of your
existing **mailcow** server (IMAP/SMTP for mail, the mailcow API for accounts).

## What's in it

**New in this version:** Gmail-style sign-in and sign-up with address availability (@roammail.net), calendar
(month/week/day, repeating events, reminders, invitations with Yes/Maybe/No), contacts (import/export, company
directory), unlimited groups and departments with distribution lists and "send as group", and business billing
(Friendly Web Services customers: first mailbox free; then $4 per user per month or $48 per year, via Stripe).


**Email (Outlook + Gmail)**
- 3-pane layout: folders · message list · reading pane (right, bottom, or off)
- Outlook-style command ribbon, folder tree, drag & drop to folders, colored categories, flags
- Gmail-style conversation view (your replies from Sent are threaded in), floating compose windows,
  undo send, undo archive/delete, hover actions, search operators, keyboard shortcuts (press `?`)
- Rich-text compose, attachments (button, drag & drop, paste), Cc/Bcc, contact autocomplete,
  auto-saved drafts, signatures, high importance, "forgot the attachment?" check
- Reply / reply all / forward (forward keeps the original attachments)
- Live new-mail updates (IMAP IDLE) and desktop notifications
- Privacy: HTML mail is sanitized and sandboxed; remote images/trackers blocked until you allow them
- Dark mode, compact density, mobile layout

- **Schedule send** (presets or pick a time; Scheduled view to edit/cancel) and **Snooze** (comes back unread at the top)
- **Signatures:** several rich signatures per person (logos, links), separate defaults for new mail and replies,
  switch while writing, "copy for Outlook / phone"
- **Automatic replies** (out of office, with dates and "only my organization"), **Rules** (move, mark read, flag,
  categorize, forward, junk, delete) and **Block sender**. These run on the server (Sieve), so they work in every app.
- **Import mail** from Gmail, Outlook, Yahoo, iCloud or any IMAP account (keeps syncing until stopped)
- **Junk & spam, the mailcow way.** Probable spam lands in **Junk Email** with a "Why is this in Junk?" explanation
  (from rspamd's scores), and links and pictures are turned off. Definite spam is held in the server's **Spam
  quarantine**, where you get a safe text-only preview, release, "not spam", delete, a virus warning and a daily
  summary email. Strictness presets (Relaxed / Standard / Strict / Custom) set mailcow's spam scores. **Safe senders**
  and **Blocked senders** are mailcow's own allow and block lists, so they work in every app. "Not junk" offers to
  trust the sender, and moving mail in or out of Junk trains the filter. Business admins get company-wide safe and
  blocked senders, a team quarantine, and "apply strictness to everyone", which new hires inherit.
- Rules always send spam to Junk first (mailcow files spam *after* user filters, so a rule could otherwise rescue
  spam or auto-reply to it). Settings → Rules → Advanced shows every mailcow Sieve filter on the mailbox.
- **Phishing protection:** warnings for failed SPF/DKIM/DMARC, display-name spoofing, odd Reply-To, fake
  "internal" mail; **External** tag for business users; verified-sender lock
- **One-scan phone setup:** Settings → Phone & apps shows a QR code. On iPhone/iPad/Mac it installs a configuration
  profile with mail, calendar and contacts and the password already filled in (single-use link, 15 minutes). Android
  gets a page tailored to the device (self-configuring apps, exact Gmail-app settings with copy buttons, or the web app).
  Admins get a QR on the "User created" screen to set up a new hire's phone on the spot, and every welcome email has a
  "Set up on my phone" button. The domain wizard also adds SRV records so apps find the server by themselves.
- Welcome email with setup tips in every new mailbox; installable as an app (PWA) on phones and desktops

**Search operators:** `from:` `to:` `cc:` `subject:` `has:attachment` `is:unread` `is:read` `is:starred`
`newer_than:7d` `older_than:1y` `before:2026-01-01` `after:` `larger:5M` `smaller:` `label:Red` `in:sent` `-word` `"exact phrase"`

**Accounts & admin**
- Free sign-up: anyone can create `name@SIGNUP_DOMAIN` (rate limits, reserved names, quota,
  per-account send limit, optional Cloudflare Turnstile captcha)
- Business email wizard: enter a domain → add 1 TXT record to prove ownership → the app creates the
  domain in mailcow with DKIM → shows every DNS record (MX, SPF, DKIM, DMARC, autodiscover) with
  copy buttons and live ✓ checks
- Domains hosted in **your AWS Route 53**: one click adds all records (super-admin)
- Business admin portal: users (create, reset password, quota, suspend, make admin, delete),
  aliases (`sales@` → several people), domains, activity log
- **Company signature ("global signature"):** one template for the whole business with fields (name, title,
  department, phone, mobile, company, website, address, logo). Every user, including each new hire the moment
  they're added, gets it filled in. Modes: off / default (people can switch) / required (added server-side, can't be
  removed). Optional on replies. Starter templates, logo upload, live preview as any employee.
- Employee details (job title, department, phone, mobile) set when adding a user; people can update their own phones
- Super-admin "Platform" portal: stats, turn sign-ups on/off, suspend businesses, change user limits,
  review and suspend new free accounts

## Deploy on AWS: one command (recommended)

See **[deploy/aws/README.md](deploy/aws/README.md)**. In AWS CloudShell: fill in `deploy/aws/config.env`, run
`./deploy/aws/deploy.sh`. It builds the server, encrypted data disk, daily backups, fixed IP, HTTPS, alarms and logs,
and later updates go out with the same command (with automatic rollback).

## Deploy on AWS by hand (a separate small EC2 instance)

1. **mailcow prep** (in the mailcow admin UI)
   - *System → Configuration → Access → API*: enable a **read-write** API key and allow the new server's IP.
   - *System → Configuration → Options → Fail2ban parameters*: add the new server's IP to the
     **whitelist**. All logins come from this server, so without this a few wrong passwords could
     get it banned and lock everyone out.
   - *System → Configuration → Quarantine*: make sure quarantine is enabled (retention > 0), or definite spam is simply
     rejected and the Spam quarantine view stays empty.
   - The API key is also used for rules and auto-replies (Sieve filters), mail import (sync jobs) and password changes.
   - Create the domain you'll use for free sign-ups (e.g. `yourdomain.com`) if it doesn't exist.
2. **Launch EC2**: Ubuntu 24.04, `t3.small` is plenty to start. Security group: allow 22 (your IP), 80, 443.
   Paste `deploy/aws/user-data.sh` into *Advanced details → User data* (installs Docker).
   Attach an **Elastic IP**.
   - Optional Route 53 one-click DNS: create an IAM role with `deploy/aws/route53-policy.json`,
     attach it to the instance, and set `ROUTE53_ENABLED=true`.
3. **DNS**: create an A record `webmail.yourdomain.com` → the Elastic IP.
4. **Install**
   ```bash
   # copy this folder to /opt/mail-client on the server (git clone or scp), then:
   cd /opt/mail-client
   cp .env.example .env
   nano .env          # fill in hosts, MAILCOW_API_KEY, SESSION_SECRET (openssl rand -hex 32), SUPERADMIN_EMAILS...
   docker compose up -d --build
   ```
   Caddy gets a Let's Encrypt certificate automatically. Open `https://webmail.yourdomain.com`.

**Same machine as mailcow instead?** mailcow's nginx already uses 80/443. See
`deploy/mailcow-same-server-nginx.conf` for the 4-step setup.

**Updating:** `git pull && docker compose up -d --build`. App data (orgs, domains, audit log) lives in the
`appdata` Docker volume (SQLite). Back it up with your mailcow backups.

## Phone & Outlook auto-configuration checklist
- Business domains: add the optional `autodiscover`/`autoconfig` CNAMEs and SRV records from the domain wizard
  (mailcow answers those requests, which is what Outlook, Thunderbird and many Android apps use).
- Do the same for your free sign-up domain (mailcow UI → your domain → DNS shows the records).
- For a "Verified" iPhone profile set `PROFILE_SIGN_CERT`/`PROFILE_SIGN_KEY` (any publicly trusted certificate,
  e.g. the mail server's Let's Encrypt cert).

## Local development

```bash
docker run -d --name gm -p 3025:3025 -p 3143:3143 greenmail/standalone:2.1.2   # fake mail server
cd server && npm install && node dev/mock-mailcow.js &                            # fake mailcow API
node --env-file=dev/test.env --disable-warning=ExperimentalWarning src/index.js &
node dev/seed.js                                                                  # demo messages
cd ../client && npm install && npm run dev                                        # http://localhost:5173
```
Sign up as `owner` (it's the super-admin in `dev/test.env`).

## Architecture

- `server/` — Node.js + Express. `imapflow` (IMAP, IDLE), `nodemailer` (SMTP), `mailparser`.
  Each signed-in session has a pooled IMAP connection. The session is an AES-256-GCM encrypted,
  httpOnly, SameSite=strict cookie, so no mail passwords are stored in a database. Write requests
  require a custom header (CSRF protection). Helmet CSP, login and sign-up rate limits.
- `server/src/accounts.js` — sign-up, domains, admin APIs; `mailcow.js` (mailcow REST API client),
  `dns.js` (record checks via public resolvers), `route53.js`, `db.js` (SQLite via `node:sqlite`).
- `client/` — React + Vite, no UI framework. Email HTML is rendered with DOMPurify in a sandboxed iframe.

## Security

See **[SECURITY.md](SECURITY.md)** for the full threat model, known limitations and the operator checklist.
Automated tests: `npm test` (unit), `npm run test:api` and `npm run test:e2e` (against a running stack) in `server/`;
GitHub Actions runs all of them plus a dependency audit, CodeQL and a hardened-container check on every change.

## Account security

- **2-step verification** (authenticator app, TOTP) with 10 single-use backup codes
- **Lockout:** 10 wrong passwords or codes lock the account for 15 minutes, on top of per-IP rate limits
- **Sign-in history** (device, IP, failed attempts) and **sign out of all other devices**
- **Password change** in the app signs out every other device; admin password resets do the same
- **Forgot password** via a recovery email (needs `SYSTEM_MAIL_*`); reset links are single use, expire in 30 minutes,
  and the request page never reveals whether an account exists
- Free accounts: captcha (Turnstile), per-IP limits, reserved names, a send-rate limit, and no forwarding rules
  (forwarding is a classic hijacked-account trick)
- Schedule send and snooze keep the user's credentials sealed (AES-256-GCM) inside the job until it runs, then delete them
- Note: 2-step verification protects sign-in to this webmail. Desktop and phone apps sign in to mailcow directly
  with the password. For those, recommend mailcow app passwords (mailcow UI → Mailbox → App passwords).

## Security notes
- Users can only log in to the IMAP/SMTP server configured in `.env` (no open relay or SSRF).
- Domain ownership must be proven by DNS TXT before a domain is created in mailcow, and big
  providers (gmail.com, outlook.com…) are blocked. Without this, someone could claim a domain
  your server would then treat as local.
- Business admins can only manage domains in their own organization; every admin action is audit-logged.
