import { SkipRateLimit } from '../rate-limit/guard.js';
import { Controller, Headers, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { WebhookReceiver } from 'livekit-server-sdk';
import type { Config } from '../config.js';
import { EXT_CORE_CONFIG, EXT_WEBHOOKS } from './tokens.js';
import type { WebhooksService } from './webhooks.service.js';

const MAX_BODY_BYTES = 1_048_576;
const HARD_CAP_BYTES = 8 * 1_048_576;

/** Reads the exact bytes of the body (the media server signs a hash of them). Over-long bodies are drained and discarded. */
function readRaw(req: IncomingMessage): Promise<{ text: string | null; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > HARD_CAP_BYTES) {
        req.destroy();
        return;
      }
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve({ text: tooLarge ? null : Buffer.concat(chunks).toString('utf8'), tooLarge }));
    req.on('error', reject);
    req.on('close', () => resolve({ text: null, tooLarge: true }));
  });
}

/**
 * Receives LiveKit webhooks (configure the media server to post to /v1/livekit/webhook). The request is accepted only
 * when its Authorization token is signed with our LiveKit API secret and carries the SHA-256 of the exact body.
 * Verified events are turned into the customer-facing webhook events and queued in the delivery outbox.
 */
// Exempt from the global per-IP ceiling: every event comes from the media server's single address; the signature check is the gate.
@SkipRateLimit()
@Controller('v1/livekit')
export class LivekitWebhookController {
  private readonly receiver: WebhookReceiver;

  constructor(@Inject(EXT_WEBHOOKS) private readonly hooks: WebhooksService, @Inject(EXT_CORE_CONFIG) cfg: Config) {
    this.receiver = new WebhookReceiver(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET);
  }

  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: IncomingMessage, @Headers('authorization') auth: string | undefined) {
    // Only this content type reaches us unparsed; a JSON body would already have been consumed by the body parser.
    if (!/^application\/webhook\+json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpException('content type must be application/webhook+json', 415);
    const raw = await readRaw(req);
    if (raw.tooLarge || raw.text === null) throw new HttpException('payload too large', 413);
    let ev;
    try {
      ev = await this.receiver.receive(raw.text, auth);
    } catch {
      throw new HttpException('invalid signature', 401); // also covers a missing token and an unparsable body
    }
    await this.hooks.ingestMediaEvent({
      name: ev.event,
      id: ev.id,
      room: ev.room?.name ?? '',
      identity: ev.participant?.identity,
      participantName: ev.participant?.name,
      occurredAt: ev.createdAt ? new Date(Number(ev.createdAt) * 1000) : undefined,
    });
    return { received: true };
  }
}
