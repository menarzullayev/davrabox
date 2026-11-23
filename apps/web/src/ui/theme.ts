export type ThemeChoice = 'dark' | 'light';

/** The stored choice, else what theme-init.js already put on <html>, else dark (the default theme). */
export function readTheme(): ThemeChoice {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

export function applyTheme(theme: ThemeChoice, persist = true): void {
  document.documentElement.setAttribute('data-theme', theme);
  if (!persist) return;
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* storage unavailable */
  }
}
