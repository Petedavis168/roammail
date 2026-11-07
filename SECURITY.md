# Security

This document explains how the platform protects people, what is **not** covered, and what the operator (you)
must do before and after launch. Report vulnerabilities to the address in `/.well-known/security.txt`.

## What we protect against

| Threat | Protection |
|---|---|
| **Malicious email content** (script injection, fake login overlays, tracking) | Email HTML is sanitized (DOMPurify) and shown in a sandboxed frame with no script permission. Everything placed into the app page (reply/forward quotes, signatures, pastes) is sanitized again: no event handlers, `<style>`, forms, SVG or fixed-position overlays. A strict Content Security Policy blocks inline scripts as a second layer. Remote images, CSS backgrounds and `image-set()` are blocked until the user allows them, including in reply quotes. Links in Junk are disabled. Browser tests (`npm run test:e2e`) attack all of this on every change. |
| **Stolen or guessed passwords** | 2-step verification (TOTP + single-use backup codes). Required for every admin, and businesses can require it for all staff. New passwords are checked against known breaches (Have I Been Pwned k-anonymity API, with an offline common-password list as a backstop). Failed sign-ins are throttled per account+IP (10 → 15 min) and per account across all IPs (50 → 15 min), so attackers can't lock real users out. A new-device alert lands in the inbox. |
| **Session theft** | The cookie is an opaque random token (HttpOnly, Secure, SameSite=Strict). Credentials stay on the server, encrypted with AES-256-GCM using a key derived (HKDF) from `SESSION_SECRET`. Sessions expire after `SESSION_HOURS` and after `SESSION_IDLE_HOURS` of inactivity. Users see their devices and can sign any of them out. Logout, password changes, password resets and suspensions revoke sessions server-side. |
| **Cross-site request forgery / clickjacking** | All state-changing requests need a custom header plus SameSite=Strict cookies. `frame-ancestors 'self'` and X-Frame-Options. |
| **Account takeover persistence** | Changing the recovery email, regenerating backup codes, turning off 2FA and changing the password all require the current password. Businesses block auto-forwarding outside the company by default, including in raw Sieve filters. Every security change is audit-logged. |
| **Tenant isolation** | Business admins can only touch domains, users, aliases, spam lists and quarantine items of their own organization. Users only see their own quarantine. API tests check these boundaries. |
| **Free-tier abuse** (spam, phishing) | Captcha (Cloudflare Turnstile), per-IP and global sign-up limits, reserved names, mailcow send rate limit per free mailbox, webmail daily limits (25/day for accounts younger than 48h, 150/day after) and 20 recipients per message. No auto-forwarding for free accounts. Super-admins see the most active senders and can suspend accounts, which signs them out instantly. |
| **Server-side request forgery** | Mail-import hosts must be public: no IPs, private/loopback/link-local/CGNAT/metadata addresses (also when a DNS name resolves to one), and only mail ports. |
| **Display-name spoofing** | Sender display names can't contain addresses or brackets. Readers see warnings for failed SPF/DKIM/DMARC, names that hide a different address, odd Reply-To, and fake "internal" mail, plus an External tag for business users. |
| **Information leaks** | Unexpected errors return a generic message (details only in server logs). No `X-Powered-By`; Permissions-Policy, Referrer-Policy, COOP, HSTS. |
| **Infrastructure** | Container runs as non-root, read-only filesystem, all Linux capabilities dropped, no privilege escalation. EC2: IMDSv2 only, no SSH (Session Manager), only 80/443 open, encrypted disks, daily snapshots, auto-recovery, automatic security updates. Secrets live in SSM Parameter Store (encrypted). The release bucket is private, encrypted and TLS-only. CloudWatch alarms fire on error bursts and password-guessing waves. |
| **Dependencies** | `npm audit` fails the build on high/critical issues; Dependabot proposes updates weekly; CodeQL scans every change. |

## Known limitations (be honest with customers)

- **2-step verification protects the web app only.** Phone and desktop mail apps sign in to mailcow directly with the
  password. Encourage mailcow **app passwords** for those apps, and turn on 2FA for the mailcow admin UI itself.
- **The server has to hold mailbox passwords** (encrypted) while people are signed in, because IMAP/SMTP need them.
  If both the server and `SESSION_SECRET` are compromised, passwords of active sessions are exposed. A future
  upgrade is single sign-on through mailcow's identity provider (OIDC), which removes stored passwords.
- **Webmail sending limits don't apply to other mail apps.** For those, mailcow's per-mailbox rate limit (set
  automatically for free accounts) and a domain-wide rate limit (see checklist) are what protect you.
- **Rate limits are kept in memory** and reset on restart. That's fine for the single-server design; a multi-server
  setup would need a shared store (e.g. Redis).
- **Not yet independently tested.** Everything here was tested with automated tests against a mailcow stand-in.
  Run the checklist against your real mailcow and commission an external penetration test before a public launch.
- **Legal pages are templates.** Have a lawyer review them (see below).

## Operator checklist

### Before launch
- [ ] `SESSION_SECRET`: long and random (deploy.sh generates one). Never commit `deploy/aws/config.env`.
- [ ] Turn on 2-step verification for your own super-admin account (the app requires it for the admin portal).
- [ ] **mailcow admin UI**: turn on 2FA for the admin; restrict access to the admin UI (VPN or IP allow-list); restrict the API key
      to the app server's IP; add that IP to the Fail2ban whitelist.
- [ ] **mailcow updates**: run `./update.sh` at least monthly and subscribe to mailcow security announcements.
- [ ] **Quarantine**: enable it (System → Configuration → Quarantine, retention > 0).
- [ ] **Forwarding policy everywhere**: SOGo (mailcow's built-in webmail) has its own forwarding setting. To enforce the
      "no external forwarding" policy there too, set `SOGoForwardEnabled = NO;` in `data/conf/sogo/sogo.conf`
      (or disable SOGo access for those users).
- [ ] **Protect business mail from free-tier spam**: send free-domain mail through a separate path, so a spammer can't get
      your main IP blocklisted. In mailcow, add a relay host (for example Amazon SES SMTP) under
      Configuration → Routing → Sender-dependent transports and assign it to the free sign-up domain. Also set a domain
      rate limit for the free domain (Mail Setup → Domains → edit → rate limit).
- [ ] **Captcha**: set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` before opening sign-ups.
- [ ] **Contacts that work**: create and monitor `security@`, `abuse@` and `support@` (or set `SECURITY_CONTACT_EMAIL`,
      `ABUSE_EMAIL`, `LEGAL_CONTACT_EMAIL`), plus the `SYSTEM_MAIL_*` no-reply mailbox for password resets.
- [ ] **Legal**: have a lawyer review `/legal/terms`, `/legal/privacy`, `/legal/acceptable-use`. Put reviewed versions in
      `DATA_DIR/legal/<name>.html` (they replace the templates) and set `LEGAL_COMPANY_NAME`, `LEGAL_COUNTRY`, `TERMS_VERSION`.
- [ ] **AWS account**: MFA on the root user, an admin IAM user/role for daily work, CloudTrail on, GuardDuty on, a budget alert.
- [ ] **Independent penetration test** of the deployed system.

### Every month
- [ ] Merge Dependabot updates once CI is green; redeploy.
- [ ] Check blocklists for your mail server IP (e.g. MXToolbox) and read DMARC reports.
- [ ] Review the Platform page: most active senders, recent sign-ups.
- [ ] Test a restore from a data-disk snapshot once a quarter.

### If something goes wrong
- **Compromised user account**: suspend it (admin → Users or Platform), which signs it out everywhere instantly; reset the
  password; check its Rules and Advanced filters for forwards; review the activity log.
- **Spam outbreak from free accounts**: turn off sign-ups (Platform), suspend the senders, check mailcow's mail queue.
- **Server or secret compromise**: rotate `SESSION_SECRET`, keeping the old value in `SESSION_SECRET_PREVIOUS` so 2-step
  verification keeps working (it re-encrypts as people sign in). Everyone is signed out. Rotate the mailcow API key and redeploy.
