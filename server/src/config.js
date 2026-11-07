import crypto from 'node:crypto';

const env = process.env;

if (!env.SESSION_SECRET) {
  console.warn('[config] SESSION_SECRET not set - using a random one. Sessions will not survive restarts.');
}

export const config = {
  port: Number(env.PORT || 3000),
  // Your mailcow server. Users only type email + password; the host is fixed here
  // so the app can't be abused to connect to arbitrary servers.
  imap: {
    host: env.IMAP_HOST || 'mail.example.com',
    port: Number(env.IMAP_PORT || 993),
    secure: (env.IMAP_SECURE ?? 'true') === 'true',
  },
  smtp: {
    host: env.SMTP_HOST || env.IMAP_HOST || 'mail.example.com',
    port: Number(env.SMTP_PORT || 587),
    secure: (env.SMTP_SECURE ?? 'false') === 'true', // true for 465, false for 587 (STARTTLS)
  },
  // Set to "false" only for local testing against a server with a self-signed cert.
  tlsRejectUnauthorized: (env.TLS_REJECT_UNAUTHORIZED ?? 'true') === 'true',
  // Optional: restrict logins to these domains (comma separated), e.g. "mycompany.com"
  allowedDomains: (env.ALLOWED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  sessionSecret: crypto.createHash('sha256').update(env.SESSION_SECRET || crypto.randomBytes(32)).digest(),
  sessionHours: Number(env.SESSION_HOURS || 24 * 7),
  cookieSecure: (env.COOKIE_SECURE ?? 'true') === 'true',
  maxAttachmentMb: Number(env.MAX_ATTACHMENT_MB || 25),
};

// ---------- accounts / admin ----------
config.dataDir = env.DATA_DIR || './data';
config.mailcow = {
  // Base URL of the mailcow admin UI, e.g. https://mail.example.com
  url: (env.MAILCOW_API_URL || `https://${config.imap.host}`).replace(/\/$/, ''),
  // mailcow UI -> System -> Configuration -> Access -> API (read-write key).
  // Add this app server's IP to the API's allowed IPs.
  apiKey: env.MAILCOW_API_KEY || '',
};
// Public hostname of your mail server (what customers point MX records at).
config.mailHostname = env.MAIL_HOSTNAME || config.imap.host;
// Free sign-ups get addresses on this domain (must already exist in mailcow).
config.signup = {
  enabled: (env.SIGNUP_ENABLED ?? 'true') === 'true',
  domain: (env.SIGNUP_DOMAIN || '').toLowerCase(),
  quotaMb: Number(env.SIGNUP_QUOTA_MB || 2048),
  perIpPerDay: Number(env.SIGNUP_PER_IP_PER_DAY || 3),
};
config.business = {
  maxMailboxes: Number(env.ORG_MAX_MAILBOXES || 50),
  defaultQuotaMb: Number(env.ORG_DEFAULT_QUOTA_MB || 5120),
  maxQuotaMb: Number(env.ORG_MAX_QUOTA_MB || 20480),
  totalQuotaMb: Number(env.ORG_TOTAL_QUOTA_MB || 102400),
};
// Comma separated emails that get the super-admin portal (you).
config.superAdmins = (env.SUPERADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// Optional AWS Route 53 auto-DNS (uses the EC2 instance role / standard AWS credentials).
config.route53Enabled = (env.ROUTE53_ENABLED ?? 'false') === 'true';
config.awsRegion = env.AWS_REGION || 'us-east-1';
// Anti-abuse for free sign-ups
config.signup.rateLimit = env.SIGNUP_SEND_LIMIT || '100/h'; // max outgoing mails per free account (mailcow rate limit), "" to disable
config.turnstile = { siteKey: env.TURNSTILE_SITE_KEY || '', secret: env.TURNSTILE_SECRET || '' };
// System mailbox used to send password-reset emails (create e.g. no-reply@yourdomain.com in mailcow)
config.systemMail = { user: env.SYSTEM_MAIL_USER || '', pass: env.SYSTEM_MAIL_PASS || '', from: env.SYSTEM_MAIL_FROM || env.SYSTEM_MAIL_USER || '' };
config.publicUrl = (env.PUBLIC_URL || (env.APP_DOMAIN ? `https://${env.APP_DOMAIN}` : '')).replace(/\/$/, '');
config.appName = env.APP_NAME || 'Roammail';
// ---------- device setup ----------
// Include calendar & contacts (mailcow SOGo CalDAV/CardDAV) in iPhone/Mac profiles
config.davEnabled = (env.DAV_ENABLED ?? 'true') === 'true';
config.davHost = env.DAV_HOST || config.mailHostname;
// Optional: sign .mobileconfig profiles so iOS shows "Verified" (PEM files, e.g. your mail server's TLS cert)
config.profileSign = { cert: env.PROFILE_SIGN_CERT || '', key: env.PROFILE_SIGN_KEY || '', chain: env.PROFILE_SIGN_CHAIN || '' };
// Sessions: absolute lifetime (SESSION_HOURS above) and inactivity timeout
config.sessionIdleHours = Number(env.SESSION_IDLE_HOURS || 72);
// Separate keys derived from SESSION_SECRET for each purpose
config.sealKey = Buffer.from(crypto.hkdfSync('sha256', config.sessionSecret, Buffer.alloc(0), 'mailclient/seal/v1', 32));
// Key rotation: set the old value here when changing SESSION_SECRET; data sealed with it keeps working
// (2-step secrets are re-encrypted with the new key the next time each user signs in).
config.sealKeyPrevious = env.SESSION_SECRET_PREVIOUS
  ? Buffer.from(crypto.hkdfSync('sha256', crypto.createHash('sha256').update(env.SESSION_SECRET_PREVIOUS).digest(), Buffer.alloc(0), 'mailclient/seal/v1', 32))
  : null;
// Admins (business admins and super-admins) must turn on 2-step verification before using the admin portal
config.requireAdmin2fa = (env.REQUIRE_ADMIN_2FA ?? 'true') === 'true';
// ---------- abuse limits (webmail; SMTP from other apps is limited by mailcow's rate limit) ----------
config.limits = {
  freePerDay: Number(env.FREE_SENDS_PER_DAY || 150),
  newAccountPerDay: Number(env.NEW_ACCOUNT_SENDS_PER_DAY || 25),   // free accounts younger than 48 hours
  businessPerDay: Number(env.BUSINESS_SENDS_PER_DAY || 2000),
  freeRecipientsPerMessage: Number(env.FREE_MAX_RECIPIENTS || 20),
  businessRecipientsPerMessage: Number(env.BUSINESS_MAX_RECIPIENTS || 100),
  signupsPerHour: Number(env.SIGNUPS_PER_HOUR || 60),
  checkBreachedPasswords: (env.CHECK_BREACHED_PASSWORDS ?? 'true') === 'true',
};
// ---------- legal & contacts ----------
config.legal = {
  company: env.LEGAL_COMPANY_NAME || 'Friendly Web Services',
  country: env.LEGAL_COUNTRY || 'the United States',
  contact: env.LEGAL_CONTACT_EMAIL || (env.SIGNUP_DOMAIN ? `support@${env.SIGNUP_DOMAIN}` : ''),
  abuse: env.ABUSE_EMAIL || (env.SIGNUP_DOMAIN ? `abuse@${env.SIGNUP_DOMAIN}` : ''),
  security: env.SECURITY_CONTACT_EMAIL || (env.SIGNUP_DOMAIN ? `security@${env.SIGNUP_DOMAIN}` : ''),
  termsVersion: env.TERMS_VERSION || '2026-11-07',
  retentionDays: Number(env.LOG_RETENTION_DAYS || 180),
};
// ---------- calendar & contacts (mailcow SOGo CalDAV/CardDAV) ----------
// Root of the DAV server. Discovery (current-user-principal → calendar/addressbook home) starts here.
config.davUrl = (env.DAV_URL || `https://${config.davHost}/SOGo/dav/`).replace(/\/?$/, '/');
// Who emails meeting invitations: "app" (this app sends iMIP emails) or "server" (SOGo sends them itself)
config.calendarInvites = env.CALENDAR_INVITES === 'server' ? 'server' : 'app';
// ---------- billing (Stripe) ----------
config.billing = {
  stripeKey: env.STRIPE_SECRET_KEY || '',
  webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  apiBase: (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, ''),
  // Stripe Price IDs for one user ("seat"): $4/month and $48/year by default (create them in the Stripe dashboard)
  priceMonthly: env.STRIPE_PRICE_MONTHLY || '',
  priceYearly: env.STRIPE_PRICE_YEARLY || '',
  perUserMonthly: Number(env.PRICE_PER_USER_MONTHLY || 4),
  perUserYearly: Number(env.PRICE_PER_USER_YEARLY || 48),
  currency: env.BILLING_CURRENCY || 'USD',
  friendlyFreeMailboxes: Number(env.FRIENDLY_FREE_MAILBOXES || 1),
  standardFreeMailboxes: Number(env.STANDARD_FREE_MAILBOXES || 0),
  graceDays: Number(env.BILLING_GRACE_DAYS || 7),
};
config.billing.enabled = (env.BILLING_ENABLED ?? (config.billing.stripeKey ? 'true' : 'false')) === 'true';
