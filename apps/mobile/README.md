# @davrabox/mobile

Capacitor shell for the Android app. It loads the hosted web client (`DAVRA_APP_URL`, default
`https://davrabox.bugvector.uz/app`); the native project is in `android/`.

- `pnpm --filter @davrabox/mobile test` asserts the config and the manifest (no device or SDK needed).
- Building needs JDK 21 and the Android SDK; it is done by `.github/workflows/android.yml`, not on developer machines
  by default. `DAVRA_APP_URL=https://... pnpm --filter @davrabox/mobile exec cap sync android` regenerates the
  generated files in `android/`.
- Details, versions, store-release requirements and risks: `docs/android.md`.
