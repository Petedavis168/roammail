# Running Roammail on the roammail-prod ECS stack (us-east-2)

Image: `515579969872.dkr.ecr.us-east-2.amazonaws.com/roammail-app:2c1b1b5` (also tagged `latest`).
Digest `sha256:49ec18703a6e22eed9290bf54e7609f629862268958daaa23d33298366222dd2`.
Pricing: US$4/mailbox/month, US$44/year (live Stripe prices built in). All mail, calendar and contacts: mailcow at `MAILCOW_HOST` (mail.fwdapps.cloud).

## Answers to the infra questions

| | Value |
|---|---|
| Container port | **3000** (the app runs as a non-root user, so it can't bind to 80) |
| Health check path | **`/healthz`** → 200 `{"ok":true}`. It answers on any Host header, so the target group check works. |
| Web command | the image default (`node server/src/index.js`) with `ROLE=web` |
| Worker command | **the same image and command** with `ROLE=worker`. The worker runs scheduled sends, snoozes, push notifications, billing checks, the spam watchdog and clean-up. Run exactly one. |

## Changes to the task definitions

**Both web and worker:**
- `image`: the ECR image above. `portMappings`: containerPort **3000** (web only).
- Keep: `ROLE`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSSLMODE=require`, `PGUSER`/`PGPASSWORD` secrets, `SESSION_SECRET` secret, `NODE_ENV`, `MAILCOW_HOST`, `APP_URL`.
  - The app reads the `PG*` variables directly, with verified TLS (the RDS CA is built into the image).
  - `ROOT_DOMAIN=roammail.net` is worked out from `APP_URL=https://app.roammail.net`. Free sign-ups get @roammail.net, and sign-in is login.roammail.net.
- Remove `PORT=80` (the default is 3000), or set `PORT=3000`.
- **Add these secrets** (the app won't work without them). Store them in `roammail/app`:
  - `PROVISIONER_SECRET`: the HMAC secret shared with provision.fwdapps.cloud. **No mailcow API key goes into AWS.**
  - `SYSTEM_MAIL_USER` / `SYSTEM_MAIL_PASS`: a `no-reply@roammail.net` mailbox for password resets, verification codes and receipts.
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (live). Also `BILLING_ENABLED=true`. Webhook endpoint: `https://roammail.net/api/billing/webhook` (events: checkout.session.completed, customer.subscription.updated/deleted/trial_will_end, invoice.paid, invoice.payment_failed).
  - `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` (Cloudflare bot protection on sign-up, recommended).
- **Add these environment variables:**
  - `SUPERADMIN_EMAILS=<Pete's Roammail address>`
  - `SYSTEM_MAIL_FROM=no-reply@roammail.net`
  - `LEGAL_CONTACT_EMAIL`, `ABUSE_EMAIL=abuse@roammail.net`
  - `MAIL_SERVER_IPS=<mailcow public IP>` (for blocklist checks)
  - `FREE_MAILBOX_QUOTA_GB`, `BUSINESS_MAILBOX_QUOTA_GB`: mailbox sizes. Both default to 10 (today's mailcow setting); set them once Pete decides (the site says 20 / 50).
  - Stripe prices default to the live ones: US$4/month `price_1UZAsW2BJzzFFmWAaUiUBgh4`, US$44/year `price_1UZAtR2BJzzFFmWAGxwLeDfa`. Only `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `BILLING_ENABLED=true` are needed.
  - `TRUST_PROXY=1` (the default; the ALB adds X-Forwarded-For)
- `REDIS_URL` is empty. That's fine for **one** web task. Before scaling past one web task, add ElastiCache Redis and set `REDIS_URL=rediss://…`. Without it, each task keeps its own rate limits and sign-out-everywhere only reaches one task.

## Network

- **App security group:** allow **3000** from the ALB security group (today it only allows 80).
- **Target group:** port 3000, health check `/healthz`, matcher 200. Raise the ALB idle timeout to **120 s** for the live-update stream.
- **mailcow API allow-list:** tasks use public IPs that change each time they start.
  - Option 1: put a NAT gateway with an Elastic IP in front of private subnets and allow that IP.
  - Option 2: in mailcow, allow the API from any IP and rely on the key (weaker).
  - Also add the IP to mailcow's Fail2ban whitelist.
- The ALB already serves roammail.net, login.roammail.net and app.roammail.net. The app routes by Host:
  - `roammail.net` serves Pete's website.
  - `login.roammail.net/` is sign-in and `login.roammail.net/signup` is sign-up.
  - `www.` and `app.` get a 301 to roammail.net.
  - `roammail.net/{id}/inbox` is the app.

## Smoke test after deploying (before switching DNS)

```bash
curl -s https://<alb-dns>/healthz -H 'Host: roammail.net'
curl -sI https://<alb-dns>/ -H 'Host: www.roammail.net'        # 301 → https://roammail.net/
curl -s https://<alb-dns>/ -H 'Host: login.roammail.net' | grep -o '<div id="root">'
```
Then sign up a test account through the app.roammail.net host (it already points at the ALB). Check it lands on `/{8 digits}/inbox` and can send and receive.

## mailcow: how the app talks to it (production rules)

**Admin actions never call the mailcow API from AWS.** That includes mailboxes, passwords, quotas, aliases, domains, DKIM, spam lists, quarantine, filters, imports, BCC/archive and watchdog logs. They all go through the provisioner as one signed route:

```
POST https://provision.fwdapps.cloud/mailcow/api
X-FWD-Timestamp: <unix seconds>
X-FWD-Signature: hex(HMAC-SHA256(PROVISIONER_SECRET, `${timestamp}./mailcow/api.${rawBody}`))
Content-Type: application/json

{"method":"GET","path":"get/mailbox/all/example.com"}
{"method":"POST","path":"add/mailbox","body":{"local_part":"ann","domain":"example.com",...}}
```

**What the provisioner should do:**
1. Verify the signature, and reject timestamps more than 5 minutes off.
2. Check `method` + `path` against the allowlist. Anything else gets a 403.
3. Call `https://<mailcow>/api/v1/<path>` from inside the VPS network with the provisioner's own API key.
4. Return mailcow's response body and HTTP status unchanged.

The allowlist and a reference implementation of the check are in `server/src/provisioner.js` (`MAILCOW_API_ALLOWLIST`, `verify`, `allowedCall`). The development stand-in `server/dev/mock-provisioner.js` does exactly this, and all the automated tests run through it.

**Route to add for Pete:** `POST /mailcow/api` (above). It isn't one of the existing named routes (`/mailboxes/*`, `/domains/*`, `/aliases/create`, `/public/*`). One allowlisted pass-through covers everything the app needs (about 45 mailcow calls) without a route each. If you'd rather keep only named routes, send me their exact paths and payloads, and I'll map the app's calls onto them in `provisioner.js` (one function).

**User mail goes straight to mailcow with the person's own password: IMAP 993, SMTP 587, CalDAV/CardDAV.** Env vars:

| Variable | Value for production | Default |
|---|---|---|
| `MAILCOW_HOST` | `mail.fwdapps.cloud` | sets all hosts below |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_SECURE` | (from MAILCOW_HOST) / `993` / `true` | 993, TLS |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | (from MAILCOW_HOST) / `587` / `false` (STARTTLS) | 587, STARTTLS |
| `DAV_URL` | `https://mail.fwdapps.cloud/SOGo/dav/` | from MAILCOW_HOST |
| `MAIL_HOSTNAME` | `mail.fwdapps.cloud` (shown in DNS setup and phone profiles) | from MAILCOW_HOST |
| `PROVISIONER_URL` | `https://provision.fwdapps.cloud` | (unset = development direct mode) |
| `PROVISIONER_SECRET` | secret, from `roammail/app` | |
| `IMAP_AUTH_FAIL_BUDGET` | `8` until the Elastic IP is whitelisted in mailcow. Can be raised (e.g. `50`) once it is. | 8 |

**Keeping mailcow from banning the app's single outbound IP** (all built in):
- **Before a password reaches mailcow:** malformed sign-ins are rejected in the app, as are per-account and per-IP throttled ones (shared via Redis when `REDIS_URL` is set). A password that just failed for an address is refused locally for 15 minutes.
- **Shared failure budget:** failures across all users are counted. Once `IMAP_AUTH_FAIL_BUDGET` is used up in a 10-minute window, sign-ins pause briefly instead of risking a ban.
- **One attempt only:** passwords are never retried (sign-in, password confirmation, sending, scheduled sends, push watchers).
- **Connections reused:** each session keeps one IMAP connection. A session whose saved password mailcow rejects is ended immediately, so it can't keep failing in the background. The same goes for push watchers and scheduled sends.
