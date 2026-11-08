# Phone apps: launch checklist

Work top to bottom. **You** = Pete. **Claude** = done in a Claude session. Details for each step are in `MOBILE_APPS.md`.

## Done already
- [x] Android and iPhone apps build on GitHub (Actions → Mobile apps)
- [x] New-mail notifications (Android and iPhone), with a "hide sender and subject" option in Settings
- [x] Attachments save/share, links open in the in-app browser, roammail.net links open the app
- [x] Phone layout checked on every screen at 360 and 390 px wide; accessibility checks clean
- [x] Website too: public pages, app, settings and every admin tab checked at 320, 375, 768 and 1280 px, no overflow and no accessibility (WCAG 2 AA) issues
- [x] Stay signed in by default in the apps (30 days, renewed on use)
- [x] iPhone app shows no payment screens (Apple rule)
- [x] Privacy policy and subprocessors list cover the apps and Google/Apple notifications
- [x] Store text, privacy answers, screenshots, feature graphic and icon: `mobile/store/`

## 1. Accounts (You, about 1 to 7 days because Apple checks your business)
- [ ] Get a free D-U-N-S number for Friendly Web Services, if you don't have one: https://developer.apple.com/enroll/duns-lookup
- [ ] Apple Developer Program, as an organization ($99 a year)
- [ ] Google Play Console, as an organization ($25 once)
- [ ] Firebase project "Roammail" (free)

## 2. Keys (You, about 30 minutes; MOBILE_APPS.md sections 1 to 3)
- [ ] Apple: App ID `net.roammail.app` with Push Notifications and Associated Domains
- [ ] Apple: App Store Connect app record "Roammail"
- [ ] Apple: App Store Connect API key (.p8), Push key (.p8), Team ID
- [ ] Firebase: google-services.json and service-account key
- [ ] Android upload key (one `keytool` command, or ask Claude to make it)
- [ ] Add the GitHub secrets (table in section 3)

## 3. Server (Claude, after you reconnect AWS in Claude's connector settings)
- [ ] Deploy the waiting server version
- [ ] Add `FCM_SERVICE_ACCOUNT`, `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` to the server (Secrets Manager)
- [ ] Add `ANDROID_CERT_SHA256` once Play shows the app signing certificate
- [ ] Check https://roammail.net/.well-known/assetlinks.json and /.well-known/apple-app-site-association
- [ ] Create the App Review demo mailbox (`appreview@roammail.net`) with a few sample emails

## 4. First builds (You click, Claude watches)
- [ ] GitHub → Actions → Mobile apps → Run workflow, tick Upload
- [ ] Android: first upload by hand (Play Console → Internal testing → upload the .aab from the run)
- [ ] Install on your phones: Play internal testing link / TestFlight

## 5. Test on real phones (You, 20 minutes)
- [ ] Sign up a new free account in the app (birthday, recovery email, mobile number)
- [ ] Sign in to a business account; add a second account
- [ ] Allow notifications, then send yourself an email from another address: a notification arrives within seconds and tapping it opens the inbox
- [ ] Turn off "Show sender and subject": the next notification says only "New mail"
- [ ] Open an email with a link: it opens inside the app, Done brings you back
- [ ] Tap an attachment: the share sheet lets you save it
- [ ] Attach a photo to a new email and send it
- [ ] Turn on airplane mode, open the app: the offline screen shows; turn it off, Try again works
- [ ] Close and reopen the app the next day: still signed in
- [ ] Settings → Privacy → Delete my account exists (Apple checks this; don't delete your real account)

## 6. Store listings (You, about 1 hour; text in `mobile/store/listing.md`)
- [ ] Play: store listing, screenshots, feature graphic, icon, Data safety form, content rating, target audience (13+), app access (demo login)
- [ ] Apple: description, keywords, screenshots, App Privacy form, age rating, support and privacy URLs, App Review sign-in and notes

## 7. Submit
- [ ] Play: promote internal → Production (review usually 1 to 3 days)
- [ ] Apple: add the TestFlight build to version 1.0 → Submit for Review (usually 1 to 2 days)
- [ ] If either store rejects, paste the message to Claude: most fixes are same-day

## After launch
- Website updates reach the apps straight away; store updates are only needed for changes in `mobile/` (bump `version` in `mobile/package.json`)
- Watch Play Console → Android vitals and App Store Connect → Crashes the first week
- Reply to store reviews: they help ranking
