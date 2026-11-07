# Running Roammail on the roammail-prod ECS stack (us-east-2)

Image: `515579969872.dkr.ecr.us-east-2.amazonaws.com/roammail-app:75e55e3` (also tagged `latest`).
Digest `sha256:bb5d3d7d53d322b87fc550f563f814cb2afcbf0b717ef95c35a2e5ebdb445ad5`.

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
  - `MAILCOW_API_KEY`: read-write key from mailcow → System → Configuration → Access → API.
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
