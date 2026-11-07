# Plan: graduating off the sending relay (punch list 5h)

Today outgoing mail can leave through a trusted relay (SMTP2GO) for inbox placement while our own IP has no history.
The goal is to send **direct** from our own IP once it has a good reputation. The relay stays available as a fallback, per domain.

## What stays the same

- **DKIM:** every domain keeps its own mailcow DKIM key (the `dkim._domainkey` record). That signature, plus SPF and DMARC,
  is what the receivers judge. It doesn't change when we switch relay ↔ direct, so the reputation built on the domain carries over.
- **SPF:** keep `include:spf.smtp2go.com` (the `SPF_INCLUDE` setting) until no domain uses the relay any more, then remove it.
- The three relay CNAMEs (`em1184580`, `s1184580._domainkey`, `link`) can stay. They are harmless when the relay isn't used.

## Per-domain switch

- mailcow decides the route per domain: `relayhost` on the domain (0 = direct, otherwise the relay's id).
  The server tool `fwd-relay-sync` sets it. The app shows it as **Sending: Direct / Trusted relay** on each domain.
- Free accounts and business domains use separate routes (`FREE_RELAYHOST_ID`, `BUSINESS_RELAYHOST_ID`), so a spam
  wave from free sign-ups can't hurt business deliverability.
- Order of moving domains to direct: our own domains first (roammail.net system mail), then low-volume business
  domains, then larger ones, then free accounts last.

## IP warm-up (direct sending)

1. Before starting: PTR (reverse DNS) for the mail IP = `mail.fwdapps.cloud`; the IP is on no blocklists (the app checks
   the big lists every hour: Admin → Abuse); Postmaster Tools (Google) and SNDS + JMRP (Microsoft) registered for the IP and domains.
2. Volume ramp for direct mail, per day: week 1 ≈ 200, week 2 ≈ 500, week 3 ≈ 1,500, week 4 ≈ 5,000, then double weekly while
   the signals below stay green. Everything above the day's budget keeps going through the relay.
3. Pause the ramp (stay at the current step for a week) on any of: Gmail spam rate > 0.1% (Postmaster Tools),
   Microsoft SNDS yellow/red, bounce rate > 2%, any blocklist listing, deferrals ("421 try again later") > 5% at a big provider.
4. Roll back a domain to the relay immediately on a blocklist listing or a Gmail spam rate > 0.3%.

## Daily reputation report

A daily email to Pete (and abuse@) with, for the last 24 hours:
- messages sent direct vs relay, bounce and deferral rates per big provider (Gmail, Microsoft, Yahoo);
- accounts paused by the watchdog and why; feedback-loop complaints;
- blocklist status of the mail IPs; Postmaster Tools spam rate and domain/IP reputation (once the API is connected);
- recommendation: advance / hold / roll back the warm-up step.

The app already collects most of this (watchdog scans, holds, complaints, blocklists). Building the report needs the
Postfix log feed (now allowed through the provisioner) and, optionally, Google Postmaster Tools API credentials.

## Done when

All business domains send direct for 30 days with every signal green. Then remove `SPF_INCLUDE`, keep the relay
account for emergencies only, and switch free accounts.
