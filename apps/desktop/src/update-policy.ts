/**
 * Pure policy of the auto-update channel (no Electron imports, unit-tested directly).
 * Updates are fixed to one GitHub Releases feed, are never enabled by environment variables,
 * and exist only in builds that the release pipeline signed.
 */

/** The only update feed the app will ever talk to. Must equal `build.publish` in package.json (tested). */
export const UPDATE_FEED = { provider: 'github', owner: 'menarzullayev', repo: 'davrabox', releaseType: 'release' } as const;

export interface BuildInfo {
  signed: boolean;
}

/** Reads dist/build-info.json (written by scripts/dist.mjs). Anything unexpected means "unsigned" (fail closed). */
export function parseBuildInfo(raw: string | undefined): BuildInfo {
  try {
    const v: unknown = JSON.parse(raw ?? '');
    return { signed: typeof v === 'object' && v !== null && (v as { signed?: unknown }).signed === true };
  } catch {
    return { signed: false };
  }
}

/** True when app-update.yml carries a publisherName; electron-updater skips the Windows signature check without it. */
export function hasPublisherName(updateYml: string | undefined): boolean {
  if (!updateYml) return false;
  const lines = updateYml.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('publisherName:'));
  if (i < 0) return false;
  if ((lines[i] ?? '').slice('publisherName:'.length).trim() !== '') return true;
  return /^\s+-\s*\S/.test(lines[i + 1] ?? '');
}

export interface UpdateGate {
  packaged: boolean;
  signed: boolean;
  platform: NodeJS.Platform;
  updateYml: string | undefined;
  env: Record<string, string | undefined>;
}

/** Updates run only in a packaged, signed Windows/macOS build. The environment can switch them off, never on. */
export function updatesEnabled(g: UpdateGate): boolean {
  if (!g.packaged || !g.signed) return false;
  if (g.env.DAVRABOX_DISABLE_UPDATES === '1') return false;
  if (g.platform === 'win32') return hasPublisherName(g.updateYml);
  return g.platform === 'darwin';
}
