import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LlmTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmTurn[];
  maxTokens: number;
}

export interface LlmAnswer {
  text: string;
  /** True when the model itself declined (provider refusal), as opposed to an off-topic reply by instruction. */
  refused: boolean;
  inputTokens: number;
  outputTokens: number;
}

/** A language model behind the help assistant. Implementations get NO tools and see only the FAQ and the conversation. */
export interface LlmAdapter {
  readonly kind: 'anthropic' | 'claude-cli';
  ask(req: LlmRequest): Promise<LlmAnswer>;
}

/**
 * Production adapter: the official Claude API (decision 5b, model Claude Haiku). The FAQ in the system prompt is
 * stable and marked for prompt caching; effort is low because the answers are short look-ups. One retry at most.
 */
export class AnthropicAdapter implements LlmAdapter {
  readonly kind = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string, timeoutMs: number, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 1, timeout: timeoutMs });
  }

  async ask(req: LlmRequest): Promise<LlmAnswer> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { effort: 'low' },
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const u = res.usage;
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    return { text, refused: res.stop_reason === 'refusal', inputTokens: input, outputTokens: u.output_tokens ?? 0 };
  }
}

export type Spawner = typeof spawn;

/**
 * STAGING-only adapter (decision 5a): the owner's own `claude -p`, for his personal testing. It runs with every tool,
 * MCP server, slash command, setting source and session file switched off; the system prompt goes through a file and
 * the conversation through stdin, so nothing user-typed ever becomes a command-line argument. Inherited ANTHROPIC_* and
 * CLAUDE_* variables are removed so that the CLI uses its own login. Config refuses this adapter on production.
 */
export class ClaudeCliAdapter implements LlmAdapter {
  readonly kind = 'claude-cli' as const;
  private promptFile: { text: string; path: string } | null = null;

  constructor(private readonly cliPath: string, private readonly model: string, private readonly timeoutMs: number, private readonly run: Spawner = spawn) {}

  private systemFile(text: string): string {
    if (this.promptFile?.text === text) return this.promptFile.path;
    const dir = mkdtempSync(join(tmpdir(), 'davra-assistant-'));
    const path = join(dir, 'system.txt');
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
    this.promptFile = { text, path };
    return path;
  }

  ask(req: LlmRequest): Promise<LlmAnswer> {
    const args = [
      '-p', '--model', this.model, '--output-format', 'json',
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '',
      '--system-prompt-file', this.systemFile(req.system),
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC_|CLAUDE_)/.test(k)) env[k] = v;
    const transcript = req.messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
    return new Promise((resolve, reject) => {
      const child = this.run(this.cliPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('claude -p timed out'));
      }, this.timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        if (out.length < 200_000) out += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (err.length < 4000) err += d.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`claude -p exited with ${code}: ${err.slice(0, 200)}`));
        try {
          const j = JSON.parse(out) as { result?: unknown; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number } };
          if (j.is_error || typeof j.result !== 'string') return reject(new Error('claude -p returned an error result'));
          resolve({ text: j.result.trim(), refused: false, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 });
        } catch {
          reject(new Error('claude -p returned no JSON'));
        }
      });
      child.stdin?.end(transcript, 'utf8');
    });
  }
}
