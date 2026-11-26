import { REPO_URL } from './menu';

/**
 * Beta app downloads (decision 4). The files and their manifest are served by our own server under /downloads/ (Caddy,
 * deploy/prod/Caddyfile); scripts/publish-downloads.mjs fills them from a GitHub Actions build, so every file is tied to
 * a CI run. The manifest is untrusted input for the page: anything that does not match the expected shape is dropped.
 */
export const MANIFEST_URL = '/downloads/manifest.json';

export type Platform = 'android' | 'windows';

export interface DownloadItem {
  platform: Platform;
  url: string;
  file: string;
  size: number;
  sha256: string;
  version: string;
  commit: string;
  runUrl: string;
  builtAt: string;
}

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(apk|exe)$/;
const SHA = /^[0-9a-f]{64}$/;
const RUN = new RegExp(`^${REPO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/actions/runs/\\d{1,20}$`);
const EXT: Record<Platform, string> = { android: '.apk', windows: '.exe' };

/** Keeps only well-formed entries, at most one per platform (the first). */
export function parseManifest(raw: unknown): DownloadItem[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { items?: unknown }).items)) return [];
  const out: DownloadItem[] = [];
  for (const it of (raw as { items: unknown[] }).items) {
    if (!it || typeof it !== 'object') continue;
    const v = it as Record<string, unknown>;
    const platform = v['platform'];
    if (platform !== 'android' && platform !== 'windows') continue;
    if (out.some((o) => o.platform === platform)) continue;
    const file = String(v['file'] ?? '');
    if (!FILE.test(file) || !file.endsWith(EXT[platform])) continue;
    if (v['url'] !== `/downloads/${file}`) continue;
    const size = Number(v['size']);
    if (!Number.isSafeInteger(size) || size <= 0 || size > 1_000_000_000) continue;
    const sha256 = String(v['sha256'] ?? '').toLowerCase();
    if (!SHA.test(sha256)) continue;
    const runUrl = String(v['runUrl'] ?? '');
    if (!RUN.test(runUrl)) continue;
    const version = String(v['version'] ?? '').slice(0, 40);
    const commit = String(v['commit'] ?? '');
    if (!/^[0-9a-f]{7,40}$/.test(commit)) continue;
    const builtAt = String(v['builtAt'] ?? '');
    if (Number.isNaN(Date.parse(builtAt))) continue;
    out.push({ platform, url: `/downloads/${file}`, file, size, sha256, version: /^[\w.+-]+$/.test(version) ? version : '', commit: commit.slice(0, 7), runUrl, builtAt });
  }
  return out;
}

/** Size in MB with one decimal, in the reader's number format. */
export function sizeMb(bytes: number, lang: string): string {
  return (bytes / 1_048_576).toLocaleString(lang === 'uz' ? 'uz-Latn' : lang, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
}
