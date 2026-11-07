# Incident response plan

**Who:** the incident lead is the owner (Pete) until there's a team. Keep a backup person with AWS and mailcow admin access.
**Where:** take notes in one running document with times (UTC). Write down every action.

## 1. Detect and decide (first 30 minutes)
Signals:
- AWS alarm (email or SMS)
- status page red
- Admin → Abuse & sending
- a report to security@ or abuse@
- a customer complaint

Severity:
- **SEV1:** data exposed or likely exposed, accounts taken over at scale, mail down for everyone.
- **SEV2:** partial outage, a single account compromised, blocklisted.
- **SEV3:** minor.

## 2. Contain
- Account compromise: Admin → Support → sign out everywhere, reset 2-step verification, pause sending (Abuse & sending). Tell the user to change their password.
- Spam outbreak: pause sending for the affected accounts. Check the mailcow queue and delete the spam from it.
- App server suspected compromised:
  - single server: `deploy.sh shell`, snapshot the disk, then redeploy
  - scale layout: terminate the instance (the auto-scaling group replaces it)
  - in both cases, rotate `SESSION_SECRET` (set the old one as `SESSION_SECRET_PREVIOUS`), the mailcow API key and the Stripe keys
- Mail server compromised: take it off the internet (security group), restore from the encrypted S3 backup onto a fresh server (docs/OPERATIONS.md).
- Post a notice on the status page (Admin → Platform → Status page).

## 3. Assess
What data, whose, how many people, since when? Use the audit log, sign-in events, CloudTrail, mailcow logs and the load balancer logs.
Keep copies of the logs. **Don't delete evidence.** For CSAM, preserve it and report to NCMEC. Don't copy or forward it.

## 4. Notify (clocks start when you become aware)
| Who | When | How |
|---|---|---|
| Business customers (DPA) | within **48 hours** | email their admins: what happened, what data, what we're doing, contact |
| EU/UK supervisory authority (if EU/UK personal data) | within **72 hours** | the authority's online form (we're controller for free accounts) |
| Affected people | without undue delay if high risk | email them plus their recovery addresses |
| US states | per state breach laws (often 30–60 days; some also require notifying the attorney general) | lawyer to confirm |
| NCMEC | as soon as reasonably possible for CSAM | CyberTipline |
| Payment card issues | immediately | Stripe support (card data never touches our servers) |

## 5. Recover and learn
Restore service, watch the dashboard for 48 hours, then clear the status notice. Within a week, write a short blameless review:
- timeline
- cause
- what worked
- what to fix (with owners)

Add a test or alarm so it can't happen silently again.

## Contacts to keep ready
- AWS support
- mailcow community/support
- Stripe
- domain registrar
- lawyer
- insurer (if cyber insurance)
- NCMEC CyberTipline
