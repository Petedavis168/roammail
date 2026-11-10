// Text of the public legal pages. Written for Roammail in plain English; covers the same ground as the big
// consumer mail providers' terms, privacy notices and acceptable-use rules (see docs/legal/COMPLIANCE_CHECK.md).
// NOT LEGAL ADVICE: have a lawyer review before launch. Operators can override any page (see privacy.js).
import { config } from './config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const LEGAL_DOCS = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  'acceptable-use': 'Acceptable Use Policy',
  dpa: 'Data Processing Addendum (business customers)',
  subprocessors: 'Subprocessors',
  security: 'Security & Responsible Disclosure',
};

export function legalBody(doc) {
  const L = config.legal; const B = config.billing;
  const app = esc(config.appName); const co = esc(L.company);
  const mail = (a) => (a ? `<a href="mailto:${esc(a)}">${esc(a)}</a>` : 'our support team');
  const addr = L.address ? esc(L.address) : '[postal address to be added before launch]';
  const usd = (n) => `US$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
  switch (doc) {
    // ------------------------------------------------------------------------------------------ TERMS
    case 'terms': return `
<p>These Terms of Service ("Terms") are an agreement between you and ${co} ("we", "us"), which operates ${app}. They apply when you create an account or use ${app}
on the web, by phone or desktop mail apps, or through our APIs. Please read them. If you use ${app} for a business, you agree on behalf of that business.</p>

<h2>1. Who can use ${app}</h2><ul>
<li>You must be at least 16 years old (or older if your country sets a higher age for using online services without a parent's consent).</li>
<li>You may not use ${app} if the law, including trade sanctions, forbids it, or if we previously closed your account for breaking these Terms.</li>
<li>Give accurate sign-up details and keep your recovery email up to date. It's how we help you get back in.</li></ul>

<h2>2. Your account and security</h2><ul>
<li>Keep your password private. We strongly recommend 2-step verification. You're responsible for what happens in your account unless it was caused by our failure.</li>
<li>Tell us right away at ${mail(L.security)} if you think someone else got into your account.</li>
<li>One person per free account. Don't sell, rent or transfer accounts, and don't create accounts by automated means.</li></ul>

<h2>3. Free and business accounts</h2><ul>
<li><b>Free accounts</b> (addresses ending in @${esc(config.signup.domain || 'our domain')}) are for personal use and have limits on storage, sending and recipients, which we may adjust to protect the service.</li>
<li><b>Business accounts</b> use a domain the business controls. The business's administrators can create, read the settings of, suspend, archive and delete their users' mailboxes, and may keep copies of mail under the business's own policies. If you use a business account, your employer's or organisation's policies also apply to you, and questions about your mailbox's data should go to them first.</li>
<li>A business is responsible for its users following these Terms and for having the right to use its domain.</li></ul>

<h2>4. Paid plans, billing and cancelling</h2><ul>
<li>Business email costs ${usd(B.perUserMonthly)} per mailbox per month or ${usd(B.perUserYearly)} per mailbox per year, plus any sales tax or VAT. Prices are shown before you buy. Friendly Web Services customers may receive their first mailbox free as described at checkout. Shared mailboxes and the company archive are included at no extra cost.</li>
<li><b>Your plan renews automatically</b> each month or year until you cancel. We charge the card on file through our payment processor, Stripe. Adding a user adds a paid seat straight away with a prorated charge. Removing one reduces your next bill.</li>
<li><b>Cancel any time online</b> in Admin → Billing → Manage billing. Cancelling stops future renewals. You keep access until the end of the paid period. We don't give refunds for partial periods unless the law requires it or we say otherwise in writing.</li>
<li>${B.trialDays ? `Free trials last ${B.trialDays} days. We email you before a trial ends, and the plan starts automatically unless you cancel first.` : 'If we offer a free trial, we will tell you its length and remind you before it ends; the plan starts automatically unless you cancel first.'}</li>
<li>If a payment fails, we'll email your administrators and retry. If the subscription ends unpaid, mailboxes beyond any free allowance are paused ${B.graceDays} days later. Mail is not deleted when an account is paused.</li>
<li>We'll give at least 30 days' notice by email before changing the price of your plan. The change applies from your next renewal, and you can cancel before it does.</li></ul>

<h2>5. Your content</h2><ul>
<li>Your email, files, contacts and calendars ("your content") remain yours.</li>
<li>You give us permission to store, copy, transmit, scan and display your content <b>only as needed to run ${app} for you</b>. For example: delivering mail, filtering spam and viruses, indexing it so you can search, making backups, and showing it in your apps. This permission ends when your content is deleted from our systems, apart from backups that expire on their normal schedule.</li>
<li>We don't sell your content, don't use it for advertising, and don't use it to train AI models.</li>
<li>You're responsible for your content and must have the right to send it.</li></ul>

<h2>6. Rules</h2><p>You must follow our <a href="/legal/acceptable-use">Acceptable Use Policy</a>. It covers spam, phishing, malware, illegal content, bulk-sending rules and other abuse.</p>

<h2>7. Suspension and closure</h2><ul>
<li>We may limit features, pause sending, suspend or close an account that breaks these Terms or the Acceptable Use Policy, that puts other people or the service at risk, or when the law requires it.</li>
<li>Some protections act automatically. For example, sending is paused when an account starts sending spam (often because its password was stolen). You can still read your mail while sending is paused.</li>
<li>Unless it would be unlawful or create a risk of harm, we'll tell you what happened and why. You can <b>ask us to review the decision</b> by contacting ${mail(L.contact)} or using the <a href="/help/contact">support form</a>. A person will look at it.</li>
<li>Where we can, we give you a chance to download your mail before an account is closed. We don't do this where the account was used for serious abuse or the law forbids it.</li></ul>

<h2>8. Ending your account</h2><ul>
<li>You can delete a free account at any time in Settings → Privacy. Download your mail first (Settings → Privacy → Download).</li>
<li>Free accounts with no sign-ins for 12 months may be closed. Before that we'll email the account and its recovery address at least 30 days in advance. Signing in keeps it open.</li>
<li>Business customers can cancel in Admin → Billing. Their data is handled as described in the <a href="/legal/dpa">Data Processing Addendum</a>.</li></ul>

<h2>9. Changes to ${app} and these Terms</h2><p>We keep improving ${app} and may add, change or remove features. If a change significantly reduces what a paid plan includes, we'll tell you in advance and you may cancel. If we change these Terms in a way that matters to you, we'll give at least 30 days' notice by email or in the app (sooner only for legal or security reasons). Continuing to use ${app} after the change takes effect means you accept it. If you don't agree, you can stop using ${app} and delete your account.</p>

<h2>10. Third-party services</h2><p>Some features rely on other companies. Payments go through Stripe. Video-meeting links open a meeting service in your browser. Push notifications go through your browser maker's push service, or through Google (Android app) and Apple (iPhone app) for the ${app} phone apps. Those services have their own terms. See <a href="/legal/subprocessors">Subprocessors</a>.</p>

<h2>11. Copyright complaints</h2><p>If you believe content sent or stored using ${app} infringes your copyright, send a notice to ${mail(L.dmca || L.contact)}. Include:</p>
<ul><li>the work you say is infringed</li><li>where the infringing material is</li><li>your contact details</li><li>a statement of good-faith belief</li><li>a statement, under penalty of perjury, that you're authorised to act</li><li>your signature</li></ul>
<p>We respond under the US Digital Millennium Copyright Act and close the accounts of repeat infringers where appropriate.</p>

<h2>12. Requests from governments and courts</h2><p>We only disclose user data in response to valid legal process. We review each request and push back on requests that are too broad. Unless the law or a court order forbids it, or there's an emergency, we tell the affected user before we disclose. For business accounts we refer requests to the business where we can.</p>

<h2>13. Service availability and disclaimers</h2><p>We work hard to keep ${app} running and your data safe, with encryption, monitoring and backups (see our <a href="/status">status page</a>). But ${app} is provided "as is" and "as available". Except where the law doesn't allow it, we don't promise it will be uninterrupted or error-free, or that every message will be delivered. Keep copies of anything you can't afford to lose.</p>

<h2>14. Liability</h2><p>To the fullest extent the law allows:</p>
<ul><li>we're not liable for indirect, special or consequential losses, or for lost profits, revenue or data, arising from ${app}</li>
<li>our total liability for any claim relating to ${app} is limited to the greater of (a) the amount you paid us in the 12 months before the claim and (b) US$100</li></ul>
<p>Nothing in these Terms limits liability that can't legally be limited, or your rights as a consumer under the law where you live.</p>

<h2>15. Business customers' responsibilities</h2><p>A business customer will defend us against claims by third parties arising from its users' content, or from its breach of these Terms or the Acceptable Use Policy, and will cover the resulting costs that a court awards or that it agrees to in a settlement.</p>

<h2>16. General</h2><ul>
<li><b>Governing law:</b> the laws of ${esc(L.country)} govern these Terms, apart from conflict-of-law rules. Consumers keep the protection of the mandatory laws where they live.</li>
<li>If one part of these Terms can't be enforced, the rest still applies. Not enforcing a term right away doesn't waive it.</li>
<li>We aren't responsible for delays caused by events beyond our reasonable control.</li>
<li>You may not transfer these Terms without our consent. We may transfer them as part of a merger or sale of the business, with notice to you.</li>
<li>These Terms, with the policies linked here (and for business customers, the Data Processing Addendum), are the whole agreement between us about ${app}.</li>
<li>We'll send important notices about your account, security and billing by email or in the app. You can't opt out of these service messages while you have an account.</li></ul>

<h2>17. Contact</h2><p>${co}, ${addr}. Email ${mail(L.contact)}. Version ${esc(L.termsVersion)}.</p>`;

    // ------------------------------------------------------------------------------------------ PRIVACY
    case 'privacy': return `
<p>This policy explains what personal information ${co} ("we") collects when you use ${app}, why, who we share it with, how long we keep it, and your choices.
Our approach is simple: <b>we run an email service, we don't sell data and we don't show ads.</b></p>

<h2>1. Who is responsible</h2><ul>
<li>For <b>free accounts</b> and for running the service, ${co} is the controller of your personal information.</li>
<li>For <b>business accounts</b>, the business that owns the domain is the controller of its users' mailboxes and we process that data on its behalf under our <a href="/legal/dpa">Data Processing Addendum</a>. If you have a business account, the business's own privacy notice also applies. Send requests about your mailbox to them.</li></ul>

<h2>2. What we collect</h2>
<table><tr><th>Information</th><th>Examples</th><th>Why</th></tr>
<tr><td>Password-protected emails</td><td>The email you protected, encrypted with the password you chose (we never keep the password, so we can’t read it), its hint, recipients, expiry date, when it was opened and how many wrong passwords were tried</td><td>To let the people you sent it to open it, and to stop password guessing. Deleted when it expires or you withdraw it</td></tr>
<tr><td>Account details</td><td>Name, address, password (stored by our mail server in hashed form), recovery email, mobile number (stored encrypted), date of birth, 2-step verification settings, passkeys you add (the public key, the device name and, so our mail server can open your mailbox, your password stored encrypted with it), if your company turned on Microsoft or Google sign-in and you linked your work account: that account’s ID, its email address and your company’s ID with them (and your password stored encrypted with the link), terms version accepted</td><td>To create and secure your account, help you recover it, and confirm you're old enough to use the service</td></tr>
<tr><td>Your content</td><td>Emails and attachments, folders, contacts, calendars, signatures, templates, rules, settings</td><td>To provide the service</td></tr>
<tr><td>Business profile</td><td>Job title, department and phone numbers set by your administrator. Groups and shared mailboxes you belong to</td><td>Company directory, signatures and groups</td></tr>
<tr><td>Security and usage records</td><td>Sign-in times, IP addresses, browser/device type, sending counts, admin actions (audit log)</td><td>To protect accounts, prevent abuse and spam, and investigate problems</td></tr>
<tr><td>Billing (business)</td><td>Business name, billing contact, plan and number of users, Stripe customer and subscription IDs, billing address and tax ID if you give them at checkout</td><td>To charge for paid plans and meet tax obligations. <b>Card details go straight to Stripe. We never see or store them.</b></td></tr>
<tr><td>Support and reports</td><td>Messages you send to support; abuse reports you make or that are made about an account</td><td>To help you and keep the service safe</td></tr>
<tr><td>Device notifications</td><td>A push address for each browser where you turn on notifications; in the phone apps, the device token Google or Apple gives the app</td><td>To tell you about new mail</td></tr>
<tr><td>AI help (only if you turn it on)</td><td>The conversation you ask to summarise or reply to, or the sender, subject and first lines of your unread inbox messages when you ask what needs a reply; how many AI requests you've made this month</td><td>To produce the summary or suggestions you asked for. It's sent to Anthropic (Claude) only when you click an AI button, isn't kept by us, and isn't used to train AI models. Business admins can turn AI help off for their company</td></tr>
<tr><td>Phone apps</td><td>The ${app} Android and iPhone apps use the same account and data as the website. They add only the notification token above. Files you save or share from the app go where you choose. The apps have no ads or tracking</td><td>To provide the service on your phone</td></tr></table>
<p>We don't knowingly collect information from children under 16, and we don't ask for sensitive information. Your emails may contain anything you or others choose to write.</p>

<h2>3. How your email is processed</h2><ul>
<li>Automated systems scan messages to filter spam, phishing and viruses, to apply your rules, and to build your search index. They also look at outgoing messages, so accounts sending spam can be paused automatically (see the <a href="/legal/terms">Terms</a> for how to ask for a review).</li>
<li>People at ${co} don't read your email, except when:<ul>
<li>you ask us to, for example in a support request</li>
<li>it's needed to investigate abuse or a security incident</li>
<li>the law requires it</li></ul></li>
<li>Remote images are blocked until you allow them, so senders can't track when you open their messages.</li>
<li>We don't use your content for advertising, profiling or training AI models.</li>
<li>Business administrators may switch on the company archive, which keeps copies of mail for that business's records. Businesses must tell their users when they do this.</li></ul>

<h2>4. Legal bases (EU/UK users)</h2><ul>
<li><b>Contract:</b> providing the service you signed up for.</li>
<li><b>Legitimate interests:</b> security, fraud and spam prevention, and improving reliability. We balance these against your rights.</li>
<li><b>Legal obligation:</b> tax records, and responding to lawful requests.</li>
<li><b>Consent:</b> optional things like device notifications, which you can withdraw at any time.</li></ul>

<h2>5. Who we share information with</h2><ul>
<li><b>Service providers</b> that help us run ${app}: hosting, payments, password-breach checks, bot protection and push delivery. They may use the information only to provide their service to us. They're listed on our <a href="/legal/subprocessors">Subprocessors</a> page.</li>
<li><b>Your business</b>, if you have a business account (its administrators).</li>
<li><b>The people you email</b>, of course, and their mail providers.</li>
<li><b>Authorities</b>, only in response to valid legal process or to prevent serious harm (see the Terms, "Requests from governments and courts"), and to the National Center for Missing &amp; Exploited Children where US law requires it.</li>
<li><b>A buyer of our business</b>, if we're ever merged or sold, under this same policy, with notice to you.</li></ul>
<p>We do <b>not</b> sell personal information, and we don't share it for cross-context behavioural advertising.</p>

<h2>6. Where data is stored</h2><p>Our servers are in the United States, on Amazon Web Services. If you're outside the US, your information is transferred there. We protect those transfers with the European Commission's Standard Contractual Clauses (and the UK addendum) where required.</p>

<h2>7. How long we keep it</h2><ul>
<li><b>Your content:</b> until you or your business delete it. Deleted items in Trash and Junk are removed as your settings say.</li>
<li><b>Deleted accounts:</b> removed from live systems straight away, and from backups within 35 days. We keep a record that a free address existed so it isn't given to someone else and used to receive your mail.</li>
<li><b>Sign-in and security records:</b> ${L.retentionDays} days. <b>Admin audit logs:</b> about 13 months.</li>
<li><b>Billing records:</b> held by Stripe as long as tax law requires (usually 7 years).</li>
<li><b>Support requests and abuse reports:</b> up to 2 years after they're closed.</li>
<li><b>Device notification addresses:</b> until you turn notifications off or 30 days after the device was last used.</li></ul>

<h2>8. Cookies</h2><p>${app} uses one essential cookie that keeps you signed in, and stores your display preferences in your browser. We don't use advertising or tracking cookies, or third-party analytics. If sign-up bot protection is turned on, Cloudflare Turnstile runs on the sign-up page only.</p>

<h2>9. Your rights and choices</h2><ul>
<li><b>See and download</b> your mail at any time (Settings → Privacy → Download). <b>Correct</b> your details in Settings. <b>Delete</b> a free account in Settings → Privacy.</li>
<li>Depending on where you live, you may also have the right to:<ul>
<li>access the personal information we hold about you</li>
<li>get a portable copy</li>
<li>have it corrected or deleted</li>
<li>restrict or object to some processing</li>
<li>withdraw consent</li></ul>
California and other US state residents have similar rights to know, delete and correct. We won't treat you differently for using them.</li>
<li>To make a request, email ${mail(L.privacy || L.contact)}. We'll check it's really you, using your account or recovery email. We'll respond within 30 days (45 days under US state laws), or tell you if we need longer. You may use an authorised agent with your written permission.</li>
<li>Because we don't sell or share personal information for advertising, there's nothing to opt out of. We also honour Global Privacy Control signals.</li>
<li>You can complain to your data protection authority. We'd appreciate the chance to fix things first.</li></ul>

<h2>10. Security</h2><p>We encrypt data in transit (TLS) and at rest, require 2-step verification for administrators, check passwords against known breaches, and limit and log staff access. See <a href="/legal/security">Security</a>.</p>
<p>If a breach affects your personal information, we'll tell you and the relevant authorities as the law requires: under GDPR, the authority within 72 hours of learning of it.</p>

<h2>11. Changes and contact</h2><p>We'll post changes here and email you about important ones in advance. Questions: ${mail(L.privacy || L.contact)}, ${co}, ${addr}.${L.euRep ? ` EU representative: ${esc(L.euRep)}.` : ''} Last updated ${esc(L.termsVersion)}.</p>`;

    // ------------------------------------------------------------------------------------------ AUP
    case 'acceptable-use': return `
<p>${app} only works if other mail providers trust mail from us. These rules keep it that way. They apply to all accounts, free and business.
Breaking them can lead to paused sending, suspension or closure (see the <a href="/legal/terms">Terms</a>).</p>

<h2>Never allowed</h2><ul>
<li><b>Child sexual abuse material</b> or any content that sexualises minors. We have zero tolerance. We remove it, close the account, and report it to the National Center for Missing &amp; Exploited Children and to law enforcement as the law requires.</li>
<li>Content that promotes terrorism or violent extremism, or threatens violence.</li>
<li>Phishing, scams, fraud, or impersonating a person, company or government. This includes faking the sender of a message.</li>
<li>Malware, ransomware, or links to them. Attacks on any system, including ours. Trying to get into accounts that aren't yours.</li>
<li>Harassment, stalking, threats, hate speech, or sharing someone's private information or intimate images without consent.</li>
<li>Infringing copyright, trademarks or other people's rights.</li>
<li>Anything illegal where you or the recipient are.</li></ul>

<h2>Spam and sending</h2><ul>
<li><b>No unsolicited bulk email.</b> Only email people who asked to hear from you. No purchased, rented or scraped lists.</li>
<li>${app} mailboxes are for person-to-person email. Newsletters and marketing campaigns must be sent through an email-marketing service built for them. Even then, you must follow the major mailbox providers' rules for bulk senders:<ul>
<li>authenticate your mail (SPF, DKIM and DMARC)</li>
<li>offer one-click unsubscribe and honour it within 2 days</li>
<li>keep spam complaints well below 0.3%</li>
<li>don't send from addresses that pretend to be Gmail, Yahoo or Outlook</li></ul></li>
<li>Commercial email must follow anti-spam laws such as the US CAN-SPAM Act, Canada's CASL and the EU/UK ePrivacy rules. That means a truthful subject and sender, your postal address, and an easy opt-out honoured within 10 business days.</li>
<li>Don't try to get around sending limits: by opening extra accounts, automating sign-ups, rotating addresses, or relaying mail for other people (no open relays).</li></ul>

<h2>Fair use of the service</h2><ul>
<li>Don't overload or disrupt ${app}: no automated scraping, cryptocurrency mining, or use as file storage unrelated to email.</li>
<li>Don't resell ${app} or give access to accounts to others, except a business giving accounts to its own people.</li>
<li>Don't probe, scan or test our systems for vulnerabilities, except under our <a href="/legal/security">responsible disclosure</a> rules.</li></ul>

<h2>How we enforce</h2><p>We act in proportion to the problem. Usually we start with a warning or by pausing sending. We act immediately for serious harm such as child abuse material, malware or active phishing. Automated systems may pause sending when an account sends spam. You can ask for a human review through ${mail(L.contact)}.</p>

<h2>Reporting abuse</h2><p>Report spam, phishing or abuse sent from ${app} at <a href="/abuse">${esc(config.publicUrl || '')}/abuse</a> or ${mail(L.abuse)}, ideally with the full message headers. Reports are confidential.</p>`;

    // ------------------------------------------------------------------------------------------ DPA
    case 'dpa': return `
<p>This Data Processing Addendum ("DPA") forms part of the ${app} <a href="/legal/terms">Terms</a> for business customers ("Customer"). It applies when ${co} processes personal data on the Customer's behalf. It is designed to meet Article 28 of the EU and UK GDPR, and the service-provider requirements of US state privacy laws such as the CCPA/CPRA.</p>
<h2>1. Roles and scope</h2><p>The Customer is the controller and ${co} is the processor (or "service provider"). The scope is:</p>
<ul>
<li><b>Subject matter:</b> hosting and operating business email, calendars and contacts for the Customer's domains.</li>
<li><b>Duration:</b> the term of the Customer's subscription, plus the deletion period below.</li>
<li><b>Nature and purpose:</b> storing, transmitting, filtering, indexing and backing up data to provide the service.</li>
<li><b>Data subjects:</b> the Customer's users and the people they correspond with.</li>
<li><b>Personal data:</b> email content and metadata, contacts, calendars, directory details, and security logs.</li></ul>
<h2>2. Instructions</h2><p>We process Customer personal data only on the Customer's documented instructions. The Terms, the Customer's use of the service and its admin settings are those instructions. The exception is where the law requires otherwise, in which case we'll tell the Customer unless the law forbids it. We won't sell the data, use it for advertising, or combine it with other data except as needed to provide the service.</p>
<h2>3. Confidentiality and security</h2><p>Everyone authorised to process the data is bound by confidentiality. We maintain the technical and organisational measures described on our <a href="/legal/security">Security</a> page. These include:</p>
<ul><li>encryption in transit and at rest</li><li>2-step verification for administrators</li><li>least-privilege access</li><li>logging</li><li>encrypted off-site backups</li><li>vulnerability management</li></ul>
<h2>4. Subprocessors</h2><p>The Customer authorises the subprocessors listed on our <a href="/legal/subprocessors">Subprocessors</a> page. We'll give at least 30 days' notice by email before adding or replacing one, and the Customer may object on reasonable data-protection grounds. If we can't resolve the objection, the Customer may cancel the affected service with a pro-rata refund. We impose data-protection terms on each subprocessor that are equivalent to this DPA, and remain responsible for them.</p>
<h2>5. Assistance</h2><p>We help the Customer, taking into account the nature of the processing, to:</p>
<ul><li>respond to data subject requests (admin tools allow export, correction and deletion of mailboxes)</li><li>carry out data protection impact assessments</li><li>consult with supervisory authorities</li></ul>
<h2>6. Personal data breaches</h2><p>We notify the Customer without undue delay, and in any case within 48 hours, after becoming aware of a personal data breach affecting Customer data. We include the information the Customer needs to meet its own notification duties, and keep it updated as we learn more.</p>
<h2>7. International transfers</h2><p>Data is processed in the United States. For transfers of EU/EEA personal data, the parties agree to the EU Standard Contractual Clauses (Commission Decision 2021/914, Module 2, controller to processor), incorporated by reference. For UK data, the UK International Data Transfer Addendum applies. For Swiss data, the clauses apply with the necessary changes.</p>
<h2>8. Return and deletion</h2><p>During the subscription, administrators can export any mailbox. When the subscription ends, the Customer has 30 days to export. We then delete Customer personal data from live systems, and from backups within a further 35 days, unless the law requires us to keep it.</p>
<h2>9. Audits</h2><p>On request, we provide the information needed to demonstrate compliance with this DPA, including summaries of security testing. Where that isn't enough, or a regulator requires it, the Customer may carry out an audit once a year with 30 days' notice. The audit must take place during business hours, under confidentiality, and at the Customer's expense.</p>
<h2>10. Liability and precedence</h2><p>The liability terms of the Terms apply to this DPA. If this DPA conflicts with the Terms on data protection, this DPA wins. Contact: ${mail(L.privacy || L.contact)}.</p>`;

    // ------------------------------------------------------------------------------------------ SUBPROCESSORS
    case 'subprocessors': return `
<p>These companies help us run ${app}. Each receives only what it needs, and is bound to protect it.</p>
<table><tr><th>Company</th><th>What they do</th><th>Data involved</th><th>Location</th></tr>
<tr><td>Amazon Web Services</td><td>Servers, storage, databases, backups</td><td>All service data (encrypted)</td><td>United States</td></tr>
<tr><td>Stripe</td><td>Payments, invoices, tax calculation (business plans)</td><td>Billing contact, business name, billing address, card details (entered directly with Stripe)</td><td>United States</td></tr>
<tr><td>Have I Been Pwned (Troy Hunt)</td><td>Checks whether a new password appeared in known breaches</td><td>The first 5 characters of a one-way hash of the password. Never the password or your address.</td><td>Global (Cloudflare)</td></tr>
<tr><td>Cloudflare (Turnstile), if enabled</td><td>Stops bots creating accounts</td><td>Browser signals on the sign-up page</td><td>Global</td></tr>
<tr><td>Apple, Google, Mozilla, Microsoft push services</td><td>Deliver new-mail notifications to browsers where you turned them on</td><td>Sender name and subject, end-to-end encrypted (the push service can't read it)</td><td>Global</td></tr>
<tr><td>Anthropic (Claude)</td><td>AI help, only for people who turn it on</td><td>The emails a person asks AI help to summarise or reply to; sender, subject and first lines of unread mail for "what needs my reply". Not used for training</td><td>United States</td></tr>
<tr><td>Google Firebase Cloud Messaging and Apple Push Notification service</td><td>Deliver new-mail notifications to the ${app} Android and iPhone apps</td><td>Device token, sender name and subject (encrypted in transit, readable by Google or Apple while delivering)</td><td>Global</td></tr>
${process.env.FREE_RELAYHOST_ID || process.env.BUSINESS_RELAYHOST_ID ? '<tr><td>Outbound mail relay (e.g. Amazon SES)</td><td>Delivers outgoing mail to recipients</td><td>Outgoing messages</td><td>United States</td></tr>' : ''}
</table>
<p>Video-meeting links open ${esc((process.env.MEETING_URL || 'https://meet.jit.si').replace(/^https?:\/\//, ''))} in your browser only when you or a guest click them. No data is sent in advance.</p>
<p>Business customers get 30 days' email notice before we add or replace a subprocessor (see the <a href="/legal/dpa">DPA</a>). Last updated ${esc(L.termsVersion)}.</p>`;

    // ------------------------------------------------------------------------------------------ SECURITY
    case 'security': return `
<p>We take the security of ${app} and your data seriously. The highlights:</p>
<ul><li>All connections use HTTPS/TLS. Data, databases and backups are encrypted at rest. Mail backups are encrypted before they leave the mail server.</li>
<li>2-step verification (authenticator app) with backup codes and a safe lost-phone process. Administrators are required to use it.</li>
<li>Email content is sanitised and shown in an isolated frame. Remote content is blocked by default. Suspicious messages carry a warning.</li>
<li>Passwords are checked against known data breaches. Repeated failed sign-ins are throttled. You get alerts about sign-ins from new devices, and you can see and sign out your devices.</li>
<li>A web application firewall, rate limits and automatic detection of accounts sending spam.</li>
<li>Staff access to production is limited, protected with 2-step verification and logged. Support actions on accounts are recorded with a reason, and the user is told.</li>
<li>Automated security testing of every change and continuous dependency monitoring.</li></ul>
<h2>If something goes wrong</h2><p>We have an incident response plan. If a breach affects your personal information, we'll tell you and the authorities as the law requires: business customers within 48 hours, under GDPR the authority within 72 hours. Live service status is on our <a href="/status">status page</a>.</p>
<h2>Reporting a vulnerability</h2><p>Please email ${mail(L.security)} with details and steps to reproduce (also listed in <a href="/.well-known/security.txt">security.txt</a>). We'll acknowledge within 3 business days and keep you updated.</p>
<p>Please give us reasonable time to fix issues before disclosure, don't access other people's data, and don't degrade the service. We won't take legal action against good-faith research that follows these rules.</p>`;
    default: return '';
  }
}
