# Monitoring and alerts

Every alarm emails the SNS topic `roammail-alerts` (us-east-2). Subscribers include petedavis168@gmail.com.
Each alarm emails again when it recovers ("OK").

| Alarm | What it means | First thing to check |
|---|---|---|
| RoamMail - website unreachable from the internet | The uptime canary (CloudWatch Synthetics `roammail-uptime`, every 5 min) couldn't load `https://roammail.net/healthz` or `https://login.roammail.net/healthz` twice in a row | DNS, certificate, load balancer, then the app |
| RoamMail - SITE DOWN (no healthy servers) | The load balancer has no healthy app server | ECS service roammail-web events and logs |
| RoamMail - unhealthy app servers | At least one app server is failing health checks | Same |
| RoamMail - errors spiking in the app | More than 20 `APP_ERROR` lines in 5 minutes from the server, the worker, people's browsers or the phone apps | CloudWatch Logs `/roammail/web` and `/roammail/worker`, search `APP_ERROR` |
| RoamMail - app errors (5xx) | The load balancer is returning server errors | Same |
| RoamMail - slow responses (p95 over 2s) | Pages and API calls are slow | Database and CPU alarms, recent deploys |
| RoamMail - background worker stopped | No worker task has run for 10 minutes: notifications, reminders, reports and imports stop | ECS service roammail-worker |
| RoamMail - app CPU high even after scaling | Busy even at the scaling limit | Raise the service's max tasks |
| RoamMail - database CPU / connections / storage | The Postgres database (RDS) is under pressure | RDS console |
| RoamMail - egress relay reboot / auto-recover | The sending relay instance failed and was rebooted or recovered | EC2 console |

## Errors from browsers and the phone apps
`client/src/errors.js` reports uncaught errors, failed promises (not ordinary "wrong password" answers or offline
errors) and screen crashes (`ErrorBoundary`). It sends them to `POST /api/client-error`, which logs one line per
error per minute:

    APP_ERROR client android TypeError: … at /assets/index-abc.js:1:200 on /12345678/inbox v=abc

These reports contain no email content. The page path is cut before message IDs, folder names and query strings. Native crashes outside the web view
appear in Play Console → Android vitals and App Store Connect → Crashes.

## Made outside CloudFormation (8 Nov 2026)
These were created directly. A `roammail-prod` stack update won't remove them, but they aren't in the template:
- log metric filters `app-errors` on `/roammail/web` and `/roammail/worker` (metric `RoamMail/AppErrors`)
- alarms "errors spiking in the app", "background worker stopped", "website unreachable from the internet"
- Synthetics canary `roammail-uptime` (code: `deploy/uptime-canary`), its S3 bucket `roammail-canary-515579969872`
  (artifacts kept 14 days) and IAM role `roammail-uptime-canary`

Route 53 health checks weren't used. Their alarms must live in us-east-1, and the organization's policy blocks that region.
