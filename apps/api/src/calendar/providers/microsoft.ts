import { ProviderHttpError, safeEventUrl, type ProviderDef } from './types.js';

/**
 * Microsoft Outlook through Microsoft Graph. Delegated permission Calendars.ReadWrite is the least privileged one the
 * Graph reference lists for POST /me/events (work, school and personal accounts); there is no events-only variant.
 * offline_access is what makes the token endpoint return a refresh token. The /common tenant accepts work, school and
 * personal Microsoft accounts. Sources are listed in docs/calendar.md.
 */
export const MS_SCOPES = ['offline_access', 'https://graph.microsoft.com/Calendars.ReadWrite'] as const;

export const microsoft: ProviderDef = {
  id: 'microsoft',
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: MS_SCOPES,
  authParams: { response_mode: 'query', prompt: 'select_account' },
  grantedEnough: (granted) => /calendars\.readwrite/i.test(granted),
  async createEvent(fetchFn, accessToken, ev) {
    // Graph sends the invitations to the attendees itself when an event with attendees is created.
    const res = await fetchFn('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: ev.title,
        body: { contentType: 'text', content: ev.description },
        start: { dateTime: ev.startIso.slice(0, 19), timeZone: 'UTC' },
        end: { dateTime: ev.endIso.slice(0, 19), timeZone: 'UTC' },
        location: { displayName: ev.joinUrl },
        attendees: ev.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status);
    const body = (await res.json()) as { webLink?: unknown };
    return safeEventUrl(body.webLink, ['outlook.office365.com', 'outlook.office.com', 'outlook.live.com', 'outlook.com']);
  },
};
