/**
 * Low-light correction for the local camera, entirely in the browser.
 *
 * Every few frames a 32x18 copy of the frame is averaged to get its brightness. When the picture is dark, a gamma curve
 * (plus a touch of saturation, so the lifted shadows do not turn grey) is applied on the GPU; in good light the frame passes
 * through untouched, so the feature costs nothing when it is not needed.
 */

/** Mean brightness above this needs no correction. */
export const BRIGHT_ENOUGH = 0.42;
const TARGET = 0.45;
/** Strongest lift allowed (gamma 0.45 brightens a mean of 0.17 to about 0.45). */
const MIN_GAMMA = 0.45;

/** Mean luma (BT.709, 0..1) of RGBA pixels. */
export function meanLuma(rgba: Uint8ClampedArray): number {
  let sum = 0;
  const n = rgba.length / 4;
  if (n === 0) return 1;
  for (let i = 0; i < rgba.length; i += 4) sum += 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
  return sum / n / 255;
}

/** The gamma that brings a picture of mean brightness `mean` to about TARGET; 1 (no change) when it is bright enough. */
export function targetGamma(mean: number): number {
  if (!(mean > 0) || mean >= BRIGHT_ENOUGH) return 1;
  const g = Math.log(TARGET) / Math.log(Math.max(mean, 0.02));
  return Math.min(1, Math.max(MIN_GAMMA, g));
}

/** One smoothing step towards the target, so the picture never pumps when someone walks past the lamp. */
export function smoothGamma(current: number, target: number): number {
  const next = current + (target - current) * 0.2;
  return Math.abs(next - target) < 0.005 ? target : next;
}

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
uniform sampler2D frame;
uniform float gamma;
in vec2 uv;
out vec4 color;
void main() {
  vec3 c = texture(frame, uv).rgb;
  c = pow(max(c, vec3(0.0)), vec3(gamma));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.0 + (1.0 - gamma) * 0.25);
  color = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

export function lowLightSupported(): boolean {
  try {
    return typeof VideoFrame !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('webgl2');
  } catch {
    return false;
  }
}

/** The GPU pass. `process` returns a new corrected frame, or null when the frame should pass through as it is. */
export class LowLightFilter {
  private canvas = new OffscreenCanvas(2, 2);
  private gl: WebGL2RenderingContext;
  private probe = new OffscreenCanvas(32, 18);
  private probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
  private uGamma: WebGLUniformLocation | null;
  private tex: WebGLTexture | null;
  private count = 0;
  /** Current (smoothed) gamma; exposed for tests and the debug hook. */
  gamma = 1;
  private target = 1;

  constructor() {
    const gl = this.canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('webgl2 unavailable');
    this.gl = gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(prog, 'frame'), 0);
    this.uGamma = gl.getUniformLocation(prog, 'gamma');
  }

  private measure(frame: VideoFrame) {
    if (!this.probeCtx) return;
    this.probeCtx.drawImage(frame, 0, 0, 32, 18);
    this.target = targetGamma(meanLuma(this.probeCtx.getImageData(0, 0, 32, 18).data));
  }

  process(frame: VideoFrame): VideoFrame | null {
    if (this.count++ % 10 === 0) this.measure(frame);
    this.gamma = smoothGamma(this.gamma, this.target);
    if (this.gamma > 0.985) return null;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const gl = this.gl;
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.uniform1f(this.uGamma, this.gamma);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return new VideoFrame(this.canvas, { timestamp: frame.timestamp });
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
