/**
 * Graceful shutdown. Nest's enableShutdownHooks() turns SIGTERM/SIGINT into app.close(): the HTTP server stops accepting,
 * requests already in flight finish, then every provider's shutdown hook runs (pools end, Redis quits, background jobs stop).
 * This adds the one missing piece: a stuck drain must not hang a deploy, so after a signal the process is force-exited
 * (code 1) when the drain has not finished within `limitMs`. Docker/Kubernetes SIGKILL after their grace period anyway; this
 * stays below it so the exit is logged and ours (compose: stop_grace_period 30s, Kubernetes default 30s).
 */
export function armShutdownWatchdog(
  proc: Pick<NodeJS.Process, 'once' | 'exit'> = process,
  limitMs = 25_000,
  log: (message: string) => void = (m) => console.error(m),
): void {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    proc.once(sig, () => {
      setTimeout(() => {
        log(`shutdown did not finish within ${limitMs} ms after ${sig}; forcing exit`);
        proc.exit(1);
      }, limitMs).unref();
    });
  }
}
