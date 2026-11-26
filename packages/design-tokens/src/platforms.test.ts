import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syncPlatforms, targets } from './platforms.js';

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
      'apps/desktop/src/window.ts',
      'apps/web/src/styleguide/styleguide.css',
    ]);
  });
});
