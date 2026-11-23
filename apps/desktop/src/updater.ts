import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPDATE_FEED, parseBuildInfo, updatesEnabled } from './update-policy';

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Starts the auto-update channel. It is a no-op for unsigned and unpackaged builds.
 * Signature checking is done by electron-updater: Windows verifies the Authenticode publisher recorded in
 * app-update.yml, macOS (Squirrel.Mac) refuses a package that is not signed by the same identity.
 * An update that fails the check is rejected by the library and surfaces only as an 'error' event; nothing is installed.
 */
export function startAutoUpdates(): void {
  const info = parseBuildInfo(readText(join(__dirname, 'build-info.json')));
  const updateYml = readText(join(process.resourcesPath, 'app-update.yml'));
  if (!updatesEnabled({ packaged: app.isPackaged, signed: info.signed, platform: process.platform, updateYml, env: process.env })) return;

  autoUpdater.setFeedURL({ provider: UPDATE_FEED.provider, owner: UPDATE_FEED.owner, repo: UPDATE_FEED.repo, releaseType: UPDATE_FEED.releaseType });
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => console.error('[updater] update refused or failed:', err?.message ?? err));
  void autoUpdater.checkForUpdates().catch((err: unknown) => console.error('[updater] check failed:', err));
}
