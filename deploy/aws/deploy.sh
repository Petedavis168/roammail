#!/usr/bin/env bash
# One-command AWS deployment for the mail client.
#   ./deploy/aws/deploy.sh            create or update everything
#   ./deploy/aws/deploy.sh status     show URL, IP and health
#   ./deploy/aws/deploy.sh logs       follow the app logs
#   ./deploy/aws/deploy.sh shell      open a shell on the server (no SSH needed)
#   ./deploy/aws/deploy.sh destroy    delete everything (keeps a final data snapshot)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONFIG="${CONFIG:-$HERE/config.env}"
CMD="${1:-deploy}"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m ✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "AWS CLI not found. Run this in AWS CloudShell, or install the AWS CLI."
[ -f "$CONFIG" ] || die "Missing $CONFIG. Copy deploy/aws/config.example.env to deploy/aws/config.env and fill it in."

# Read config (KEY=VALUE lines only; values are not executed)
declare -A CFG=()
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
  v="${BASH_REMATCH[2]}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  CFG["${BASH_REMATCH[1]}"]="$v"
done < "$CONFIG"
get() { echo "${CFG[$1]:-${2:-}}"; }

STACK="$(get STACK_NAME mail-client)"
REGION="$(get AWS_REGION "${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}")"
[ -n "$REGION" ] || die "Set AWS_REGION in config.env (e.g. us-east-1)"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || die "AWS credentials not working"
BUCKET="${STACK}-releases-${ACCOUNT}-${REGION}"
PARAM="/${STACK}/env"

output() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true; }
stack_exists() { aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; }

run_on_server() {
  local id; id="$(output InstanceId)"; [ -n "$id" ] || die "Server not found"
  local cmd_id
  cmd_id="$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
    --comment "mail-client: $1" --parameters "commands=[\"$2\"]" --timeout-seconds 1200 --query Command.CommandId --output text)"
  say "Running on server: $1 (this takes a few minutes)…"
  local status=InProgress
  while [[ "$status" == InProgress || "$status" == Pending || "$status" == Delayed ]]; do
    sleep 10
    status="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$id" --query Status --output text 2>/dev/null || echo Pending)"
  done
  aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$id" --query StandardOutputContent --output text | tail -5
  [ "$status" == Success ] || { aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$id" --query StandardErrorContent --output text | tail -20; die "Update failed ($status). The previous version is still running."; }
}

case "$CMD" in
  status)
    stack_exists || die "Not deployed yet"
    ok "App:        $(output AppUrl)"
    ok "Public IP:  $(output PublicIp)"
    url="$(output AppUrl)"
    if curl -fsS -m 10 "$url/healthz" >/dev/null 2>&1; then ok "Health:     OK"; else warn "Health:     not reachable yet (DNS or certificate may still be propagating)"; fi
    exit 0 ;;
  logs)
    aws logs tail "/${STACK}/app" --follow --since 30m ;;
  shell)
    aws ssm start-session --target "$(output InstanceId)" ;;
  destroy)
    stack_exists || die "Nothing to delete"
    warn "This deletes the server, its IP address and alarms. A final snapshot of the data disk is kept."
    read -r -p "Type the stack name ($STACK) to confirm: " c; [ "$c" == "$STACK" ] || die "Cancelled"
    aws cloudformation delete-stack --stack-name "$STACK"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK"
    ok "Deleted. Snapshot of the data disk is in EC2 → Snapshots. Release bucket s3://$BUCKET and parameter $PARAM were kept."
    exit 0 ;;
  deploy) ;;
  *) die "Unknown command: $CMD (use: deploy | status | logs | shell | destroy)" ;;
esac

# ---------------------------------------------------------------- validate config
APP_DOMAIN="$(get APP_DOMAIN)"
[[ "$APP_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] && [ "$APP_DOMAIN" != webmail.yourdomain.com ] || die "Set APP_DOMAIN in config.env"
for k in IMAP_HOST MAIL_HOSTNAME MAILCOW_API_KEY SUPERADMIN_EMAILS; do
  [ -n "$(get $k)" ] && [[ "$(get $k)" != *yourdomain.com* ]] || die "Set $k in config.env"
done

say "Deploying '$STACK' to account $ACCOUNT in $REGION"

# ---------------------------------------------------------------- secrets -> SSM Parameter Store (encrypted)
SESSION_SECRET="$(aws ssm get-parameter --name "$PARAM" --with-decryption --query Parameter.Value --output text 2>/dev/null | sed -n 's/^SESSION_SECRET=//p' || true)"
[ -n "$SESSION_SECRET" ] || SESSION_SECRET="$(openssl rand -hex 32)"
ENVFILE="$(mktemp)"; trap 'rm -f "$ENVFILE" "${TARBALL:-}"' EXIT
{
  echo "# Generated by deploy.sh - edit deploy/aws/config.env and re-run instead"
  echo "PUBLIC_URL=https://$APP_DOMAIN"
  echo "MAILCOW_API_URL=$(get MAILCOW_API_URL "https://$(get MAIL_HOSTNAME)")"
  echo "SMTP_HOST=$(get SMTP_HOST "$(get IMAP_HOST)")"
  echo "SESSION_SECRET=$SESSION_SECRET"
  echo "COOKIE_SECURE=true"
  echo "DATA_DIR=/data"
  for k in "${!CFG[@]}"; do
    case "$k" in STACK_NAME|AWS_REGION|INSTANCE_TYPE|HOSTED_ZONE_ID|ALERT_EMAIL|SMTP_HOST|MAILCOW_API_URL|SESSION_SECRET|PUBLIC_URL) continue ;; esac
    echo "$k=${CFG[$k]}"
  done
} > "$ENVFILE"
aws ssm put-parameter --name "$PARAM" --type SecureString --tier Standard --overwrite --value "file://$ENVFILE" >/dev/null
ok "Settings stored encrypted in SSM Parameter Store ($PARAM)"

# ---------------------------------------------------------------- release bundle -> private S3 bucket
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  if [ "$REGION" == us-east-1 ]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TLSOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{"Rules":[{"ID":"old-releases","Status":"Enabled","Filter":{"Prefix":"releases/"},"NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}'
  ok "Created private bucket s3://$BUCKET"
fi
TARBALL="$(mktemp --suffix=.tar.gz)"
VERSION="$(date -u +%Y%m%d-%H%M%S)"
tar -czf "$TARBALL" -C "$ROOT" --exclude='node_modules' --exclude='client/dist' --exclude='.git' --exclude='server/data' \
  --exclude='deploy/aws/config.env' --exclude='.env' --exclude='*.log' .
aws s3 cp "$TARBALL" "s3://$BUCKET/releases/$VERSION.tar.gz" --only-show-errors
aws s3 cp "$TARBALL" "s3://$BUCKET/releases/latest.tar.gz" --only-show-errors
ok "Uploaded release $VERSION ($(du -h "$TARBALL" | cut -f1))"

# ---------------------------------------------------------------- infrastructure
EXISTED=false; stack_exists && EXISTED=true
PARAMS=(
  "AppDomain=$APP_DOMAIN"
  "HostedZoneId=$(get HOSTED_ZONE_ID)"
  "InstanceType=$(get INSTANCE_TYPE t3.small)"
  "AlertEmail=$(get ALERT_EMAIL)"
  "EnableRoute53Dns=$(get ROUTE53_ENABLED false)"
  "ArtifactBucket=$BUCKET"
  "EnvParameterName=$PARAM"
)
if [ "$EXISTED" == false ]; then
  AMI="$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)"
  PARAMS+=("UbuntuAmi=$AMI")
  say "Creating server, disk, IP address, backups and alarms (about 10 minutes)…"
else
  say "Updating infrastructure (if anything changed)…"
fi
aws cloudformation deploy --stack-name "$STACK" --template-file "$HERE/template.yaml" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides "${PARAMS[@]}" \
  --tags app=mail-client || {
    aws cloudformation describe-stack-events --stack-name "$STACK" --max-items 15 \
      --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason]" --output text
    die "AWS deployment failed (reasons above). Server setup log: run '$0 shell' then 'sudo cat /var/log/mail-client-setup.log'"
  }

# The server deploys the release itself on first boot; on updates we tell it to redeploy.
if [ "$EXISTED" == true ]; then
  run_on_server "deploy $VERSION" "/opt/mail-client/redeploy.sh releases/$VERSION.tar.gz"
fi

IP="$(output PublicIp)"
echo
ok "Done!  https://$APP_DOMAIN   (server IP $IP)"
if [ "$EXISTED" == false ]; then
  echo
  say "Finish setup (one time):"
  if [ -z "$(get HOSTED_ZONE_ID)" ]; then
    echo "  1. At your DNS provider, create an A record:  $APP_DOMAIN  →  $IP"
  else
    echo "  1. DNS record for $APP_DOMAIN was created automatically."
  fi
  echo "  2. mailcow admin → System → Configuration → Access → API: add $IP to the allowed IPs."
  echo "  3. mailcow admin → System → Configuration → Options → Fail2ban: add $IP to the whitelist."
  [ -n "$(get ALERT_EMAIL)" ] && echo "  4. Click the confirmation link AWS emailed to $(get ALERT_EMAIL) to receive alerts."
  echo
  echo "  The HTTPS certificate is issued automatically once DNS points at the server (usually minutes)."
  echo "  Check anytime with:  $0 status"
fi
