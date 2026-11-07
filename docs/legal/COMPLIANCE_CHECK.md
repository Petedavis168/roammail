# Compliance check: Roammail legal pages vs. Gmail, Yahoo Mail and Outlook.com

*Prepared 2026-11-07. This is a working review, not legal advice. Have a lawyer licensed where you operate review the
pages and this report before launch.*

## Summary

**Proceed with conditions.** The legal pages (`/legal/terms`, `/legal/privacy`, `/legal/acceptable-use`, `/legal/dpa`,
`/legal/subprocessors`, `/legal/security`) now cover the same ground as the big consumer mail providers. They're written
in Roammail's own words and describe what the code actually does. We didn't copy any provider's text: their terms are
copyrighted. Before launch: fill in the items marked **Not met**, then get the lawyer review.

## What the big providers cover, and where Roammail stands

| # | Topic covered by Google / Yahoo / Microsoft | Roammail page | Status | Action |
|---|---|---|---|---|
| 1 | Minimum age | Terms §1 (16+) | Met | 16 is stricter than the US 13 (COPPA) and fits the EU. Keep. |
| 2 | Account security and responsibility; no account selling or automated sign-ups | Terms §2 | Met | |
| 3 | Admins control business accounts and can see user data | Terms §3, Privacy §1/§3 | Met | |
| 4 | Paid plans: price, **auto-renewal**, online cancellation, trials, refunds, price-change notice | Terms §4 | Met | Matches US state auto-renewal laws (clear terms before purchase, cancel online, trial reminder email is built). Lawyer to confirm the refund wording. |
| 5 | Limited licence to your content, only to run the service; no ads and no AI training on mail | Terms §5, Privacy §3 | Met | |
| 6 | Suspension with notice and a **way to appeal** | Terms §7, AUP "How we enforce" | Met | The appeal goes to the support form or inbox. A person must answer. |
| 7 | Inactive-account policy | Terms §8 (12 months, 30 days' notice) | **Partly met** | Closing inactive accounts automatically isn't built yet. Until it is, the policy says "may", so nothing happens without notice. Build it before relying on it. |
| 8 | Changes to the service and terms, with notice | Terms §9 | Met | |
| 9 | Copyright (DMCA) process | Terms §11 | **Not met** | Register a DMCA agent with the US Copyright Office (about $6, online) and set `DMCA_AGENT_EMAIL`. |
| 10 | Government data requests | Terms §12 | Met | Consider publishing a yearly transparency report once you get requests. |
| 11 | Disclaimers, liability cap, indemnity, governing law | Terms §13–16 | Met | Google, Yahoo and Microsoft also use **binding arbitration** or court choice clauses in the US. We left this out on purpose. **Lawyer decision.** |
| 12 | Postal address for legal notices | Terms §17, Privacy §11 | **Not met** | Set `LEGAL_ADDRESS`. The page shows a placeholder until you do. |
| 13 | Privacy: categories of data, purposes, legal bases, sharing, transfers, retention, cookies, rights | Privacy §1–11 | Met | Retention periods match the code: logs 180 days, audit about 13 months, backups 35 days, tickets 2 years (clean-up added). |
| 14 | CCPA/CPRA notice at collection, "do not sell/share", rights, authorised agents, non-discrimination, Global Privacy Control | Privacy §5, §9 | Met | |
| 15 | GDPR: controller/processor roles, international transfers (SCCs), breach notice | Privacy §1/§6/§10, DPA | Met | If you actively serve EU users, appoint an **EU representative** (Art. 27) and set `EU_REPRESENTATIVE`. |
| 16 | Business Data Processing Addendum (Art. 28) | `/legal/dpa` | Met | Includes SCC Module 2 by reference, 48-hour breach notice, 30-day subprocessor notice, deletion and audit terms. |
| 17 | Public subprocessor list | `/legal/subprocessors` | Met | Update it whenever you add a vendor (e.g. Amazon SES relay). |
| 18 | Acceptable use: CSAM zero tolerance, terrorism, phishing, malware, harassment, IP infringement, illegal content | AUP | Met | **US law (18 U.S.C. 2258A) requires reporting apparent CSAM to NCMEC.** Register as an electronic service provider with NCMEC's CyberTipline before launch. |
| 19 | Anti-spam: no unsolicited bulk mail; bulk senders authenticate, offer one-click unsubscribe, keep complaints under 0.3%; CAN-SPAM/CASL | AUP "Spam and sending" | Met | The tech side is covered in `docs/DELIVERABILITY.md`. |
| 20 | Gmail/Yahoo/Microsoft **sender requirements** for our own outgoing mail: SPF, DKIM, DMARC, PTR, TLS, spam rate | `docs/DELIVERABILITY.md` | Partly met | Code is done. You still need to set the DNS records, PTR and Postmaster/SNDS sign-ups on the real servers. |
| 21 | Security page and vulnerability disclosure | `/legal/security`, `security.txt` | Met | "Regular external testing" was removed until a penetration test is actually done. |
| 22 | Incident response plan | `docs/INCIDENT_RESPONSE.md` | Met | |

## Risk areas

| Risk | Severity | Mitigation |
|---|---|---|
| CSAM found on the service with no NCMEC reporting set up | High | Register with the NCMEC CyberTipline. Use the abuse desk plus support tools to preserve evidence and report it. |
| Pages go live unreviewed | High | Lawyer review (terms, privacy, DPA, AUP). |
| Missing postal address / DMCA agent | Medium | Set `LEGAL_ADDRESS` and `DMCA_AGENT_EMAIL`, and register the agent. |
| EU users without an Art. 27 representative | Medium | Appoint one if you market to the EU, or restrict sign-up. |
| Inactive-account clause not automated | Low | Build it, or keep the "may" wording. |
| Business archive used without telling employees | Medium | The admin screen warns about this. The DPA and Terms make the business responsible for telling them. |

## Recommended actions (in order)

1. Lawyer review of all six pages, including the decision on arbitration.
2. Register with NCMEC (CyberTipline ESP) and with the US Copyright Office (DMCA agent).
3. Set `LEGAL_ADDRESS`, `DMCA_AGENT_EMAIL`, `PRIVACY_EMAIL`, and `EU_REPRESENTATIVE` if needed. Bump `TERMS_VERSION` when the final text is in.
4. Finish the sender setup in `docs/DELIVERABILITY.md` (DNS, PTR, Postmaster Tools, SNDS, Yahoo feedback loop).
5. Get a penetration test, then add it back to the Security page.

## Approvals needed

| Approver | Why | Status |
|---|---|---|
| Outside counsel | Terms, Privacy, DPA, AUP; arbitration; consumer-law refund wording | Pending |
| Pete Davis (owner) | Postal address, contacts, refund policy, EU decision | Pending |
