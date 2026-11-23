export const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Executable and script formats that must never be shared through a meeting chat.
const BLOCKED = new Set([
  'exe', 'dll', 'msi', 'com', 'scr', 'pif', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'jar', 'lnk', 'reg', 'cpl', 'msc', 'sh', 'bash', 'apk', 'app', 'dmg', 'pkg', 'iso', 'scf', 'url', 'chm', 'svg', 'html', 'htm',
]);

/** Strips any path, control characters and odd whitespace; keeps the extension; caps the length. */
export function sanitizeName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  let n = raw.replace(/[\\/]/g, '_').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, ''); // no hidden or relative names
  if (!n) return null;
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

/** Checks every dot-separated suffix, so "report.pdf.exe" and "a.exe.txt" tricks are caught. */
export function isBlockedName(name: string): boolean {
  return name
    .toLowerCase()
    .split('.')
    .slice(1)
    .some((part) => BLOCKED.has(part));
}
