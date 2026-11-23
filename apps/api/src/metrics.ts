import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, register } from 'prom-client';

collectDefaultMetrics({ prefix: 'davra_' });

export const meetingsCreated = new Counter({ name: 'davra_meetings_created_total', help: 'Meetings created' });
export const joinResults = new Counter({
  name: 'davra_meeting_join_total',
  help: 'Meeting join attempts by outcome',
  labelNames: ['outcome'] as const,
});

/**
 * Metrics are served on a separate internal port, never on the public API port, so the edge proxy
 * cannot expose them by accident. Bind address and port come from configuration.
 */
export function startMetricsServer(port: number, host: string): Server {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(await register.metrics());
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port, host);
  return server;
}
