import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { keycloakHashedCopies, syncPlatforms, targets } from './platforms.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('platform copies of the design colours', () => {
  it('web boot screen, theme-color, Android resources and plugin, desktop window and style guide match tokens.ts', () => {
    // Failing here means a colour was edited by hand or tokens.ts changed: run `pnpm --filter @davrabox/design-tokens sync`.
    expect(syncPlatforms(root, false)).toEqual([]);
  });
  it('knows every place (a new one must be added to the list, not forgotten)', () => {
    expect(targets.map((t) => t.file)).toEqual([
      'apps/web/src/prefs/theme-colors.generated.ts',
      'apps/web/index.html',
      'apps/mobile/android/app/src/main/res/values/colors_davra.xml',
      'apps/mobile/android/app/src/main/res/values/ic_launcher_background.xml',
      'apps/mobile/android/app/src/main/java/uz/davrabox/app/ThemeBarsPlugin.java',
      'deploy/helm/davrabox/files/keycloak-theme/login/resources/css/davrabox.css',
      'deploy/helm/davrabox/files/keycloak-theme/login/theme.properties',
      'apps/desktop/src/window.ts',
      'apps/web/src/styleguide/styleguide.css',
    ]);
  });
  it('Keycloak loads content-hashed copies of its theme files (the CDN ignores query strings)', () => {
    const copies = keycloakHashedCopies(root);
    expect(copies.map((c) => c.src)).toEqual(['css/davrabox.css', 'js/davrabox.js', 'js/glass.js']);
    for (const c of copies) expect(c.out).toMatch(/^(css|js)\/[a-z]+\.[0-9a-f]{10}\.(css|js)$/);
    const props = readFileSync(join(root, 'deploy/helm/davrabox/files/keycloak-theme/login/theme.properties'), 'utf8');
    for (const c of copies) expect(props).toContain(c.out);
  });
  it('negative: a stale hashed copy left behind is reported as drift', () => {
    const rel = 'deploy/helm/davrabox/files/keycloak-theme/login/resources/js/glass.0000000000.js';
    writeFileSync(join(root, rel), '// stale');
    try {
      expect(syncPlatforms(root, false)).toContain(rel);
    } finally {
      rmSync(join(root, rel));
    }
  });
});
