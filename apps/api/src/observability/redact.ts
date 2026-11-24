// Defence in depth for text that reaches the logs or the error tracker (error messages, stacks). The loggers log an
// allow-list of fields, so request data never gets here; this covers secrets that an error message might embed.
// Input is truncated first, and every pattern is linear (no nested or overlapping quantifiers), so hostile input is safe.

const MAX_LEN = 16_000;

const RULES: Array<[RegExp, string]> = [
  [/Bearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@'],
  [/\b(password|passwd|passcode|secret|token|api[_-]?key|authorization)(["']?[ \t]*[:=][ \t]*["']?)[^\s"',;&]+/gi, '$1$2[redacted]'],
];

export function redactText(input: string): string {
  let s = input.length > MAX_LEN ? `${input.slice(0, MAX_LEN)}...[truncated]` : input;
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}
