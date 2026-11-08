# Roammail phone apps (Android and iPhone)

The apps live in `mobile/`. Each one is a native app that runs the live Roammail app (`https://roammail.net/app`),
so every change you deploy to the website reaches the apps at once, with no store update needed.
The native layer adds what a phone app needs:

- **Push notifications** for new mail (Firebase on Android, Apple Push on iPhone), one per signed-in mailbox
- **Attachments:** tap to save or share (Files, Photos, Drive, another app)
- **Links in emails** open in the in-app browser; `roammail.net` links from other apps open in Roammail
- **Offline screen** with "Try again", app icon and splash screen in the Roammail colours
- **iPhone:** no payment screens in the app. Apple requires in-app purchase for subscriptions bought inside an
  iPhone app, so businesses choose and pay for plans on the website. Android shows billing as on the web.

App ID (both stores): **`net.roammail.app`**. Builds run on GitHub (Actions → **Mobile apps**), so nobody needs a Mac or Android Studio.

---

## One-time setup

You need these accounts:

| Account | Cost | Where |
|---|---|---|
| Google Play Console | $25 once | https://play.google.com/console |
| Apple Developer Program | $99 a year | https://developer.apple.com/programs/enroll |
| Firebase (for Android notifications) | free | https://console.firebase.google.com |

Enroll both as **an organization** (Friendly Web Services), not as an individual. Apple asks for a D-U-N-S number, which is free and takes a few days.
Google requires new *personal* accounts to run a 14-day closed test with 12 testers before going public; organization accounts don't.

### 1. Apple (iPhone app)

1. **App ID:** developer.apple.com → Certificates, IDs & Profiles → Identifiers → **+** → App IDs → App.
   - Bundle ID: `net.roammail.app`
   - Capabilities: tick **Push Notifications** and **Associated Domains**.
2. **App record:** appstoreconnect.apple.com → Apps → **+** → New App.
   - Platform: iOS. Name: **Roammail**. Bundle ID: `net.roammail.app`. SKU: `roammail-ios`.
3. **Build key:** App Store Connect → Users and Access → Integrations → App Store Connect API → **+**.
   - Name it "GitHub builds" with access **App Manager**, then download the `.p8` file (you can only download it once).
   - Note the **Key ID** and the **Issuer ID** shown on that page.
4. **Push key:** developer.apple.com → Keys → **+** → tick **Apple Push Notifications service (APNs)**.
   - Download the `.p8` and note its **Key ID**.
5. **Team ID:** developer.apple.com → Membership details. It's 10 characters.

### 2. Google (Android app)

1. **Firebase:** console.firebase.google.com → Add project "Roammail" (Analytics not needed).
   - Add app → Android → package name `net.roammail.app` → download **google-services.json**.
   - Project settings → Service accounts → **Generate new private key**. This downloads a JSON file the server uses to send notifications.
2. **Play Console:** Create app → name **Roammail**, App, Free.
3. **Upload key:** the builds are signed with an *upload key*. Make one on any computer with Java:
   ```bash
   keytool -genkeypair -v -keystore roammail-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```
   ```bash
   base64 -w0 roammail-upload.jks > roammail-upload.jks.b64
   ```
   Keep the `.jks` file and its password somewhere safe (a password manager). If it's ever lost, Google can reset the upload key, because Play keeps the real signing key.
4. **Automatic uploads (optional):** follow Google's guide to make a service account with access to your app:
   https://developers.google.com/android-publisher/getting_started. Download its JSON key.

### 3. GitHub secrets

In the GitHub repo, go to Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | contents of `roammail-upload.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_PASSWORD` | the password you chose |
| `ANDROID_KEY_ALIAS` | `upload` |
| `GOOGLE_SERVICES_JSON` | contents of `google-services.json` |
| `PLAY_SERVICE_ACCOUNT_JSON` | (optional) the Play service-account JSON, for automatic uploads |
| `ASC_KEY_P8` | contents of the App Store Connect API `.p8` (step 1.3) |
| `ASC_KEY_ID` / `ASC_ISSUER_ID` | from step 1.3 |
| `APPLE_TEAM_ID` | from step 1.5 |

### 4. Server settings (ECS task definition for roammail-web and roammail-worker)

| Setting | Value | For |
|---|---|---|
| `FCM_SERVICE_ACCOUNT` | the Firebase service-account JSON (step 2.1), base64 is fine | Android notifications |
| `APNS_KEY` | the APNs `.p8` contents (step 1.4), base64 is fine | iPhone notifications |
| `APNS_KEY_ID` | Key ID of the APNs key | iPhone notifications |
| `APNS_TEAM_ID` | Team ID | iPhone notifications and app links |
| `ANDROID_CERT_SHA256` | Play Console → Test and release → App integrity → **App signing key certificate SHA-256** | Android app links |

Put `FCM_SERVICE_ACCOUNT` and `APNS_KEY` in Secrets Manager rather than as plain environment variables.
Check them at `https://roammail.net/.well-known/assetlinks.json` and `https://roammail.net/.well-known/apple-app-site-association`.

---

## Releasing

1. GitHub → Actions → **Mobile apps** → **Run workflow** → tick **Upload**. Or push a tag such as `mobile-v1.0.0`.
   - Android goes to Play **internal testing**. iPhone goes to **TestFlight**.
   - Each run also saves the files (`.aab`, `.apk`, `.ipa`) under the run's *Artifacts*.
2. **First Android release only:** Google needs the very first bundle uploaded by hand. Download the `.aab` from the run's artifacts.
   Then Play Console → Test and release → Internal testing → Create release → upload it. After that, uploads are automatic.
3. Test on your phone:
   - **Android:** Play internal testing link.
   - **iPhone:** the TestFlight app.
4. **Store listing:** copy the text from `mobile/store/listing.md`. Screenshots are in `mobile/store/screenshots/`.
   Fill in the privacy forms with the answers in that file (Play *Data safety*, Apple *App Privacy*).
5. **Submit:**
   - **Play:** promote the internal release to Production.
   - **App Store:** add the TestFlight build to version 1.0, then Submit for Review.

The version number comes from `mobile/package.json` (`version`). The build number goes up on every run automatically.
Change the version only when you ship a new store release; day-to-day app changes ship with the website.

### App Review notes (Apple)

Apple needs a working sign-in. Create a review mailbox (for example `appreview@roammail.net`) and put its address and password
under App Review Information → Sign-in required. Also paste this note:

> Roammail is an email service (mail, calendar, contacts) for businesses and individuals. Sign in with the demo account.
> Notifications alert the user to new mail. Business plans are purchased on our website; the app has no purchase screens.
> Accounts can be deleted in the app: Settings → Privacy → Delete my account.

---

## For developers

- **Change the app:** the web client in `client/` *is* the app UI. `client/src/native.js` holds the phone-only behaviour
  (links, attachments, push). It does nothing in a normal browser.
- **Native projects:** `mobile/android` and `mobile/ios` are standard Capacitor 8 projects.
  - After changing `capacitor.config.json` or plugins, run `cd mobile && npm install && npx cap sync`.
  - Run `npm run check` to verify the IDs and settings agree.
- **Icons and splash:** `cd mobile && npm run assets` (made from `mobile/src-art/mark-white.png`).
- **Local run:**
  - **Android:** Android Studio → open `mobile/android`.
  - **iPhone:** Xcode → open `mobile/ios/App/App.xcodeproj`.
  - To point at a test server, change `server.url` in `capacitor.config.json` and don't commit it.
- **Server:** the routes are `POST /api/push/native` and `/api/push/native/unregister`; the senders are in `server/src/nativepush.js`.
  Tests: `npm run test:nativepush` (against fake Firebase and Apple servers).
