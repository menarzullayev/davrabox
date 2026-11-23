import { describe, expect, it } from 'vitest';
import { livekitUrlFor } from '../src/meetings/public-url.js';
import { loadConfig } from '../src/config.js';

const allowed = ['https://10.0.0.5:8443', 'https://davrabox.example.com'];
const fallback = 'wss://10.0.0.5:8443/livekit';

describe('livekitUrlFor', () => {
  it('uses the host the browser used when it is an allowed origin', () => {
    expect(livekitUrlFor('davrabox.example.com', allowed, fallback)).toBe('wss://davrabox.example.com/livekit');
    expect(livekitUrlFor('10.0.0.5:8443', allowed, fallback)).toBe('wss://10.0.0.5:8443/livekit');
  });
  it('is case-insensitive and tolerates spaces', () => {
    expect(livekitUrlFor(' DavraBox.Example.com ', allowed, fallback)).toBe('wss://davrabox.example.com/livekit');
  });
  it.each([['evil.example.org'], ['davrabox.example.com.evil.org'], ['davrabox.example.com:444'], [''], [undefined]])(
    'ignores an unknown or forged host (%s)',
    (h) => {
      expect(livekitUrlFor(h as string | undefined, allowed, fallback)).toBe(fallback);
    },
  );
  it('ignores non-https and malformed origins', () => {
    expect(livekitUrlFor('plain.example.com', ['http://plain.example.com', 'not a url'], fallback)).toBe(fallback);
  });
});

describe('KEYCLOAK_ISSUER list', () => {
  const base = { DATABASE_URL: 'x', KEYCLOAK_AUDIENCE: 'a', LIVEKIT_URL: 'wss://h/livekit', LIVEKIT_API_URL: 'http://h:7880', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 'x'.repeat(32) };
  it('parses a comma separated list', () => {
    const c = loadConfig({ ...base, KEYCLOAK_ISSUER: 'https://a/auth/realms/r, https://b/auth/realms/r' } as never);
    expect(c.KEYCLOAK_ISSUER).toEqual(['https://a/auth/realms/r', 'https://b/auth/realms/r']);
  });
  it('rejects a non-URL issuer', () => {
    expect(() => loadConfig({ ...base, KEYCLOAK_ISSUER: 'nope' } as never)).toThrow(/Invalid configuration/);
  });
});
