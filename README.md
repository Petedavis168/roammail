# Mail — a modern webmail + business email platform for mailcow

A fast web email client that feels like Outlook and Gmail combined, plus self-service
sign-up, one-page business domain setup, and an admin portal. It runs on top of your
existing **mailcow** server (IMAP/SMTP for mail, the mailcow API for accounts).

## What's in it

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
- Super-admin "Platform" portal: stats, turn sign-ups on/off, suspend businesses, change user limits,
  review and suspend new free accounts

## Deploy on AWS (recommended: a separate small EC2 instance)

1. **mailcow prep** (in the mailcow admin UI)
   - *System → Configuration → Access → API*: enable a **read-write** API key and allow the new server's IP.
   - *System → Configuration → Options → Fail2ban parameters*: add the new server's IP to the
     **whitelist**. All logins come from this server, so without this a few wrong passwords could
     get it banned and lock everyone out.
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

## Security notes
- Users can only log in to the IMAP/SMTP server configured in `.env` (no open relay or SSRF).
- Domain ownership must be proven by DNS TXT before a domain is created in mailcow, and big
  providers (gmail.com, outlook.com…) are blocked. Without this, someone could claim a domain
  your server would then treat as local.
- Business admins can only manage domains in their own organization; every admin action is audit-logged.
