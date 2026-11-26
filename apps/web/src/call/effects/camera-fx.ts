/**
 * One video processor for the local camera that chains the two effects: low-light correction first (so segmentation sees a
 * brighter picture), then the background (blur or image) from @livekit/track-processors. A LiveKit track holds only one
 * processor, so both effects live in this single transformer and switching between them never restarts the camera.
 */
import { BackgroundTransformer, ProcessorWrapper, supportsBackgroundProcessors } from '@livekit/track-processors';
import type { LocalVideoTrack } from 'livekit-client';
import { LowLightFilter, lowLightSupported } from './lowlight';

type InitOpts = Parameters<BackgroundTransformer['init']>[0];

export type BgMode = { kind: 'none' } | { kind: 'blur' } | { kind: 'image'; url: string };
export interface FxOptions extends Record<string, unknown> {
  bg: BgMode;
  lowLight: boolean;
}

const ASSETS = { tasksVisionFileSet: '/mediapipe/wasm', modelAssetPath: '/mediapipe/selfie_segmenter.tflite' };
const BLUR_RADIUS = 12;

function bgOptions(bg: BgMode) {
  if (bg.kind === 'blur') return { blurRadius: BLUR_RADIUS, imagePath: undefined, backgroundDisabled: false };
  if (bg.kind === 'image') return { imagePath: bg.url, blurRadius: undefined, backgroundDisabled: false };
  return { imagePath: undefined, blurRadius: undefined, backgroundDisabled: true };
}

export class CameraFxTransformer {
  transformer?: TransformStream;
  private initOpts?: InitOpts;
  private bg?: BackgroundTransformer;
  private light?: LowLightFilter;

  constructor(private opts: FxOptions) {}

  async init(o: InitOpts): Promise<void> {
    this.initOpts = o;
    this.transformer = new TransformStream({ transform: (f: VideoFrame, c) => this.transform(f, c) });
    await this.apply();
  }

  async restart(o: InitOpts): Promise<void> {
    this.initOpts = o;
    await this.bg?.restart(o);
  }

  async destroy(o?: { willProcessorRestart: boolean }): Promise<void> {
    await this.bg?.destroy(o);
    this.bg = undefined;
    this.light?.dispose();
    this.light = undefined;
  }

  async update(o: FxOptions): Promise<void> {
    this.opts = o;
    await this.apply();
  }

  private async apply() {
    if (this.opts.lowLight && !this.light) {
      try {
        this.light = new LowLightFilter();
      } catch {
        this.light = undefined; // no WebGL2: the switch stays on but does nothing; the call is not affected
      }
    }
    if (this.opts.bg.kind === 'none') {
      if (this.bg) await this.bg.update(bgOptions(this.opts.bg));
      return;
    }
    if (!this.bg) {
      const bg = new BackgroundTransformer({ ...bgOptions(this.opts.bg), assetPaths: ASSETS });
      if (this.initOpts) await bg.init(this.initOpts);
      this.bg = bg;
    } else {
      await this.bg.update(bgOptions(this.opts.bg));
    }
  }

  async transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
    let f = frame;
    if (this.opts.lowLight && this.light) {
      try {
        const out = this.light.process(frame);
        if (out) {
          frame.close();
          f = out;
        }
      } catch {
        /* a lost GPU context: pass the frame through */
      }
    }
    if (this.opts.bg.kind !== 'none' && this.bg) {
      await this.bg.transform(f, controller);
      return;
    }
    controller.enqueue(f);
  }
}

export const cameraFxSupport = () => ({ background: supportsBackgroundProcessors(), lowLight: lowLightSupported() && ProcessorWrapper.isSupported });

const NAME = 'davra-camfx';
let current: { track: LocalVideoTrack; proc: ProcessorWrapper<FxOptions>; fx: CameraFxTransformer } | null = null;

/**
 * Applies the effects to the camera track: creates the processor on first use, updates it in place afterwards and stops it
 * entirely when nothing is on (zero cost). Throws when the browser cannot process video.
 */
export async function applyCameraFx(track: LocalVideoTrack, opts: FxOptions): Promise<void> {
  const needed = opts.bg.kind !== 'none' || opts.lowLight;
  const mine = current && current.track === track && track.getProcessor() === (current.proc as unknown);
  if (!needed) {
    if (track.getProcessor()) await track.stopProcessor();
    current = null;
    return;
  }
  if (mine && current) {
    await current.fx.update(opts);
    return;
  }
  const fx = new CameraFxTransformer(opts);
  // The library types the wrapper for its own transformers; ours implements the same video transformer contract.
  const proc = new ProcessorWrapper<FxOptions>(fx as never, NAME);
  await track.setProcessor(proc as never);
  current = { track, proc, fx };
}
