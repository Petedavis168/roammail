#!/usr/bin/env bash
# Nightly mailcow backup -> S3. Run on the mailcow server as root, e.g. from /etc/cron.d/mailcow-backup:
#   30 2 * * * root /opt/roammail/backup-to-s3.sh >> /var/log/mailcow-backup.log 2>&1
#
# Settings (in /etc/mailcow-backup.env):
#   MAILCOW_DIR=/opt/mailcow-dockerized
#   BACKUP_BUCKET=<BucketName output of backup-bucket.yaml>
#   AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...  AWS_DEFAULT_REGION=us-east-1
#   BACKUP_PASSPHRASE=<long random string>   # backups are encrypted before they leave the server
#   HEALTHCHECK_URL=                         # optional: e.g. a healthchecks.io ping URL
#   ALERT_SNS_TOPIC_ARN=                     # optional: alert topic for failures
set -euo pipefail
umask 077
# shellcheck disable=SC1091
[ -f /etc/mailcow-backup.env ] && . /etc/mailcow-backup.env
MAILCOW_DIR="${MAILCOW_DIR:-/opt/mailcow-dockerized}"
: "${BACKUP_BUCKET:?set BACKUP_BUCKET in /etc/mailcow-backup.env}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE in /etc/mailcow-backup.env}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
WORK="/var/backups/mailcow"
HOST="$(hostname -f)"

fail() {
  echo "$(date -u) BACKUP FAILED: $*"
  [ -n "${ALERT_SNS_TOPIC_ARN:-}" ] && aws sns publish --topic-arn "$ALERT_SNS_TOPIC_ARN" --subject "mailcow backup failed on $HOST" --message "$*" >/dev/null || true
  [ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 "$HEALTHCHECK_URL/fail" >/dev/null || true
  exit 1
}
trap 'fail "line $LINENO"' ERR

command -v aws >/dev/null || fail "AWS CLI is not installed (apt-get install -y awscli)"
mkdir -p "$WORK"; chmod 700 "$WORK"

# 1. mailcow's own backup tool: mail, database, Redis, Rspamd, certificates, config
echo "$(date -u) starting mailcow backup"
cd "$MAILCOW_DIR"
MAILCOW_BACKUP_LOCATION="$WORK" THREADS="$(nproc)" ./helper-scripts/backup_and_restore.sh backup all --delete-days 2
NEWEST="$(find "$WORK" -maxdepth 1 -type d -name 'mailcow-*' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
[ -n "$NEWEST" ] || fail "mailcow backup produced nothing"

# 2. Encrypt and stream to S3 (nothing readable leaves the server)
ARCHIVE="mailcow/$HOST/$STAMP.tar.gpg"
cp "$MAILCOW_DIR/mailcow.conf" "$NEWEST/mailcow.conf"
PASSFILE="$(mktemp)"; chmod 600 "$PASSFILE"; printf '%s' "$BACKUP_PASSPHRASE" > "$PASSFILE"
tar -C "$(dirname "$NEWEST")" -cf - "$(basename "$NEWEST")" \
  | gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 --passphrase-file "$PASSFILE" -o - \
  | aws s3 cp - "s3://$BACKUP_BUCKET/$ARCHIVE" --expected-size 200000000000 --only-show-errors
shred -u "$PASSFILE" 2>/dev/null || unlink "$PASSFILE"

# 3. Prove the upload exists
aws s3 ls "s3://$BACKUP_BUCKET/$ARCHIVE" >/dev/null || fail "upload not found in S3"
echo "$(date -u) backup uploaded to s3://$BACKUP_BUCKET/$ARCHIVE"
[ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
