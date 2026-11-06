# Put the mail platform on AWS (about 15 minutes)

You don't need to install anything. Everything runs in **AWS CloudShell**, a terminal inside your web browser.

## What gets created

| Piece | What it does |
|---|---|
| EC2 server (Ubuntu 24.04, `t3.small`) | Runs the app in Docker, with Caddy for automatic HTTPS |
| Separate encrypted data disk | Accounts, signatures, settings and certificates. Survives server replacement |
| Daily snapshots (kept 14 days) | Backups of the data disk; deleting the system keeps a final snapshot |
| Elastic IP | A fixed address for your DNS record and mailcow's allow-list |
| Auto-recovery & auto-reboot alarms | AWS fixes hardware or OS hangs by itself, optionally emails you |
| CloudWatch Logs (30 days) | App logs viewable in the console or with `deploy.sh logs` |
| SSM Parameter Store (encrypted) | Your API key and secrets. Never stored on disk in the release |
| Private S3 bucket | Release bundles (keeps old versions for 30 days) |
| No SSH | Admin access via Session Manager (`deploy.sh shell`), so no open port 22 |

Security extras: only ports 80/443 open, IMDSv2 only, encrypted disks, automatic Ubuntu security updates,
health checks every 2 minutes with automatic restart, and automatic rollback if an update fails its health check.

**Rough cost:** about **$20–25/month** (t3.small ~$15, public IP ~$3.60, disks + snapshots ~$4). `t3.medium` for a few
hundred active users is ~$30/month.

## Step by step

1. **Sign in to the AWS console** and pick your region (top right), e.g. *US East (N. Virginia)*.
   Use the same region as your mailcow server if it's on AWS.
2. **Open CloudShell:** click the `>_` icon in the top bar.
3. **Get the code into CloudShell**, either way works:
   - From GitHub: `git clone https://github.com/<you>/<repo>.git mail-client && cd mail-client`
   - Or upload the zip: CloudShell → **Actions → Upload file**, then `unzip mail-client.zip -d mail-client && cd mail-client`
4. **Fill in your settings:**
   ```bash
   cp deploy/aws/config.example.env deploy/aws/config.env
   nano deploy/aws/config.env
   ```
   (Save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`.) At minimum set `APP_DOMAIN`, `MAIL_HOSTNAME`, `IMAP_HOST`,
   `MAILCOW_API_KEY`, `SIGNUP_DOMAIN` and `SUPERADMIN_EMAILS`. If your domain's DNS is in Route 53, also set
   `HOSTED_ZONE_ID` and the web address record is created for you.
5. **Deploy:**
   ```bash
   ./deploy/aws/deploy.sh
   ```
   It takes about 10 minutes and finishes with three one-time steps (DNS record if not on Route 53, and adding the server's IP
   to mailcow's **API allow-list** and **Fail2ban whitelist**).

## Day-to-day

```bash
./deploy/aws/deploy.sh            # update after code or settings changes (no downtime for settings-only changes)
./deploy/aws/deploy.sh status     # address, IP, health
./deploy/aws/deploy.sh logs       # live logs
./deploy/aws/deploy.sh shell      # a terminal on the server (no SSH needed)
./deploy/aws/deploy.sh destroy    # remove everything (keeps a final data snapshot)
```

To change a setting (say, turn off free sign-ups), edit `config.env` and run `deploy.sh` again.
To make the server bigger, change `INSTANCE_TYPE` and run `deploy.sh` (about 2 minutes of downtime).

## Restoring from a backup
EC2 → **Snapshots** → pick a `mail-client-data` snapshot → **Create volume** (same Availability Zone) → stop the server →
detach the current data volume → attach the new one as `/dev/sdf` → start the server.

## If your mailcow server is also on AWS
- AWS blocks outgoing port 25 by default. Ask AWS to remove it (search "Request to remove email sending limitations") or
  mail won't leave your server.
- Ask for **reverse DNS** for mailcow's Elastic IP to match its hostname (same form). It's important for deliverability.
- Put both in the same region; the app talks to mailcow over its public hostname, so no extra networking is needed.
