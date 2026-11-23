// @vitest-environment node
// Static guard: "/" is the public landing page, so every e2e suite that signs in must open the application at /app.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const e2eDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e');
// signup.e2e.mjs starts at the landing page on purpose (a new visitor has no account yet).
const suites = readdirSync(e2eDir).filter((f) => f.endsWith('.e2e.mjs') && f !== 'signup.e2e.mjs');

describe('e2e suites open the application at /app', () => {
  it('finds the suites', () => expect(suites.length).toBeGreaterThan(5));
  it.each(suites)('%s never signs in through the landing page', (f) => {
    const text = readFileSync(join(e2eDir, f), 'utf8');
    expect(text).not.toMatch(/goto\(\s*BASE\s*\+\s*'\/'\s*\)/);
    expect(text).not.toMatch(/goto\(\s*BASE\s*\)/);
  });
});
