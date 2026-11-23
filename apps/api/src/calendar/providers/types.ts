export type Provider = 'google' | 'microsoft';
export const PROVIDERS: readonly Provider[] = ['google', 'microsoft'];
export function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CalendarEventInput {
  title: string;
  /** UTC instants, ISO 8601 with a Z suffix. */
  startIso: string;
  endIso: string;
  /** Plain text (never interpreted as HTML by the provider adapters). */
  description: string;
  /** The join link; also used as the event location. */
  joinUrl: string;
  attendees: string[];
}

/** The provider answered with an HTTP error status. */
export class ProviderHttpError extends Error {
  constructor(public readonly status: number, message = `provider answered ${status}`) {
    super(message);
  }
}

export interface ProviderDef {
  id: Provider;
  authUrl: string;
  tokenUrl: string;
  /** Token revocation endpoint when the provider has one. */
  revokeUrl?: string;
  /** Exact scopes requested; the tests pin them so nothing broader sneaks in. */
  scopes: readonly string[];
  /** Extra query parameters of the authorization request. */
  authParams: Readonly<Record<string, string>>;
  /** True when the scope string returned by the token endpoint still covers what we need (the user may untick boxes). */
  grantedEnough(granted: string): boolean;
  /** Creates the event and returns its web URL. Throws ProviderHttpError on a non-2xx answer. */
  createEvent(fetchFn: FetchLike, accessToken: string, ev: CalendarEventInput): Promise<string>;
}

/** Only web links the provider hosts over https are handed back to the browser. */
export function safeEventUrl(v: unknown, allowedHosts: readonly string[]): string {
  if (typeof v !== 'string') throw new ProviderHttpError(502, 'provider returned no event link');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ProviderHttpError(502, 'provider returned an invalid event link');
  }
  if (u.protocol !== 'https:' || !allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
    throw new ProviderHttpError(502, 'provider returned an unexpected event link');
  }
  return u.toString();
}
