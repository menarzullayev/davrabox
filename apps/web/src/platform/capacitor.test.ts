import { describe, expect, it } from 'vitest';
import { dictionaries } from '../i18n';
import { isCapacitorShell, mediaErrorText } from './capacitor';

describe('isCapacitorShell', () => {
  it('is false in a normal browser', () => {
    expect(isCapacitorShell({})).toBe(false);
    expect(isCapacitorShell(undefined)).toBe(false);
  });
  it('is true only when the native bridge reports a native platform', () => {
    expect(isCapacitorShell({ Capacitor: { isNativePlatform: () => true } })).toBe(true);
    expect(isCapacitorShell({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
    expect(isCapacitorShell({ Capacitor: {} })).toBe(true);
  });
});

describe('mediaErrorText', () => {
  it('keeps the plain message in the browser and gives settings guidance in the app', () => {
    expect(mediaErrorText('en', {})).toBe(dictionaries.en.errMedia);
    const app = { Capacitor: { isNativePlatform: () => true } };
    for (const lang of ['uz', 'ru', 'en'] as const) {
      expect(mediaErrorText(lang, app)).toBe(dictionaries[lang].errMediaApp);
      expect(dictionaries[lang].errMediaApp).not.toBe(dictionaries[lang].errMedia);
    }
  });
});
