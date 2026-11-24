// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreJoin, SKIP_PREJOIN_KEY, readSkipPreJoin } from './PreJoin';

function track(kind: 'audio' | 'video') {
  return { kind, enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
}
function stream(tracks: MediaStreamTrack[]) {
  return { getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video') } as unknown as MediaStream;
}
let gum: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  gum = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: gum }, configurable: true });
  vi.stubGlobal('MediaStream', class { constructor(public t: MediaStreamTrack[]) {} getTracks() { return this.t; } getAudioTracks() { return this.t.filter((x) => x.kind === 'audio'); } getVideoTracks() { return this.t.filter((x) => x.kind === 'video'); } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = () => ({ lang: 'en' as const, title: 'Weekly sync', onJoin: vi.fn(), onCancel: vi.fn() });

describe('PreJoin', () => {
  it('shows the meeting, starts with both on, and hands the choice to the call', async () => {
    const a = track('audio');
    const v = track('video');
    gum.mockResolvedValue(stream([a, v]));
    const p = props();
    render(<PreJoin {...p} />);
    expect(screen.getByText('Weekly sync')).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId('prejoin-mic') as HTMLInputElement).disabled).toBe(false));
    await userEvent.click(screen.getByTestId('prejoin-join'));
    expect(p.onJoin).toHaveBeenCalledWith({ mic: true, cam: true });
    expect(a.stop).toHaveBeenCalled(); // the devices are released before the call opens its own
    expect(v.stop).toHaveBeenCalled();
  });

  it('turning the microphone or camera off is what the call receives', async () => {
    gum.mockResolvedValue(stream([track('audio'), track('video')]));
    const p = props();
    render(<PreJoin {...p} />);
    await waitFor(() => expect((screen.getByTestId('prejoin-mic') as HTMLInputElement).disabled).toBe(false));
    await userEvent.click(screen.getByTestId('prejoin-mic'));
    await userEvent.click(screen.getByTestId('prejoin-cam'));
    await userEvent.click(screen.getByTestId('prejoin-join'));
    expect(p.onJoin).toHaveBeenCalledWith({ mic: false, cam: false });
  });

  it('without permission it explains why, starts with both off and still lets the person join', async () => {
    gum.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const p = props();
    render(<PreJoin {...p} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByTestId('prejoin-mic') as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('prejoin-join'));
    expect(p.onJoin).toHaveBeenCalledWith({ mic: false, cam: false });
  });

  it('a missing microphone does not hide the camera', async () => {
    gum.mockImplementation(async (c: { video?: boolean; audio?: boolean }) => {
      if (c.audio && c.video) throw new Error('no mic');
      if (c.video) return stream([track('video')]);
      throw new Error('no mic');
    });
    const p = props();
    render(<PreJoin {...p} />);
    await waitFor(() => expect((screen.getByTestId('prejoin-cam') as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByTestId('prejoin-mic') as HTMLInputElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId('prejoin-join'));
    expect(p.onJoin).toHaveBeenCalledWith({ mic: false, cam: true });
  });

  it('releases the devices when the person cancels or leaves the screen', async () => {
    const a = track('audio');
    gum.mockResolvedValue(stream([a]));
    const p = props();
    const { unmount } = render(<PreJoin {...p} />);
    await waitFor(() => expect((screen.getByTestId('prejoin-mic') as HTMLInputElement).disabled).toBe(false));
    await userEvent.click(screen.getByTestId('prejoin-cancel'));
    expect(p.onCancel).toHaveBeenCalled();
    unmount();
    expect(a.stop).toHaveBeenCalled();
  });

  it('remembers "do not show this next time" only when ticked at joining', async () => {
    gum.mockResolvedValue(stream([track('audio')]));
    render(<PreJoin {...props()} />);
    await waitFor(() => expect((screen.getByTestId('prejoin-mic') as HTMLInputElement).disabled).toBe(false));
    expect(readSkipPreJoin()).toBe(false);
    await userEvent.click(screen.getByTestId('prejoin-join'));
    expect(localStorage.getItem(SKIP_PREJOIN_KEY)).toBeNull();
    cleanup();
    render(<PreJoin {...props()} />);
    await waitFor(() => expect((screen.getByTestId('prejoin-mic') as HTMLInputElement).disabled).toBe(false));
    await userEvent.click(screen.getByTestId('prejoin-skip'));
    await userEvent.click(screen.getByTestId('prejoin-join'));
    expect(readSkipPreJoin()).toBe(true);
  });

  it('a device that opens after the person already left the screen is stopped at once', async () => {
    const a = track('audio');
    let resolve: (s: MediaStream) => void = () => undefined;
    gum.mockReturnValue(new Promise<MediaStream>((r) => (resolve = r)));
    const { unmount } = render(<PreJoin {...props()} />);
    unmount();
    resolve(stream([a]));
    await waitFor(() => expect(a.stop).toHaveBeenCalled());
  });
});
