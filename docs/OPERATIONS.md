# Running Roammail in production

This guide covers backups, the staging copy, monitoring and alerts, the status page, load testing, and
testing against a real mailcow server. Every command runs in **AWS CloudShell** (the `>_` icon in the AWS console)
unless it says "on the mailcow server".

---

## 1. Backups

There are three layers. Together they cover a deleted email, a broken server, and a lost AWS account region.

| What | How | Kept for |
|---|---|---|
| Roammail app server disk | Automatic EBS snapshots every night at 03:00 UTC (set up by `deploy.sh`) | `SnapshotRetentionDays` (default 14) |
| Roammail app database | A clean copy every 6 hours in `/srv/mcdata/app/backups/app-YYYY-MM-DD.db` (on the encrypted data disk) | 7 days |
| **All mail** (mailboxes, mailcow database, spam training, DKIM keys, settings) | `deploy/mailcow/backup-to-s3.sh` on the mailcow server, encrypted, to S3 | 35 days (7 days fast, then cheaper storage) |

### Set up mail backups (once)

1. In CloudShell, create the backup bucket:
   ```bash
   aws cloudformation deploy --stack-name roammail-backups --template-file deploy/mailcow/backup-bucket.yaml --capabilities CAPABILITY_IAM
   aws cloudformation describe-stacks --stack-name roammail-backups --query "Stacks[0].Outputs"
   ```
2. IAM console → Users → the `BackupUserName` from the output → Security credentials → **Create access key**.
   This key can *add* backups but cannot read or delete them. Even if someone breaks into the mail server, they can't wipe your backups.
3. **On the mailcow server**:
   ```bash
   sudo apt-get install -y awscli gnupg
   sudo mkdir -p /opt/roammail && sudo cp backup-to-s3.sh /opt/roammail/ && sudo chmod 700 /opt/roammail/backup-to-s3.sh
   sudo tee /etc/mailcow-backup.env >/dev/null <<'EOF'
   MAILCOW_DIR=/opt/mailcow-dockerized
   BACKUP_BUCKET=<BucketName from step 1>
   AWS_ACCESS_KEY_ID=<from step 2>
   AWS_SECRET_ACCESS_KEY=<from step 2>
   AWS_DEFAULT_REGION=us-east-1
   BACKUP_PASSPHRASE=<run: openssl rand -base64 36>
   HEALTHCHECK_URL=
   EOF
   sudo chmod 600 /etc/mailcow-backup.env
   echo '30 2 * * * root /opt/roammail/backup-to-s3.sh >> /var/log/mailcow-backup.log 2>&1' | sudo tee /etc/cron.d/mailcow-backup
   sudo /opt/roammail/backup-to-s3.sh     # first run now, check it says "backup uploaded"
   ```
4. **Store `BACKUP_PASSPHRASE` in your password manager.** Without it, the backups can't be opened.
5. Optional but recommended: set `HEALTHCHECK_URL` to a free healthchecks.io check. You'll get an email if a night's backup doesn't arrive.

### Restore mail (practise this once before you need it)

```bash
# CloudShell, as an admin: download the newest backup
aws s3 ls s3://<bucket>/mailcow/<mail-server-hostname>/ | tail -3
aws s3 cp s3://<bucket>/mailcow/<host>/<file>.tar.gpg .
# copy it to the (new) mailcow server, then on that server:
gpg -d <file>.tar.gpg | tar -xf - -C /var/backups/mailcow
cd /opt/mailcow-dockerized
MAILCOW_BACKUP_LOCATION=/var/backups/mailcow ./helper-scripts/backup_and_restore.sh restore
```
mailcow's restore asks which backup and which parts to restore (choose **all** to rebuild a whole server).
Restoring a single person's mailbox: choose only **vmail**, or use mailcow's own per-mailbox restore.

### Restore the Roammail app database

```bash
./deploy/aws/deploy.sh shell
cd /opt/mail-client/app
sudo docker compose -p mailclient stop app
sudo cp /srv/mcdata/app/backups/app-2026-11-06.db /srv/mcdata/app/app.db
sudo docker compose -p mailclient start app
```

---

## 2. Staging: a separate copy for testing changes

Never test changes on the real service. Staging is a second, smaller copy with its own server, settings and test mailcow.

```bash
cp deploy/aws/config.env deploy/aws/config.staging.env
# edit config.staging.env:
#   STACK_NAME=roammail-staging
#   APP_DOMAIN=staging.roammail.net
#   point IMAP/SMTP/MAILCOW_API_URL at your STAGING mailcow (a small separate server, never production)
#   STRIPE_SECRET_KEY=sk_test_...   (Stripe test mode)
#   SIGNUP_DOMAIN=staging.roammail.net
#   SIGNUP_PER_IP_PER_DAY=1000 and SIGNUPS_PER_HOUR=5000   (so automated tests can create accounts)
#   SUPERADMIN_EMAILS=owner@staging.roammail.net
#   INSTANCE_TYPE=t3.micro
CONFIG=deploy/aws/config.staging.env ./deploy/aws/deploy.sh
```

Release routine: **deploy to staging → run the Staging tests → deploy to production.**
In GitHub, add the secrets `STAGING_URL` and `STAGING_DOMAIN`, then go to Actions → *Staging (real mailcow)* → Run workflow.
That workflow also runs every morning, so a mailcow update that breaks something shows up before your customers notice.

---

## 3. Monitoring and alerts

`deploy.sh` sets all of this up. Put `ALERT_EMAIL` and/or `ALERT_PHONE` (text messages) in `config.env`.

You get an alert when:
- the server stops responding (AWS also reboots it, or moves it to healthy hardware, automatically)
- the app stops reporting for 10 minutes (crashed or hung)
- 95% of requests take longer than 2 seconds for 10 minutes
- 20 or more failed requests happen in 5 minutes, or 5 or more unexpected errors are logged
- someone appears to be guessing passwords (10 or more account lockouts in 15 minutes)
- CPU stays above 80% (time for a bigger server)
- a nightly mail backup fails (when `HEALTHCHECK_URL` or `ALERT_SNS_TOPIC_ARN` is set on the mailcow server)

**Dashboard:** the `DashboardUrl` stack output shows requests, response times, people online, CPU, memory, errors and lockouts.

**Prometheus / Grafana (optional):** `GET /metrics` with header `Authorization: Bearer <METRICS_TOKEN>`.
Without a `METRICS_TOKEN`, it only answers on the server itself. From the internet, it returns 404.

Also set up a free outside monitor (UptimeRobot, Better Stack, or similar) that checks `https://<your app>/api/status` every minute.
That page returns **503** when anything is down. An outside monitor still works when AWS itself has a problem.

---

## 4. Public status page

`https://<your app>/status` is a plain page anyone can open. It shows whether the web app, receiving mail, sending mail and
account management are working. It's checked every 30 seconds. Link to it from your website and the help centre.

To post a notice (planned maintenance, an incident), sign in as a super-admin and run:
```js
// browser console on the app
fetch('/api/super/status-notice', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mailcow-client' },
  body: JSON.stringify({ title: 'Planned maintenance Sunday 02:00 UTC', body: 'Mail may be delayed for up to 15 minutes.' }) })
```
Send an empty title to clear it. (This is also in Admin → Platform.)

---

## 5. Load testing

```bash
node loadtest/run.mjs --url https://staging.roammail.net --users 200 --minutes 10 --accounts accounts.csv
```
`accounts.csv` holds one `email,password` per line: test mailboxes on the **staging** mailcow. The test passes if fewer than 1% of
requests fail and inbox loads stay under 2 seconds for 95% of requests. **Never point it at production.**

**Baseline (2026-11-07, one dev machine, test mail server, one app process):**

| People | Requests/s | Errors | Inbox p95 | Open message p95 | Send p95 | Memory |
|---|---|---|---|---|---|---|
| 50 | 65 | 0% | 47 ms | 48 ms | 106 ms | – |
| 200 | 261 | 0% | 47 ms | 50 ms | 108 ms | 290 MB |

A real mailcow server is slower than the test mail server, so expect staging numbers to be higher. Run the load test on staging
after every big change and compare with the last run.

---

## 6. Testing against a real mailcow server

The automated tests in CI use a stand-in mail server and a stand-in mailcow API. Before launch and before each release,
also test against a real one:

1. Build a small **staging mailcow** (2 vCPU / 4 GB is enough) on its own domain, e.g. `mail.staging.roammail.net`.
2. In mailcow: create the sign-up domain, create an API key (read-write) and allow the staging app's IP,
   turn on quarantine, and create a `no-reply@` mailbox for system emails.
3. Deploy staging (section 2) pointing at it.
4. Run the Staging workflow, or run it from your computer:
   ```bash
   cd server && BASE_URL=https://staging.roammail.net TEST_DOMAIN=staging.roammail.net npm run test:api
   ```
5. Also check by hand: sign up on a phone, add the account with the setup QR code, send to and from Gmail and Outlook,
   and confirm messages aren't landing in their spam folders (see `docs/DELIVERABILITY.md`).
