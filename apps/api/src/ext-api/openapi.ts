import { Controller, Get } from '@nestjs/common';
import { z, type ZodType } from 'zod';
import type { ApiKeyScope } from './api-keys.service.js';
import { errorSchema, listQuerySchema, meetingCreateSchema, meetingPageSchema, meetingSchema, userPageSchema } from './ext-schemas.js';

/**
 * The OpenAPI 3.1 document of /v1/ext, generated from the same zod schemas the controllers validate with. The route
 * table below is checked against the real controllers by the tests: a route added without documentation, or documented
 * without existing, fails them.
 */
interface RouteDoc {
  method: 'get' | 'post' | 'delete';
  path: string;
  summary: string;
  description?: string;
  scope?: ApiKeyScope; // omitted for the public document itself
  query?: ZodType;
  body?: ZodType;
  pathParam?: { name: string; description: string };
  idempotency?: boolean;
  success: { status: string; description: string; schema?: ZodType; headers?: Record<string, { description: string; schema: { type: string } }> };
  extra: Record<string, string>; // other documented outcomes by status code
}

const ID_PARAM = { name: 'id', description: 'Meeting id (uuid) or join code (11 digits)' };

export const EXT_ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/v1/ext/meetings',
    summary: 'List meetings',
    description: 'Newest first. Pass the `next` value as `cursor` to read the following page; the cursor is stable while new meetings are created.',
    scope: 'meetings:read',
    query: listQuerySchema,
    success: { status: '200', description: 'A page of meetings', schema: meetingPageSchema },
    extra: { '400': 'Invalid query or cursor' },
  },
  {
    method: 'post',
    path: '/v1/ext/meetings',
    summary: 'Create a meeting',
    description:
      'The meeting is hosted by the user who created the API key. Send an `Idempotency-Key` to make retries safe: the same key and body returns the first response (with `Idempotent-Replay: true`), the same key with another body is refused with 422, and a duplicate that arrives while the first is still running gets 409.',
    scope: 'meetings:write',
    body: meetingCreateSchema,
    idempotency: true,
    success: {
      status: '201',
      description: 'The created meeting',
      schema: meetingSchema,
      headers: { 'Idempotent-Replay': { description: 'true when this is a replay of an earlier request with the same Idempotency-Key', schema: { type: 'string' } } },
    },
    extra: {
      '400': 'Invalid body (unknown fields are rejected), invalid Idempotency-Key, or the organization policy refuses the meeting',
      '409': 'A request with this Idempotency-Key is still being processed',
      '422': 'Idempotency-Key was already used with a different body',
    },
  },
  {
    method: 'get',
    path: '/v1/ext/meetings/{id}',
    summary: 'Get a meeting',
    scope: 'meetings:read',
    pathParam: ID_PARAM,
    success: { status: '200', description: 'The meeting', schema: meetingSchema },
    extra: { '404': 'No such meeting in this organization' },
  },
  {
    method: 'delete',
    path: '/v1/ext/meetings/{id}',
    summary: 'Delete a meeting',
    description: 'Deletes the meeting and closes its room. A meeting that has shared files cannot be deleted through the API.',
    scope: 'meetings:write',
    pathParam: ID_PARAM,
    success: { status: '204', description: 'Deleted' },
    extra: { '404': 'No such meeting in this organization', '409': 'The meeting has shared files' },
  },
  {
    method: 'get',
    path: '/v1/ext/users',
    summary: 'List users',
    description: 'Read-only directory of the organization, newest first, with the same cursor pagination as meetings.',
    scope: 'users:read',
    query: listQuerySchema,
    success: { status: '200', description: 'A page of users', schema: userPageSchema },
    extra: { '400': 'Invalid query or cursor' },
  },
  {
    method: 'get',
    path: '/v1/ext/openapi.json',
    summary: 'This document',
    description: 'Public, no authentication.',
    success: { status: '200', description: 'The OpenAPI document' },
    extra: {},
  },
];

const COMMON: Record<string, string> = {
  '401': 'Missing, malformed, unknown or revoked API key',
  '403': 'The key lacks the required scope',
  '429': 'Per-key rate limit exceeded; wait for Retry-After seconds',
};

function schemaOf(s: ZodType): Record<string, unknown> {
  const { $schema: _omit, ...rest } = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

function parametersFor(r: RouteDoc): unknown[] {
  const params: unknown[] = [];
  if (r.pathParam) params.push({ name: r.pathParam.name, in: 'path', required: true, description: r.pathParam.description, schema: { type: 'string' } });
  if (r.query) {
    const sch = schemaOf(r.query) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
    for (const [name, prop] of Object.entries(sch.properties ?? {})) {
      params.push({ name, in: 'query', required: sch.required?.includes(name) ?? false, description: prop.description, schema: prop });
    }
  }
  if (r.idempotency) {
    params.push({ name: 'Idempotency-Key', in: 'header', required: false, description: 'Client-chosen key (1-200 printable ASCII characters) that makes a retried POST safe', schema: { type: 'string', minLength: 1, maxLength: 200 } });
  }
  return params;
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const errorBody = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  for (const r of EXT_ROUTES) {
    const responses: Record<string, unknown> = {
      [r.success.status]: {
        description: r.success.description,
        ...(r.success.schema ? { content: { 'application/json': { schema: schemaOf(r.success.schema) } } } : {}),
        ...(r.success.headers ? { headers: r.success.headers } : {}),
      },
    };
    const errors = { ...(r.scope ? COMMON : {}), ...r.extra };
    for (const code of Object.keys(errors).sort()) responses[code] = { description: errors[code], ...errorBody };
    const op: Record<string, unknown> = {
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      security: r.scope ? [{ apiKey: [] }] : [],
      ...(r.scope ? { 'x-required-scope': r.scope } : {}),
    };
    const parameters = parametersFor(r);
    if (parameters.length) op.parameters = parameters;
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(r.body) } } };
    op.responses = responses;
    (paths[r.path] ??= {})[r.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'DavraBox external API',
      version: '1.0.0',
      description:
        'Authenticate with an organization API key created in the admin console: `Authorization: Bearer dbx_...`. Keys carry scopes (`meetings:read`, `meetings:write`, `users:read`) and are rate limited per minute. Webhooks are documented in docs/api.md.',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'API key, format dbx_<8 hex>_<43 base64url>' } },
      schemas: { Error: schemaOf(errorSchema) },
    },
  };
}

/** Public: the document contains no secrets and is what integrators generate clients from. */
@Controller('v1/ext')
export class OpenApiController {
  @Get('openapi.json')
  openapi() {
    return buildOpenApi();
  }
}
