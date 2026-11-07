# Store listing: Roammail

Copy these into Google Play Console (Main store listing) and App Store Connect (App Information / version page).

| Field | Text |
|---|---|
| App name | Roammail |
| Apple subtitle (30) | Business email, your way |
| Google short description (80) | Email, calendar and contacts with your name on it, for you and your business. |
| Category | Business (Apple primary: Business, secondary: Productivity) · Google: Business |
| Content rating | Everyone / 4+ (no objectionable content; users can message each other: answer "yes" to user communication) |
| Website | https://roammail.net |
| Support URL | https://roammail.net/help |
| Privacy policy URL | https://roammail.net/legal/privacy |
| Apple keywords (100) | email,mail,business email,custom domain,calendar,contacts,inbox,secure email,work,team |
| Price | Free |

## Full description (both stores, max 4,000)

Roammail is email with your name on it. Get a free personal address, or bring your business domain and give your whole team professional email, calendar and contacts in one simple app.

**Everything in one place**
• A fast, clean inbox with conversations, search, folders and junk filtering
• Calendar and contacts that stay in sync with your other devices
• Tasks and follow-up reminders so nothing slips through
• Up to 10 accounts side by side, with an "All inboxes" view

**Made for business**
• Use your own domain, like you@yourbusiness.com
• Add your team, groups and shared addresses in minutes
• Company directory and shared signatures

**Safe by design**
• 2-step verification, sign-in alerts and a list of your signed-in devices
• Spam, phishing and abuse protection on every message
• Your mail isn't scanned for ads, and you can export or delete your data at any time

**Notifications that matter**
Get a notification the moment new mail arrives, for each account you're signed in to.

Roammail is powered by Friendly Web Services.

## What's new (first release)

Welcome to Roammail on your phone: your inbox, calendar and contacts, with instant new-mail notifications.

---

## Privacy answers

### Google Play: Data safety
- **Does your app collect or share user data?** Yes, collected; **not shared** with third parties (service providers acting for us don't count as sharing).
- **Encrypted in transit:** Yes. **Users can request deletion:** Yes (in the app, Settings → Privacy, and at roammail.net/legal/privacy).
- **Collected data**, all for *App functionality* and *Account management*, plus *Fraud prevention, security* for the device and phone items:

| Data type | Collected | Optional? |
|---|---|---|
| Personal info: Name | yes | required |
| Personal info: Email address (recovery email) | yes | required |
| Personal info: Phone number | yes | required |
| Personal info: Other (date of birth) | yes | required |
| Messages: Emails | yes | required (it's an email app) |
| Messages: Other in-app messages (contacts, calendar) | yes | required |
| Contacts | yes (address book stored in the user's account) | optional |
| Files and docs (attachments) | yes | optional |
| Device or other IDs (push token) | yes | optional |
| App activity: Other (sign-in history, IP address for security) | yes | required |

### Apple: App Privacy
- **Data used to track you:** none.
- **Data linked to you**, purposes App Functionality and, where marked, Account Management or Fraud Prevention:
  - Contact Info: Name, Email Address, Phone Number
  - User Content: Emails or Text Messages, Other User Content (calendar, contacts), Photos or Videos and Other files (attachments you send)
  - Identifiers: User ID, Device ID (push token)
  - Other Data: date of birth (age check)
  - Diagnostics: none collected
- No data is used for advertising or sold.

## Screenshots

`mobile/store/screenshots/` has ready-made images:
Re-create them any time with `node mobile/scripts/screenshots.mjs` while the local test stack runs.
- `iphone-6.9/`: 1320×2868, for App Store "iPhone 6.9-inch display". Apple scales it for the other sizes.
- `android-phone/`: 1080×2340, for Google Play phone screenshots.

Google also wants a 512×512 icon (`mobile/store/play-icon-512.png`) and a 1024×500 feature graphic
(`mobile/store/feature-graphic.png`).
