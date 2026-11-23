export interface AuditItem {
  id: string;
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
}

export type ExportFormat = 'csv' | 'json' | 'cef';

export const CSV_HEADER = 'id,at,actor_id,actor_email,action,target\r\n';

/**
 * One CSV cell (RFC 4180) made safe against spreadsheet formula injection: a value that would be read as a formula
 * (leading = + - @, tab or carriage return) gets a leading apostrophe, which spreadsheets treat as a text marker.
 */
export function csvCell(value: string | null): string {
  if (value === null || value === undefined) return '';
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function csvLine(i: AuditItem): string {
  return [i.id, i.at, i.actorId, i.actorEmail, i.action, i.target].map(csvCell).join(',') + '\r\n';
}

export function jsonLine(i: AuditItem): string {
  return JSON.stringify(i) + '\n';
}

/** CEF header fields: escape backslash and pipe; line breaks are not allowed there, so they become spaces. */
export function cefHeader(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** CEF extension values: escape backslash and equals sign; line breaks become the two characters \n and \r. */
export function cefExt(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** ArcSight CEF:0|vendor|product|version|signatureId|name|severity|extension */
export function cefLine(i: AuditItem): string {
  const ext = [`rt=${Date.parse(i.at)}`, `externalId=${cefExt(i.id)}`];
  if (i.actorEmail) ext.push(`suser=${cefExt(i.actorEmail)}`);
  else if (i.actorId) ext.push(`suser=${cefExt(i.actorId)}`);
  if (i.target) ext.push(`msg=${cefExt(i.target)}`);
  return `CEF:0|DavraBox|Platform|1.0|${cefHeader(i.action)}|${cefHeader(i.action)}|3|${ext.join(' ')}\n`;
}

export const FORMATS: Record<ExportFormat, { contentType: string; ext: string; line: (i: AuditItem) => string; head?: string }> = {
  csv: { contentType: 'text/csv; charset=utf-8', ext: 'csv', line: csvLine, head: CSV_HEADER },
  json: { contentType: 'application/x-ndjson; charset=utf-8', ext: 'jsonl', line: jsonLine },
  cef: { contentType: 'text/plain; charset=utf-8', ext: 'cef', line: cefLine },
};
