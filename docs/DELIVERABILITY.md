# Deliverability: getting Roammail mail into the inbox

Gmail, Yahoo and Microsoft (Outlook.com, Hotmail, Live) all publish rules for anyone who sends them mail.
If we break those rules, our customers' mail goes to spam or gets rejected. This page lists each rule, what
Roammail already does about it, and what you still need to set up.

Official pages (check them once a year, because they change):
- Google: Email sender guidelines (https://support.google.com/a/answer/81126) and Postmaster Tools (https://postmaster.google.com)
- Yahoo: Sender best practices (https://senders.yahooinc.com/best-practices/)
- Microsoft: "Outlook's new requirements for high-volume senders" (Microsoft Tech Community, 2025) and SNDS (https://sendersupport.olc.protection.outlook.com/snds/)

## 1. The rules and where Roammail stands

| Rule (Gmail / Yahoo / Microsoft) | Applies to | Roammail |
|---|---|---|
| **SPF** passes for the sending domain | Everyone | ✅ Domain setup gives every business the SPF record and checks it. `roammail.net` needs it too (section 2). |
| **DKIM** signature for the From domain | Everyone (Yahoo: required for all; Gmail: SPF *or* DKIM under 5,000/day, both above) | ✅ mailcow signs every message. The app creates the key and checks the DNS record before a domain goes live. |
| **DMARC** record (at least `p=none`), with SPF or DKIM **aligned** to the From domain | Senders of 5,000+/day to that provider (strongly recommended for everyone) | ✅ Domains get `p=quarantine`. The From address always matches the signed domain, and send-as is limited to the person's own addresses and groups. |
| **Reverse DNS (PTR)** for the sending IP, matching forward DNS | Everyone | ⚠️ Set it on the mail server (section 2). |
| **TLS** when sending | Everyone | ✅ mailcow uses TLS whenever the receiving server offers it (Gmail, Yahoo and Microsoft all do). |
| Messages follow the email format standard (RFC 5322); no impersonating Gmail/Yahoo/Microsoft addresses in From | Everyone | ✅ The app builds standard messages, cleans display names (no fake "Name <other@address>"), and won't send as addresses you don't own. |
| **Spam complaint rate under 0.3%** (aim for under 0.1%) | Everyone; enforced hardest above 5,000/day | ✅ Outbound watchdog plus daily limits for free and new accounts (section 3). Watch the rate in Google Postmaster Tools. |
| **One-click unsubscribe** (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`) and honour it within 2 days | Marketing/subscribed mail from senders of 5,000+/day | ✅ Doesn't apply to person-to-person email. Roammail itself only sends account and security emails. The Acceptable Use Policy bans bulk marketing from Roammail mailboxes. Customers who send newsletters must use a proper email-marketing service. |
| Valid, monitored reply/bounce addresses | Everyone | ⚠️ Create `postmaster@`, `abuse@` and `dmarc@` mailboxes or aliases on `roammail.net` (section 2). |

## 2. One-time setup on your side

On **roammail.net** (the free sign-up domain), the domain of the **mail server** itself, and any **sending relay**:

1. **SPF** for `roammail.net`: `v=spf1 mx a:<mail server hostname> -all`. If free mail leaves through a relay (section 4), add the relay's include,
   e.g. `include:amazonses.com`. Set `SPF_INCLUDE=include:amazonses.com` in `config.env` so business customers get it too.
2. **DKIM** for `roammail.net`: mailcow → Configuration → ARC/DKIM keys → add a 2048-bit key, then publish the TXT record it shows.
3. **DMARC** for `roammail.net`: start with `v=DMARC1; p=none; rua=mailto:dmarc@roammail.net; adkim=s; aspf=r`.
   After 2–4 weeks of clean reports, move to `p=quarantine`, then `p=reject`. A free DMARC report reader (dmarcian, Postmark DMARC, EasyDMARC) makes the reports readable.
4. **Reverse DNS (PTR)**: the mail server's IP must point back to its hostname (e.g. `mail.roammail.net`), and that hostname must point to the IP.
   On AWS, use the "Request to remove email sending limitations" form, which also sets reverse DNS.
   On other hosts, use the provider's control panel.
5. **Mailboxes**: create `postmaster@`, `abuse@` and `dmarc@roammail.net` (aliases to your support inbox are fine).
   Set `ABUSE_EMAIL` so the watchdog and abuse form copy reports to it.
6. **Monitoring sign-ups (free)**:
   - Google Postmaster Tools: add `roammail.net` and each large customer domain. Shows spam rate, reputation and authentication.
   - Microsoft SNDS + JMRP: register the mail server IP. Shows Outlook.com reputation and sends complaint copies.
   - Yahoo Complaint Feedback Loop (senders.yahooinc.com): register `roammail.net`. Complaints are emailed to `abuse@`.
7. **Blocklist checks**: set `MAIL_SERVER_IPS=<mail server public IP>` in `config.env`. The app checks Spamhaus, Barracuda, SpamCop and PSBL every hour.
   It alerts you (APP_ERROR alarm), and shows the result in Admin → Abuse & sending.
   Spamhaus refuses lookups made through big public DNS resolvers, so a result of "unknown" there is normal on AWS's default DNS.
   For a reliable Spamhaus check, register for a free Spamhaus DQS key.

## 3. Keeping our reputation clean (built in)

- **Free accounts** send to at most 20 people per message and have daily limits. Limits are even lower for the first 48 hours, plus mailcow's per-mailbox hourly rate limit.
- **Outbound watchdog** (every 5 minutes): when mailcow's spam filter flags 10+ of an account's outgoing messages in an hour, sending is paused.
  The same happens when it hits the rate limit 3+ times. A paused account can still read mail.
  The person and their recovery email are told to change their password. The abuse inbox gets a copy.
  - Free accounts are paused automatically.
  - Business accounts are flagged for their admin and for you. Set `OUTBOUND_HOLD_BUSINESS=true` to pause them too.
  - Thresholds: `OUTBOUND_SPAM_PER_HOUR`, `OUTBOUND_RATELIMIT_HITS`.
- **Abuse desk**: anyone can report a Roammail sender at `https://<app>/abuse`. Three independent reports in a day flag the account for review.
  Reports never pause anyone automatically, so they can't be used to attack an innocent person.
- **Super-admin → Abuse & sending**: paused and flagged accounts, open reports, blocklist status, and a "Check now" button.

## 4. Separate sending routes (recommended once you have real traffic)

Free accounts are where spammers sign up. If free mail and business mail leave from the same IP, one bad free account can hurt every paying customer.
mailcow can send each domain through a different **relay host**:

1. mailcow → Configuration → Routing → **Sender-dependent transports**: add a relay, for example:
   - Amazon SES on a dedicated configuration set, or
   - a second small mailcow/Postfix server with its own IP.

   Note the ID it gets.
2. In `config.env`: `FREE_RELAYHOST_ID=<id>` (and optionally `BUSINESS_RELAYHOST_ID=<id>` for a separate business route).
3. Redeploy. The app assigns the route to `roammail.net` at start-up and to each business domain when it goes live.

With Amazon SES you also get SES's complaint and bounce tracking and its reputation dashboard.

## 5. New IP address? Warm it up

Mailbox providers distrust a brand-new IP that suddenly sends a lot. For the first 4–6 weeks:

| Week | Max messages/day from the new IP |
|---|---|
| 1 | 200–500 |
| 2 | 1,000–2,000 |
| 3 | 5,000 |
| 4 | 10,000–20,000 |
| 5–6 | double each week while the spam rate stays under 0.1% |

The low daily limits for new and free accounts help with this. Keep them low until Postmaster Tools shows "High" reputation.
To change them, set `FREE_SENDS_PER_DAY` and `NEW_ACCOUNT_SENDS_PER_DAY`.

## 6. If you get blocklisted or Gmail starts rejecting mail

1. Admin → Abuse & sending → **Check now**. Pause any account that's sending spam.
2. Make sure the cause is fixed: changed passwords, 2-step verification on, nothing still queued (mailcow → Queue).
3. Request delisting:
   - Spamhaus: https://check.spamhaus.org
   - Barracuda: https://www.barracudacentral.org/rbl/removal-request
   - SpamCop: listings expire automatically within 24 hours
   - Microsoft: the sender support form on the SNDS site
4. Gmail: you can't request removal. Reputation recovers after a few days or weeks of clean sending. Watch Postmaster Tools.
