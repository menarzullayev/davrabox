import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import content from '@davrabox/help-content/faq.json' with { type: 'json' };
import type { HelpContent } from '@davrabox/help-content/search';
import { POOL } from '../auth/auth.guard.js';
import { loadConfig } from '../config.js';
import { RateLimitService } from '../rate-limit/service.js';
import { AssistantController, AssistantOwnerController, ASSISTANT, PlatformOwnerGuard } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { loadAssistantSettings, type AssistantSettings } from './config.js';
import { AnthropicAdapter, ClaudeCliAdapter, type LlmAdapter } from './llm.js';
import { AssistantRetentionJob } from './retention.job.js';

const ASSISTANT_SETTINGS = Symbol('ASSISTANT_SETTINGS');
const ASSISTANT_RETENTION = Symbol('ASSISTANT_RETENTION');

export function createLlm(s: AssistantSettings): LlmAdapter | null {
  if (s.llm === 'anthropic' && s.apiKey) return new AnthropicAdapter(s.apiKey, s.model, s.llmTimeoutMs);
  if (s.llm === 'claude-cli') return new ClaudeCliAdapter(s.cliPath, s.cliModel, s.llmTimeoutMs);
  return null;
}

@Injectable()
export class AssistantLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(ASSISTANT_RETENTION) private readonly job: AssistantRetentionJob, @Inject(ASSISTANT_SETTINGS) private readonly s: AssistantSettings) {}

  onApplicationBootstrap(): void {
    new Logger('Assistant').log(`help assistant: ${this.s.enabled ? `on, answers from FAQ${this.s.llm === 'none' ? ' only' : ` + ${this.s.llm}`}` : 'off'}; conversations kept ${this.s.retentionDays} days`);
    if (process.env['PRIVACY_BACKGROUND_JOBS'] === '0' || process.env['SIGNUP_BACKGROUND_JOBS'] === '0') return;
    this.job.start();
  }

  onApplicationShutdown(): void {
    this.job.stop();
  }
}

/** Added to AppModule with one spread each. Needs the shared POOL, VERIFIER and RateLimitService. */
export const assistantControllers = [AssistantController, AssistantOwnerController];

export const assistantProviders: Provider[] = [
  { provide: ASSISTANT_SETTINGS, useFactory: () => loadAssistantSettings(process.env, loadConfig().LIVEKIT_API_SECRET) },
  {
    provide: ASSISTANT,
    useFactory: (pool: Pool, s: AssistantSettings, rate: RateLimitService) => new AssistantService(pool, s, content as HelpContent, { rate, llm: createLlm(s) }),
    inject: [POOL, ASSISTANT_SETTINGS, RateLimitService],
  },
  { provide: ASSISTANT_RETENTION, useFactory: (pool: Pool, s: AssistantSettings) => new AssistantRetentionJob(pool, s.retentionDays), inject: [POOL, ASSISTANT_SETTINGS] },
  PlatformOwnerGuard,
  AssistantLifecycle,
];
