import { ProviderHttpError, safeEventUrl, type ProviderDef } from './types.js';

/**
 * Google Calendar. Scope calendar.events.owned: "See, create, change, and delete events on calendars you own", the
 * narrowest scope Google lists for events.insert besides calendar.app.created (which would force a separate calendar).
 * Sources are listed in docs/calendar.md.
 */
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';

export const google: ProviderDef = {
  id: 'google',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  scopes: [GOOGLE_SCOPE],
  // access_type=offline asks for a refresh token; prompt=consent makes Google return one on every (re)connect.
  authParams: { access_type: 'offline', prompt: 'consent' },
  grantedEnough: (granted) => granted.split(/\s+/).includes(GOOGLE_SCOPE),
  async createEvent(fetchFn, accessToken, ev) {
    // sendUpdates=all: when the host listed attendees, Google (not us) emails the invitations.
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${ev.attendees.length ? 'all' : 'none'}`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: ev.title,
        description: ev.description,
        location: ev.joinUrl,
        start: { dateTime: ev.startIso, timeZone: 'UTC' },
        end: { dateTime: ev.endIso, timeZone: 'UTC' },
        attendees: ev.attendees.map((email) => ({ email })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status);
    const body = (await res.json()) as { htmlLink?: unknown };
    return safeEventUrl(body.htmlLink, ['google.com']);
  },
};
