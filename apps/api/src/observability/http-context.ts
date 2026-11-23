import type { Request } from 'express';

/** The request after the logger middleware and (when authenticated) the guards have run. */
export type ObsRequest = Request & {
  requestId?: string;
  user?: { orgId?: string; userId?: string };
  apiOrg?: { orgId?: string };
};

/** The route template (/meetings/:code), never the raw URL: paths carry meeting codes and ids. */
export function routeOf(req: ObsRequest): string {
  const path: unknown = req.route?.path;
  return typeof path === 'string' ? `${req.baseUrl ?? ''}${path}` : 'unmatched';
}

export function orgIdOf(req: ObsRequest): string | undefined {
  return req.user?.orgId ?? req.apiOrg?.orgId;
}

export type LogSink = (line: string) => void;
export const stdoutSink: LogSink = (line) => void process.stdout.write(`${line}\n`);
