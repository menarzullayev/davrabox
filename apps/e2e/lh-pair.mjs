// Lighthouse of two builds side by side (decision "within 5 points of today"): starts one headless Edge with a
// debugging port and runs the Lighthouse CLI against it, a few minutes at most per report.
//   node lh-pair.mjs <outDir> <name=url>...        (LH_PORT=9444, LH_RUNS=2, EDGE_PATH=<msedge.exe>)
// Edge is spawned directly, not through Playwright: a Playwright-owned browser pauses every new target until its
// debugger attaches, so the tab Lighthouse opens never loads and the run hangs.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [out, ...targets] = process.argv.slice(2);
const port = Number(process.env.LH_PORT ?? 9444);
const runs = Number(process.env.LH_RUNS ?? 2);
const edgePath = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'davra-lh-'));
const edge = spawn(edgePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

async function waitForDebugger() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Edge did not open the debugging port ${port}`);
}

try {
  await waitForDebugger();
  for (let run = 1; run <= runs; run++) {
    for (const t of targets) {
      const [name, url] = t.split('=');
      for (const form of ['mobile', 'desktop']) {
        const file = join(out, `lh-${name}-${form}-${run}.json`);
        try {
          execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'lighthouse@12', url, `--port=${port}`, ...(form === 'desktop' ? ['--preset=desktop'] : []), '--only-categories=performance,accessibility,best-practices,seo', '--output=json', `--output-path=${file}`, '--quiet'], { stdio: 'inherit', shell: process.platform === 'win32', timeout: 180_000 });
          console.log(`ok ${name} ${form} ${run}`);
        } catch (e) {
          console.log(`FAILED ${name} ${form} ${run}: ${e.message}`);
        }
      }
    }
  }
} finally {
  edge.kill();
  if (process.platform === 'win32' && edge.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1500));
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {}
}
