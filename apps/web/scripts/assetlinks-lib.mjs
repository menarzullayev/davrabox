// Digital Asset Links for the Android app (https://developer.android.com/training/app-links/verify-android-applinks).
// The file is only produced when ANDROID_SHA256_CERT_FINGERPRINT is set at build time; without it the route 404s
// and the app still works, it just opens links through the browser chooser instead of directly.

export const ANDROID_PACKAGE = 'uz.davrabox.app';

// 32 colon-separated hex bytes (SHA-256 of the signing certificate), upper or lower case. Linear-time pattern.
const FINGERPRINT = /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){31}$/;

/** Parses a comma-separated list (upload key and Play app-signing key are two different certificates). */
export function parseFingerprints(raw) {
  if (raw === undefined || raw.trim() === '') return [];
  const out = [];
  for (const part of raw.split(',')) {
    const fp = part.trim().toUpperCase();
    if (!FINGERPRINT.test(fp)) throw new Error('ANDROID_SHA256_CERT_FINGERPRINT must be colon-separated SHA-256 hex (32 bytes), comma-separated if several');
    if (!out.includes(fp)) out.push(fp);
  }
  return out;
}

/** The assetlinks.json document, or null when no fingerprint is configured. */
export function buildAssetLinks(raw) {
  const fps = parseFingerprints(raw);
  if (fps.length === 0) return null;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: fps },
    },
  ];
}
