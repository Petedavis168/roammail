# Deliverability dashboard

Admin → **Deliverability** (super-admins). It shows whether our email reaches inboxes:

- **Last 24 hours** from the mail server: delivered, bounced, delayed, by provider; spam complaints; paused accounts.
- **Daily history** (bounce rate per day, kept 120 days). Recorded by the daily sending report on the worker.
- **Blocklists** for the mail server IPs (`MAIL_SERVER_IPS`).
- **DNS health** of any of our domains: SPF, DKIM, DMARC (policy and reports), MTA-STS, TLS reporting, reverse DNS.
- **Gmail** and **Outlook.com** reputation, once connected (below).

Targets: bounces under 2%, delays under 5%, Gmail spam rate under 0.1% (never over 0.3%), Gmail reputation HIGH,
Microsoft SNDS GREEN.

## Connect Google Postmaster Tools (Gmail)

1. Sign in at https://postmaster.google.com with the Google account that will own this, add `roammail.net`
   (and any business domains you want to watch) and add the TXT record it asks for.
2. In Google Cloud Console: create a project, enable the **Gmail Postmaster Tools API**, create an OAuth client
   (type "Desktop app").
3. Get a refresh token for scope `https://www.googleapis.com/auth/postmaster.readonly` with that client, signed in as the
   same Google account (for example with Google's OAuth Playground: use your own client ID/secret in its settings).
4. Store in the app's secrets: `GOOGLE_POSTMASTER_CLIENT_ID`, `GOOGLE_POSTMASTER_CLIENT_SECRET`,
   `GOOGLE_POSTMASTER_REFRESH_TOKEN`. Google only shows numbers on days with enough Gmail traffic (a few hundred emails).

## Connect Microsoft SNDS (Outlook.com, Hotmail, Live)

1. Sign in at https://sendersupport.olc.protection.outlook.com/snds/ and request access for each mail server IP.
   Microsoft emails the abuse/postmaster address for the IP to confirm.
2. Under **Automated Data Access**, turn it on and copy the key.
3. Store it in the app's secrets as `SNDS_KEY`.
