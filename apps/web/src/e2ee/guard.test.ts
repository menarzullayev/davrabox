// @vitest-environment jsdom
// The key must never reach the network. These tests drive the real API client (`api.ts`) with a spy on fetch while this
// tab holds a meeting key, and assert that no request URL, header or body contains it, and that a request that WOULD
// carry it is refused before fetch is called.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { assertNoMeetingKey, KeyEgressError } from './guard';
import { generateMeetingKey, storeKey } from './keys';

const CODE = '12345678901';
let key = '';
const fetchSpy = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  key = generateMeetingKey();
  storeKey(CODE, key);
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ status: 'joined', token: 't', url: 'wss://x', meetingId: 'm', title: 'T', isHost: true, e2ee: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function everythingSent(): string {
  return fetchSpy.mock.calls
    .map(([url, init]) => JSON.stringify({ url, init: { ...(init as object), body: init && (init as { body?: unknown }).body instanceof File ? '[file]' : (init as { body?: unknown })?.body } }))
    .join('\n');
}

describe('the API client never sends a meeting key', () => {
  it('across every call that takes a meeting code: no URL, header or body contains the key', async () => {
    const t = 'bearer-token';
    await api.join(t, CODE, 'pass-123');
    await api.join(t, CODE);
    await api.me(t, CODE);
    await api.lock(t, CODE, true);
    await api.cohosts(t, CODE);
    await api.listRequests(t, CODE);
    await api.requestStatus(t, CODE, 'rid');
    await api.decide(t, CODE, 'rid', true);
    await api.setCohost(t, CODE, 'id', true);
    await api.mute(t, CODE, 'id');
    await api.remove(t, CODE, 'id');
    await api.recordingStatus(t, CODE);
    await api.startRecording(t, CODE);
    await api.stopRecording(t, CODE);
    await api.recordings(t, CODE);
    await api.create(t, { title: 'Secret', e2ee: true });
    await api.list(t);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(15);
    const sent = everythingSent();
    expect(sent).not.toContain(key);
    expect(sent).not.toContain(encodeURIComponent(key));
    for (const [url] of fetchSpy.mock.calls) expect(String(url)).not.toMatch(/[#]/); // no fragment ever goes into a request URL
  });

  it('a create request for an E2EE meeting carries the flag but no key material', async () => {
    await api.create('tok', { title: 'Secret', e2ee: true });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/v1/meetings');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ title: 'Secret', e2ee: true });
  });

  it('refuses, before fetch is called, anything that carries a held key (URL, header, body) or looks like k=<key>', async () => {
    const bad = [
      { url: `/api/v1/meetings/${CODE}/join?x=${key}` },
      { url: `/api/v1/meetings/${CODE}/join#k=${key}` },
      { url: `/api/v1/meetings/${CODE}/join?k=${key}` },
      { url: '/api/v1/x', headers: { 'X-Whatever': key } },
      { url: '/api/v1/x', body: JSON.stringify({ title: `meet ${key}` }) },
    ];
    for (const r of bad) expect(() => assertNoMeetingKey(r), JSON.stringify(r)).toThrow(KeyEgressError);
    expect(() => assertNoMeetingKey({ url: '/api/v1/meetings', body: JSON.stringify({ title: 'fine' }) })).not.toThrow();
  });

  it('the client request layer applies the guard: a title containing the key is refused and nothing is sent', async () => {
    await expect(api.create('tok', { title: `Weekly ${key}` })).rejects.toBeInstanceOf(KeyEgressError);
    await expect(api.join('tok', CODE, key)).rejects.toBeInstanceOf(KeyEgressError); // key pasted into the passcode field
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('file upload is guarded too (and is switched off in E2EE meetings anyway)', async () => {
    await expect(api.uploadFile('tok', CODE, new File(['x'], `${key}.txt`))).rejects.toBeInstanceOf(KeyEgressError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
