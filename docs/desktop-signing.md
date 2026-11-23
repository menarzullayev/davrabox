# Desktop code signing, notarisation and auto-update

Status: pipeline prepared, **signing itself has never run**: there are no certificates and no Apple account yet. What was tested is listed at the end.

## What the pipeline does

`.github/workflows/desktop.yml` builds Windows, macOS and Linux with `apps/desktop/scripts/dist.mjs`, which decides per platform from the secrets (logic: `scripts/signing-mode.mjs`):

| Secrets of that platform | Result |
|---|---|
| all present | signed build (macOS: also notarised); signatures verified by `scripts/verify-signature.mjs`; `forceCodeSigning` makes electron-builder fail if a signing step did not run |
| none present | UNSIGNED build: artifact names contain `-UNSIGNED-`, the job summary and a workflow warning say so, notarisation is switched off, the artifact is uploaded as `desktop-<OS>-UNSIGNED` |
| some present | the job FAILS and names the missing variables (never values) |

electron-builder alone would silently skip notarisation when the Apple variables are missing (installed 26.18.0, `MacTargetHelper.notarizeIfProvided` logs "skipped macOS notarization"), which is why the all-or-nothing check exists.

Pushing a tag `desktop-v<version>` (version must equal `apps/desktop/package.json`) sets `REQUIRE_SIGNED=true` for Windows and macOS, so an unsigned build fails, and then a `release` job creates a **draft** GitHub Release tagged `v<version>` with the installers and `latest*.yml`. Publishing the draft is a human step; clients only see published releases. You can also set the repository variable `REQUIRE_SIGNED=true` to make manual runs strict. Linux has no code signing and is always unsigned (not released).

## What to buy

1. **Windows**: either
   - a code-signing certificate as a `.pfx` (OV or EV; EV gives immediate SmartScreen reputation, OV builds it over time; certificate authorities now issue keys on hardware tokens or in HSMs, so check that the issuer allows an exportable PFX for CI, otherwise use option b), or
   - a cloud signing service. The pipeline supports Azure Trusted Signing (electron-builder key `win.azureSignOptions`); Microsoft's product naming may change, so check the current Azure portal name.
2. **macOS**: Apple Developer Program membership (paid, yearly), a "Developer ID Application" certificate exported as `.p12`, and an app-specific password for the Apple ID that owns the team.

## Secrets (GitHub repository, Settings, Secrets and variables, Actions)

Windows, PFX method (all of):
- `WIN_CSC_LINK`: the `.pfx` as base64 (`base64 -w0 cert.pfx`), a file path or an https URL
- `WIN_CSC_KEY_PASSWORD`

Windows, cloud method (all of): `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (service principal read by Azure's EnvironmentCredential), and the non-secret-but-required `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER` (exact certificate subject). Configure exactly one Windows method; both at once fails the job.

macOS (all of): `MAC_CSC_LINK` (`.p12` as base64), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. (electron-builder also supports an App Store Connect API key or a notarytool keychain profile; this pipeline uses the Apple ID method.)

Never put these in git or in a `.env` file. The build removes any ambient `CSC_*` variables before mapping the ones above, so a certificate on the runner is not picked up by accident.

## Verify a build

```
node apps/desktop/scripts/verify-signature.mjs <file> [--platform win|mac]
```
Windows `.exe/.msi`: `signtool verify /pa /all /v` (falls back to PowerShell `Get-AuthenticodeSignature` when the Windows SDK is absent). macOS `.app`: `codesign --verify --deep --strict`, `spctl --assess --type execute`, `xcrun stapler validate`; `.dmg/.pkg` use the `open` assessment. Exit 0 = signed, 1 = unsigned or failed, 2 = usage error or a file type with no defined check (never a silent pass). The workflow runs it on every signed build.

## Auto-update channel

- Library: `electron-updater` 6.x, GitHub provider, feed fixed in code (`src/update-policy.ts`, `UPDATE_FEED`) and equal to `build.publish` in `package.json` (a test fails if they drift). No environment variable can change the feed or enable updates; `DAVRABOX_DISABLE_UPDATES=1` can switch them off.
- Enabled only when the build is packaged **and** was signed (`dist/build-info.json`, written by the build and covered by the asar integrity fuse; anything unreadable counts as unsigned). Linux never updates.
- Signature enforcement: Windows `win.verifyUpdateCodeSignature: true` makes electron-builder write `publisherName` into `app-update.yml`, and electron-updater compares the downloaded installer's Authenticode publisher with it. electron-updater **skips** that check when `publisherName` is missing, so the app refuses to enable updates on Windows without it. macOS uses Squirrel.Mac, which rejects an update not signed by the same identity; a `zip` target is therefore shipped next to the `dmg`.
- `allowDowngrade` and `allowPrerelease` are false. Release tags must be `v<semver>`: electron-updater skips other tags, which is why the release job derives `v<version>` from the `desktop-v<version>` trigger tag.
- `src/security.ts` (navigation, permissions, deep links) is unchanged; the updater talks only to GitHub Releases through the library, not through the page.

## Sources checked

- Installed `app-builder-lib` 26.18.0: `scheme.json` (keys `win.signtoolOptions`, `win.azureSignOptions`, `win.verifyUpdateCodeSignature`, `win.forceCodeSigning`, `mac.hardenedRuntime`, `mac.entitlements`, `mac.entitlementsInherit`, `mac.notarize`, `mac.extendInfo`, `publish`) and `out/mac/MacTargetHelper.js`, `out/winPackager.js`, `out/publish/PublishManager.js` (behaviour above). The current online docs describe a newer `win.sign` / `mac.sign` layout than 26.18.0 accepts; this repo follows the installed version.
- Installed `electron-updater` 6.8.11: `out/NsisUpdater.js` (publisherName check), `out/providers/GitHubProvider.js` (semver tags).
- electron-builder docs (as served via Context7 from the project repository, `website/docs/`): `features/code-signing/code-signing-win.md` (WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD), `features/code-signing/notarization.md` (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, hardened runtime, entitlements), `environment-variables.md`, `features/code-signing/code-signing.md` (forceCodeSigning). The electron.build web pages returned 404 from this machine, so they were not read directly.
- Not fetched, cited from memory of the vendors' documentation and to be re-checked: Microsoft's Trusted Signing setup pages, Apple "Notarizing macOS software before distribution", Electron "Code Signing" tutorial.

## What was and was not verified

Verified locally (Windows, unsigned): unit tests of `signingMode` and `verify-signature` (partial, complete, ambiguous, empty values, negative cases), `pnpm dist` and `pnpm dist:release` unsigned builds producing `DavraBox-0.1.0-UNSIGNED-x64.exe` plus `latest.yml` and `app-update.yml` (provider github, no publisherName because unsigned), the `electron-updater` package inside the asar, partial/`REQUIRE_SIGNED` failures with exit code 1, and `verify-signature` reporting NotSigned (exit 1) for the unsigned app and Valid (exit 0) for a Microsoft-signed system executable.

Not verified: any real signing (PFX, Azure, Apple), notarisation, `spctl`/`codesign`/`stapler` steps, the macOS and Linux jobs, the `release` job, the draft release, and an end-to-end update from one signed version to the next. Expect a first-run debugging round once certificates exist. The installer was built but never run.
