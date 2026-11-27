// @vitest-environment node
// Static guard for the browser e2e suite (apps/e2e, run against the full stack after merging): every data-testid the
// suite uses on the home / sign-in / waiting screens must exist in the home components, and the selectors that
// depended on the old layout (second <form>, "first input with a placeholder") must be gone from the suite.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const e2eDir = join(here, '..', '..', '..', 'e2e');
const e2e = readdirSync(e2eDir)
  .filter((f) => f.endsWith('.e2e.mjs'))
  .map((f) => ({ f, text: readFileSync(join(e2eDir, f), 'latin1') }));
const homeSource = readdirSync(here)
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
  .map((f) => readFileSync(join(here, f), 'utf8'))
  .join('\n');

/** Test ids that belong to the screens owned by src/home (the call screen has its own). */
const HOME_IDS = ['join-form', 'new-meeting', 'meeting-title', 'waiting-room', 'settings', 'relay-mode', 'waiting', 'join-passcode-toggle'];

describe('e2e selectors on the home screens', () => {
  it('lists the home test ids the suite uses, and each one is rendered by a home component', () => {
    const used = new Set<string>();
    for (const { text } of e2e) {
      for (const m of text.matchAll(/getByTestId\('([a-z-]+)'\)|\[data-testid=([a-z-]+)\]/g)) {
        const id = (m[1] ?? m[2])!;
        if (HOME_IDS.includes(id)) used.add(id);
      }
    }
    expect([...used].sort()).toEqual(['join-form', 'join-passcode-toggle', 'meeting-title', 'new-meeting', 'relay-mode', 'settings', 'waiting', 'waiting-room']);
    for (const id of used) expect(homeSource, `data-testid="${id}" is rendered by src/home`).toContain(`data-testid="${id}"`);
  });

  it('no e2e file still relies on the old home layout', () => {
    for (const { f, text } of e2e) {
      expect(text, `${f}: second <form> selector`).not.toContain(".locator('form').nth(1)");
      expect(text, `${f}: placeholder-based title selector`).not.toContain("input[placeholder]:not([type=password])");
    }
  });

  it('every test that creates a meeting opens the dialog first', () => {
    for (const { f, text } of e2e) {
      const fills = text.match(/fill\('\[data-testid=meeting-title\]'/g)?.length ?? 0;
      // The "Get started" card's "New meeting" step opens the same dialog (onboarding.e2e.mjs).
      const opens = text.match(/getByTestId\('(new-meeting|gs-action-meeting)'\)\.click\(\)/g)?.length ?? 0;
      expect(opens, `${f}: opens the new-meeting dialog before each title fill`).toBe(fills);
    }
  });

  it('the firewall-mode test opens the settings menu before using the switch', () => {
    const turn = e2e.find((x) => x.f === 'turn.e2e.mjs')!.text;
    expect(turn.indexOf("getByTestId('settings').click()")).toBeGreaterThan(-1);
    expect(turn.indexOf("getByTestId('settings').click()")).toBeLessThan(turn.indexOf("getByTestId('relay-mode').check()"));
  });
});
