# Android app

The Android app is a Capacitor shell (`apps/mobile`) around the hosted web client. It contains no copy of the UI: the
WebView loads `server.url` (the `/app` page of the deployment), so a web release reaches the app without a store update.
Camera, microphone and audio routing are the only device capabilities it asks for.

## Status, stated plainly

- The APK has **not been run on a device or an emulator**. This machine has no Android SDK and no Java, and the app
  was written and checked there. What exists is: the project, scripted assertions on the config and the manifest
  (run in CI), and a GitHub Actions workflow that builds it. The workflow could not be executed locally; it was
  checked for YAML syntax and reasoned through only. The first real signal is the first run of
  `.github/workflows/android.yml` on GitHub, followed by a manual test on a phone.
- Things that are written but unproven until then: the Gradle changes (manifest placeholder, `BuildConfig.APP_HOST`,
  optional signing), the `MainActivity` App Link routing, the camera/microphone prompt inside the WebView, and App
  Links verification.

## Versions (pinned) and their source

| Item | Value | Source |
|---|---|---|
| Capacitor CLI / core / android | 8.6.2 (exact, npm `latest` on 2026-11-24) | npm registry |
| Node.js for the CLI | 22 or newer | Capacitor 8 upgrade guide; `@capacitor/cli` `engines` is `>=22.0.0` |
| Android Studio (only if someone opens the project) | Otter 2025.2.1 or newer | Capacitor 8 upgrade guide / support policy |
| Android Gradle plugin | 8.13.0 | Capacitor 8 upgrade guide; set in the generated `android/build.gradle` |
| Gradle wrapper | 8.14.3 | Capacitor 8 upgrade guide; `gradle-wrapper.properties` |
| JDK | 21 (CI uses Temurin 21) | `capacitor/build.gradle` of `@capacitor/android` 8.6.2 sets Java source/target 21 (the upgrade guide page does not state a JDK) |
| minSdk 24 (Android 7.0), compileSdk 36, targetSdk 36 | | Capacitor 8 upgrade guide; `android/variables.gradle` |

Documents: https://capacitorjs.com/docs/updating/8-0 and https://capacitorjs.com/docs/main/reference/support-policy.
The tests read `variables.gradle` and fail if this page stops mentioning the real minSdk 24 and targetSdk 36.
Google Play requires new apps and updates to target a recent API level; re-check the current deadline when publishing.

## Configuration

- App id `uz.davrabox.app`; Play will identify the app by it, so it must not change after the first upload.
- `DAVRA_APP_URL` (build time): the https URL of the web client, default `https://davrabox.bugvector.uz/app`. It is read
  by `capacitor.config.ts` (becomes `server.url`, and its host the only `allowNavigation` entry) and by
  `app/build.gradle` (App Links host, deep-link guard). In CI set it as a repository variable of the same name.
  Non-https values and URLs with credentials make the build fail.
- Cleartext traffic is off (`server.cleartext`, `usesCleartextTraffic="false"`), mixed content is blocked, WebView
  debugging is off, backups are off. Links to other hosts open in the system browser, not in the app.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`. No storage,
  location or contacts. `apps/mobile/test/android-shell.test.ts` enforces this list.
- Web side: `apps/web/src/platform/capacitor.ts` detects the shell (`window.Capacitor`). If camera or microphone access
  fails, the call screen shows an actionable message (open phone settings, allow camera and microphone) instead of the
  generic one. There is no "install the desktop app" prompt in the web client today; `isCapacitorShell()` is what such
  a prompt must check before it renders.

## Deep links (Android App Links)

`https://<host>/app?join=<code>` (also with `#k=<key>` for end-to-end encrypted meetings) opens the app. Three parts:

1. The manifest has an `autoVerify` intent filter for `https`, the host of `DAVRA_APP_URL` and path prefix `/app`.
2. `MainActivity` forwards such a link to the WebView, only when host and path match, preserving the fragment.
3. The host must publish `/.well-known/assetlinks.json`. The web build writes it when
   `ANDROID_SHA256_CERT_FINGERPRINT` is set (colon-separated SHA-256 of the signing certificate; comma-separated for
   several, see below); otherwise the route returns 404 and the app still works but links go through the browser. For
   the web image pass it as a build argument: `docker build -f apps/web/Dockerfile --build-arg
   ANDROID_SHA256_CERT_FINGERPRINT=... .` from the repository root.

Verify after release: `curl https://<host>/.well-known/assetlinks.json`, then
`adb shell pm get-app-links uz.davrabox.app` on a phone.

## CI build

`.github/workflows/android.yml`: job `checks` (typecheck and tests of `apps/mobile`, plus the asset-links and shell
detection tests of the web package), then job `build` (Temurin 21, Android SDK via `android-actions/setup-android`,
`cap sync android`, `./gradlew assembleDebug`, artifact `davrabox-debug-apk`). If all four secrets exist it also builds
and uploads a signed release APK and AAB (`davrabox-release`); otherwise the job summary says "RELEASE NOT BUILT".
The main `ci.yml` is not changed and does not run these tests; this workflow is their gate.

Secrets (GitHub Actions, never in git): `ANDROID_KEYSTORE_BASE64` (base64 of the upload keystore),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

## What the owner must supply for a store release

1. A Google Play developer account (one-time registration fee; identity verification; new personal accounts also face
   Google's closed-testing requirement before production, check the current rules).
2. An upload key: create it yourself with `keytool -genkeypair -v -keystore upload.keystore -alias upload -keyalg RSA
   -keysize 2048 -validity 10000`, keep the file and passwords offline, store them as the four secrets above. Use Play
   App Signing so Google holds the app signing key.
3. The Digital Asset Links fingerprint: the SHA-256 of the certificate that signs what users install. With Play App
   Signing that is the **app signing certificate shown in Play Console (App integrity)**, not the upload key; for a
   sideloaded release APK it is the upload key (`keytool -list -v -keystore upload.keystore`). Put both, comma
   separated, into `ANDROID_SHA256_CERT_FINGERPRINT` for the web build.
4. Store listing: icon, screenshots, privacy policy URL, data safety form, content rating. The shipped launcher icon
   and splash are the Capacitor defaults and must be replaced with DavraBox artwork.

## Risks

- **Google Play may reject a pure WebView wrapper** under its minimum-functionality policy (apps that are only a
  website wrapper with no added value are a known rejection reason). Mitigations to consider before submitting: native
  features that justify the app (push notifications for meeting invites, a share-sheet integration, a native incoming
  call or foreground service for ongoing calls), and an honest listing. None of those are built. Plan for a rejection
  and a rework round, or distribute the signed APK directly (sideloading) while that is resolved.
- A remote `server.url` means the app is only as available as the web host; offline it shows only the placeholder page
  in `apps/mobile/www`. There is no connection-error screen yet.
- Calls need a foreground service on Android to keep the microphone alive when the app is backgrounded; the shell does
  not have one, so audio may stop when the screen turns off or the app is minimised. Test this on real devices.
- WebView version drift: LiveKit and insertable-stream E2EE need a recent Android System WebView; very old devices
  (Android 7 and 8 with unupdated WebView) may fail. Untested.
- Camera/microphone permission flow is Capacitor's `BridgeWebChromeClient`; it requests the Android runtime
  permission when the page calls `getUserMedia`. Whether the "denied" path reaches the message above on every Android
  version is unverified.
