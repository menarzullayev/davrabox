import { describe, expect, it } from 'vitest';
import { buildAssetLinks, parseFingerprints } from './assetlinks-lib.mjs';

const FP = Array.from({ length: 32 }, (_, i) => (i * 7 + 3).toString(16).padStart(2, '0').toUpperCase()).join(':');

describe('assetlinks', () => {
  it('returns nothing when the variable is unset or blank', () => {
    expect(buildAssetLinks(undefined)).toBeNull();
    expect(buildAssetLinks('  ')).toBeNull();
  });

  it('builds the delegate document for the app package', () => {
    expect(buildAssetLinks(FP)).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'uz.davrabox.app', sha256_cert_fingerprints: [FP] },
      },
    ]);
  });

  it('normalises case, trims and de-duplicates several fingerprints', () => {
    const other = FP.replace(/^../, 'FF');
    expect(parseFingerprints(` ${FP.toLowerCase()} , ${other},${FP}`)).toEqual([FP, other]);
  });

  it.each(['abc', FP.slice(0, -3), `${FP}:00`, FP.replace(/:/g, ''), `${FP}, nonsense`, 'ZZ:'.repeat(32).slice(0, -1)])('rejects malformed fingerprint %#', (bad) => {
    expect(() => parseFingerprints(bad)).toThrow();
  });
});
