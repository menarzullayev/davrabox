/**
 * True when the string has no C0 control characters (NUL, newline, tab, ...) and no DEL. Postgres rejects NUL in text
 * columns (a 500 for a hostile body), and single-line labels (titles, names) never need the others.
 */
export const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);
