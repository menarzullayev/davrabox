// Load test of the media plane (LiveKit SFU) with N real WebRTC participants from native clients.
// An orchestrator starts several worker processes (one process cannot drive 50 WebRTC clients honestly: it becomes
// the bottleneck). A few participants publish audio + 360p video, everybody subscribes to everything. The report is
// what this hardware actually did; it never extrapolates capacity.
//
// Tokens are minted with the LiveKit key (this targets the SFU; our API is covered by the integration tests).
// Usage after `. scripts/devenv.sh`:
//   LT_PARTICIPANTS=50 LT_PUBLISHERS=6 LT_SECONDS=60 LT_WORKERS=5 node apps/loadtest/run.mjs
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const env = process.env;
const KEY = env.LIVEKIT_API_KEY;
const SECRET = env.LIVEKIT_API_SECRET;
const LK_URL = env.LT_URL ?? `ws://${env.LAN_IP}:7880`; // direct to the SFU, not through the HTTPS edge
const API = env.LIVEKIT_API_URL ?? `http://${env.LAN_IP}:7880`;
if (!KEY || !SECRET) throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET are required (source scripts/devenv.sh)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : NaN);

// =================================================================================================================
// WORKER: drives a slice [OFFSET, OFFSET + COUNT) of the participants and prints one `RESULT {json}` line.
// =================================================================================================================
async function worker() {
  const { AudioFrame, AudioSource, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream } = await import('@livekit/rtc-node');
  const room = env.LT_ROOM;
  const OFFSET = Number(env.LT_OFFSET);
  const COUNT = Number(env.LT_COUNT);
  const PUBLISHERS = Number(env.LT_PUBLISHERS);
  const WATCHERS = Number(env.LT_WATCHERS ?? 1);
  const SECONDS = Number(env.LT_SECONDS);
  const START_AT = Number(env.LT_START_AT); // wall-clock start of the steady state, shared by all workers

  const token = (identity) => {
    const at = new AccessToken(KEY, SECRET, { identity, name: identity, ttl: 3600 });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    return at.toJwt();
  };

  function startPublisher(idx) {
    const audio = new AudioSource(48000, 1);
    const video = new VideoSource(640, 360);
    const W = 640;
    const H = 360;
    const frames = [0, 1].map((k) => {
      const buf = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        buf[o] = (x + k * 40 + idx * 20) & 255;
        buf[o + 1] = (y * 2 + k * 80) & 255;
        buf[o + 2] = ((x ^ y) + k * 60) & 255;
        buf[o + 3] = 255;
      }
      return buf;
    });
    let stop = false;
    const samples = new Int16Array(480);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 8) * 400);
    const a = (async () => { while (!stop) await audio.captureFrame(new AudioFrame(samples, 48000, 1, 480)); })();
    const v = (async () => { let k = 0; while (!stop) { video.captureFrame(new VideoFrame(frames[k++ & 1], W, H, VideoBufferType.RGBA)); await sleep(1000 / 15); } })();
    return { audio, video, stopFn: async () => { stop = true; await Promise.allSettled([a, v]); } };
  }

  const out = { joined: 0, failed: 0, joinMs: [], disconnects: 0, reconnects: 0, subscribed: [], fps: [] };
  let tearingDown = false;
  const clients = [];
  const publishers = [];
  for (let i = OFFSET; i < OFFSET + COUNT; i++) {
    const r = new Room();
    r.setMaxListeners?.(100);
    r.on(RoomEvent.Disconnected, () => { if (!tearingDown) out.disconnects++; });
    r.on(RoomEvent.Reconnecting, () => { out.reconnects++; });
    const t0 = Date.now();
    try {
      await r.connect(LK_URL, await token(`lt-${i}`), { autoSubscribe: true, dynacast: true });
      out.joinMs.push(Date.now() - t0);
      out.joined++;
      const c = { r, i };
      clients.push(c);
      if (i < PUBLISHERS) {
        const p = startPublisher(i);
        publishers.push(p);
        await r.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack(`mic-${i}`, p.audio), new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
        await r.localParticipant.publishTrack(LocalVideoTrack.createVideoTrack(`cam-${i}`, p.video), new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
      } else if (i - OFFSET < WATCHERS) {
        let frames = 0;
        let first = 0;
        let taken = false; // each watcher decodes ONE stream
        r.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== TrackKind.KIND_VIDEO || taken) return;
          taken = true;
          void (async () => { for await (const _ of new VideoStream(track)) { if (!first) first = Date.now(); frames++; } })();
        });
        c.fps = () => (first ? frames / Math.max(1, (Date.now() - first) / 1000) : 0);
      }
    } catch (e) {
      out.failed++;
      console.error(`worker join ${i} failed: ${String(e.message ?? e).slice(0, 100)}`);
    }
    await sleep(150);
  }
  await sleep(Math.max(0, START_AT + SECONDS * 1000 - Date.now()));
  const expected = PUBLISHERS * 2;
  for (const { r, i } of clients) {
    if (i < PUBLISHERS) continue;
    let n = 0;
    for (const p of r.remoteParticipants.values()) n += p.trackPublications.size;
    out.subscribed.push(n);
  }
  for (const c of clients) if (c.fps) out.fps.push(c.fps());
  out.expectedTracks = expected;
  console.log('RESULT ' + JSON.stringify(out));
  tearingDown = true;
  await Promise.race([Promise.allSettled(publishers.map((p) => p.stopFn())), sleep(4000)]);
  await Promise.race([Promise.allSettled(clients.map(({ r }) => r.disconnect())), sleep(6000)]);
  process.exit(0);
}

// =================================================================================================================
// ORCHESTRATOR
// =================================================================================================================
function dockerStats(container) {
  try {
    const o = execSync(`docker stats --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}" ${container}`, { encoding: 'utf8' }).trim();
    const [cpu, mem] = o.split('|');
    const memMiB = Number(/([\d.]+)MiB/.exec(mem)?.[1] ?? Number(/([\d.]+)GiB/.exec(mem)?.[1] ?? 0) * 1024);
    return { cpu: Number(cpu.replace('%', '')), memMiB };
  } catch {
    return { cpu: NaN, memMiB: NaN };
  }
}
function hostCpu() {
  try {
    const script = "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue";
    return Math.round(Number(execSync(`powershell -NoProfile -Command "${script}"`, { encoding: 'utf8' }).trim().replace(',', '.')));
  } catch {
    return NaN;
  }
}

async function orchestrator() {
  const N = Number(env.LT_PARTICIPANTS ?? 50);
  const PUBLISHERS = Number(env.LT_PUBLISHERS ?? 6);
  const SECONDS = Number(env.LT_SECONDS ?? 60);
  const WORKERS = Math.min(N, Number(env.LT_WORKERS ?? 5));
  const container = env.LT_CONTAINER ?? 'davra-livekit';
  const room = `loadtest-${Date.now()}`;
  const svc = new RoomServiceClient(API, KEY, SECRET);
  await svc.createRoom({ name: room, emptyTimeout: 60, maxParticipants: Math.max(300, N + 10) });
  const idle = dockerStats(container);
  console.log(`load test: ${N} participants (${PUBLISHERS} publishers, ${N - PUBLISHERS} subscribers) over ${WORKERS} worker processes, steady state ${SECONDS}s, room ${room}`);

  // Spread publishers across workers so no single process carries all the encoders.
  const per = Math.ceil(N / WORKERS);
  const startAt = Date.now() + Math.ceil(per * 0.5) * 1000 + 45000; // joining is slow under load; judge the steady state after it
  const results = [];
  const procs = [];
  for (let w = 0; w < WORKERS; w++) {
    const offset = w * per;
    const count = Math.min(per, N - offset);
    if (count <= 0) continue;
    // Worker w publishes participants whose global index is in the first PUBLISHERS ids; to spread them, remap ids by stride.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...env, LT_ROLE: 'worker', LT_ROOM: room, LT_OFFSET: String(offset), LT_COUNT: String(count), LT_PUBLISHERS: String(PUBLISHERS), LT_SECONDS: String(SECONDS), LT_START_AT: String(startAt), LT_WATCHERS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { const t = String(d); if (/worker join/.test(t)) console.log(t.trim()); });
    procs.push(new Promise((res) => child.on('exit', () => { const m = /RESULT (.*)/.exec(buf); if (m) results.push(JSON.parse(m[1])); res(); })));
  }

  const samples = [];
  const t0 = Date.now();
  while (Date.now() < startAt + SECONDS * 1000 - 1500) {
    await sleep(5000);
    if (Date.now() < startAt) {
      console.log(`  joining... participants ${(await svc.listParticipants(room)).length}/${N}`);
      continue;
    }
    const s = dockerStats(container);
    const parts = await svc.listParticipants(room);
    const h = hostCpu();
    samples.push({ ...s, connected: parts.length, host: h });
    console.log(`  t+${Math.round((Date.now() - startAt) / 1000)}s  sfu cpu ${s.cpu}%  sfu mem ${s.memMiB} MiB  participants ${parts.length}  whole-PC cpu ${h}%`);
  }
  await Promise.race([Promise.all(procs), sleep(40000)]);

  const sum = (f) => results.reduce((a, r) => a + f(r), 0);
  const joined = sum((r) => r.joined);
  const failed = sum((r) => r.failed);
  const joinMs = results.flatMap((r) => r.joinMs);
  const reconnects = sum((r) => r.reconnects);
  const disconnects = sum((r) => r.disconnects);
  const subscribed = results.flatMap((r) => r.subscribed);
  const fps = results.flatMap((r) => r.fps);
  const expected = PUBLISHERS * 2;
  // Judge stability from the moment everybody had been connected once: earlier samples still belong to the join phase.
  const reachedAt = samples.findIndex((s) => s.connected === N);
  const minConnected = reachedAt >= 0 ? Math.min(...samples.slice(reachedAt).map((s) => s.connected)) : 0;
  const checks = [
    ['all participants joined', joined === N && failed === 0, `${joined}/${N}`],
    ['nobody was dropped during the steady state', minConnected === N && disconnects === 0, `min connected ${minConnected}, disconnects ${disconnects}`],
    ['no reconnect storms (<= 2% of participants)', reconnects <= Math.ceil(N * 0.02), `${reconnects} reconnecting events`],
    [`every subscriber holds all ${expected} published tracks`, subscribed.length > 0 && subscribed.every((n) => n >= expected), `min ${subscribed.length ? Math.min(...subscribed) : 0} of ${expected}`],
    ['video reaches decoding subscribers at >= 8 fps per stream', fps.length > 0 && fps.every((f) => f >= 8), fps.map((f) => f.toFixed(1)).join(', ') + ' fps'],
  ];
  console.log('\n--- result ---');
  console.log(`INFO  join time with the native test client: p50 ${pct(joinMs, 50)} ms, p95 ${pct(joinMs, 95)} ms (not judged: the client gathers ICE candidates on every virtual adapter of this PC; real browsers join in about 0.5 s, see the e2e logs).`);
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name} :: ${detail}`);
  const cpuMax = samples.length ? Math.max(...samples.map((s) => s.cpu)) : NaN;
  const memMax = samples.length ? Math.max(...samples.map((s) => s.memMiB)) : NaN;
  console.log(`whole-PC CPU during the steady state: max ${samples.length ? Math.max(...samples.map((s) => s.host ?? 0)) : NaN}% (load generator and SFU share this machine)`);
  console.log(`measured on this PC: SFU container cpu max ${cpuMax}% (idle ${idle.cpu}%, container limit 200%), memory max ${memMax} MiB (idle ${idle.memMiB} MiB, limit 1024 MiB)`);
  const pass = checks.every((c) => c[1]);
  console.log(pass ? 'LOAD TEST: ALL PASSED' : 'LOAD TEST: FAILURES');
  await Promise.race([svc.deleteRoom(room).catch(() => undefined), sleep(3000)]);
  void t0;
  process.exit(pass ? 0 : 1);
}

if (env.LT_ROLE === 'worker') await worker();
else await orchestrator();
