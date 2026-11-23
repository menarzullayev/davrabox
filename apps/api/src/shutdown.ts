/**
 * Graceful shutdown: SIGTERM/SIGINT -> app.close() -> exit.
 *
 * app.close() stops the HTTP server from accepting, waits for requests already in flight, then runs every provider's
 * shutdown hook (pools end, Redis quits, background jobs stop). Two things Nest's own enableShutdownHooks() does not give us:
 *  - it finishes by re-sending the signal to ourselves, which does NOT terminate a process that is PID 1 in a container
 *    (the kernel ignores default-action signals for PID 1): the API image then hung until Docker's SIGKILL. We exit explicitly.
 *  - a stuck drain must not hang a deploy: after `limitMs` the process is force-exited (code 1). Docker and Kubernetes SIGKILL
 *    after their grace period anyway (compose: stop_grace_period 30 s); this stays below it so the exit is ours and logged.
 */
export interface ClosableApp {
  close(): Promise<void>;
}

export function installGracefulShutdown(
  app: ClosableApp,
  proc: Pick<NodeJS.Process, 'once' | 'exit'> = process,
  limitMs = 25_000,
  log: (message: string) => void = (m) => console.error(m),
): void {
  let started = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    proc.once(sig, () => {
      if (started) return;
      started = true;
      const timer = setTimeout(() => {
        log(`shutdown did not finish within ${limitMs} ms after ${sig}; forcing exit`);
        proc.exit(1);
      }, limitMs);
      timer.unref();
      app.close().then(
        () => proc.exit(0),
        (e: unknown) => {
          log(`shutdown failed: ${(e as Error).message}`);
          proc.exit(1);
        },
      );
    });
  }
}
