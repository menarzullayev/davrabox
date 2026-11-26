import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import content from '@davrabox/help-content/faq.json' with { type: 'json' };
import type { HelpContent } from '@davrabox/help-content/search';
import { costMicroUsd, loadAssistantSettings } from '../src/assistant/config.js';
import { AnthropicAdapter, ClaudeCliAdapter, type Spawner } from '../src/assistant/llm.js';
import { cleanText, maskPersonalData } from '../src/assistant/mask.js';
import { OFF_TOPIC, REPLIES, systemPrompt } from '../src/assistant/prompt.js';

const SECRET = 'x'.repeat(40);

describe('maskPersonalData', () => {
  it.each([
    ['my mail is ali.valiyev+test@mail.ru ok', 'my mail is [email] ok'],
    ['call +998 90 123-45-67 please', 'call [phone] please'],
    ['tel: (90) 1234567', 'tel: [phone]'],
    ['card 8600 1234 5678 9012', 'card [card]'],
    ['card 4111-1111-1111-1111 now', 'card [card] now'],
    ['raqam 998901234567', 'raqam [phone]'],
  ])('%s', (input, expected) => {
    expect(maskPersonalData(input)).toBe(expected);
  });

  it('keeps our own public mailboxes, short numbers and words', () => {
    expect(maskPersonalData('write to hello@davrabox.uz')).toBe('write to hello@davrabox.uz');
    expect(maskPersonalData('files up to 25 MB, 7 days, 2026')).toBe('files up to 25 MB, 7 days, 2026');
  });

  it('runs in linear time on hostile input', () => {
    const t = Date.now();
    maskPersonalData(`${'1 '.repeat(2000)}x${'a@'.repeat(2000)}`);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('cleanText drops control characters and trims', () => {
    expect(cleanText('  a\u0000b\r\n\n\n\nc  ')).toBe('ab\n\nc');
  });
});

describe('loadAssistantSettings', () => {
  it('defaults to FAQ mode without a key and to the Claude API with one', () => {
    expect(loadAssistantSettings({}, SECRET).llm).toBe('none');
    const s = loadAssistantSettings({ ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdef' }, SECRET);
    expect(s.llm).toBe('anthropic');
    expect(s.model).toBe('claude-haiku-5-5');
    expect(s.retentionDays).toBe(30);
  });

  it('refuses the subscription CLI on production and allows it on staging', () => {
    expect(() => loadAssistantSettings({ ASSISTANT_LLM: 'claude-cli' }, SECRET)).toThrow(/not allowed/);
    expect(() => loadAssistantSettings({ ASSISTANT_LLM: 'claude-cli', DAVRA_ENV: 'production' }, SECRET)).toThrow(/not allowed/);
    expect(loadAssistantSettings({ ASSISTANT_LLM: 'claude-cli', DAVRA_ENV: 'staging' }, SECRET).llm).toBe('claude-cli');
  });

  it('never keeps conversations longer than 30 days', () => {
    expect(() => loadAssistantSettings({ ASSISTANT_RETENTION_DAYS: '31' }, SECRET)).toThrow();
    expect(loadAssistantSettings({ ASSISTANT_RETENTION_DAYS: '7' }, SECRET).retentionDays).toBe(7);
  });

  it('asks for the API adapter without a key falls back to FAQ mode', () => {
    expect(loadAssistantSettings({ ASSISTANT_LLM: 'anthropic' }, SECRET).llm).toBe('none');
  });

  it('treats empty variables (compose `${VAR:-}`) as unset', () => {
    const s = loadAssistantSettings({ ANTHROPIC_API_KEY: '', ASSISTANT_LLM: '', ASSISTANT_DAILY_USD_CAP: '', PLATFORM_OWNER_SUBS: '' }, SECRET);
    expect(s.llm).toBe('none');
    expect(s.dailyUsdCap).toBe(0.6);
  });

  it('reads the platform owners', () => {
    expect([...loadAssistantSettings({ PLATFORM_OWNER_SUBS: ' a , b,' }, SECRET).ownerSubs]).toEqual(['a', 'b']);
  });

  it('costs are counted in micro-dollars and rounded up', () => {
    expect(costMicroUsd({ priceInPerMTok: 0.1, priceOutPerMTok: 0.5 }, 1_000_000, 0)).toBe(100_000);
    expect(costMicroUsd({ priceInPerMTok: 0.1, priceOutPerMTok: 0.5 }, 3, 1)).toBe(1);
  });
});

describe('systemPrompt', () => {
  it('holds the FAQ, the refusal word and no volatile data', () => {
    const p = systemPrompt(content as HelpContent, 'ru');
    expect(p).toContain(OFF_TOPIC);
    expect(p).toContain((content as HelpContent).faq[0]!.ru.q);
    expect(p).toBe(systemPrompt(content as HelpContent, 'ru'));
    expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('has every fixed reply in three languages', () => {
    for (const l of ['uz', 'ru', 'en'] as const) for (const v of Object.values(REPLIES[l])) expect(v.length).toBeGreaterThan(10);
  });
});

describe('AnthropicAdapter', () => {
  it('sends the model, a cached system prompt and low effort, and reads text and usage', async () => {
    let sent: any = null;
    const fake = {
      messages: {
        create: async (body: unknown) => {
          sent = body;
          return {
            content: [{ type: 'text', text: ' Hello ' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 5 },
          };
        },
      },
    } as unknown as Anthropic;
    const a = new AnthropicAdapter('k', 'claude-haiku-5-5', 1000, fake);
    const r = await a.ask({ system: 'SYS', messages: [{ role: 'user', content: 'q' }], maxTokens: 300 });
    expect(r).toEqual({ text: 'Hello', refused: false, inputTokens: 100, outputTokens: 5 });
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.max_tokens).toBe(300);
    expect(sent.system[0]).toEqual({ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } });
    expect(sent.output_config).toEqual({ effort: 'low' });
    expect(sent.tools).toBeUndefined();
  });

  it('reports a provider refusal', async () => {
    const fake = { messages: { create: async () => ({ content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } }) } } as unknown as Anthropic;
    const r = await new AnthropicAdapter('k', 'm', 1000, fake).ask({ system: 's', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 });
    expect(r.refused).toBe(true);
  });
});

describe('ClaudeCliAdapter', () => {
  function fakeSpawn(stdout: string, code = 0) {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string }> = [];
    const run = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => undefined;
      let input = '';
      child.stdin.on('data', (d: Buffer) => (input += d.toString()));
      child.stdin.on('end', () => {
        calls.push({ cmd, args, env: opts.env, stdin: input });
        child.stdout.end(stdout);
        setImmediate(() => child.emit('close', code));
      });
      return child;
    }) as unknown as Spawner;
    return { run, calls };
  }

  it('runs claude -p with every tool and setting source off, the system prompt in a file and the question on stdin', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'leak-check';
    const { run, calls } = fakeSpawn(JSON.stringify({ type: 'result', result: ' Javob ', usage: { input_tokens: 7, output_tokens: 3 } }));
    const a = new ClaudeCliAdapter('claude', 'haiku', 5000, run);
    const r = await a.ask({ system: 'SYSTEM PROMPT', messages: [{ role: 'user', content: 'savol; rm -rf /' }], maxTokens: 100 });
    delete process.env['ANTHROPIC_API_KEY'];
    expect(r).toEqual({ text: 'Javob', refused: false, inputTokens: 7, outputTokens: 3 });
    const c = calls[0]!;
    expect(c.cmd).toBe('claude');
    expect(c.args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']));
    expect(c.args[c.args.indexOf('--tools') + 1]).toBe('');
    expect(c.args[c.args.indexOf('--setting-sources') + 1]).toBe('');
    expect(c.args.join(' ')).not.toContain('savol');
    const file = c.args[c.args.indexOf('--system-prompt-file') + 1]!;
    expect(readFileSync(file, 'utf8')).toBe('SYSTEM PROMPT');
    expect(c.stdin).toBe('User: savol; rm -rf /');
    expect(c.env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('fails on a non-zero exit or an error result', async () => {
    await expect(new ClaudeCliAdapter('claude', 'haiku', 5000, fakeSpawn('', 1).run).ask({ system: 's', messages: [{ role: 'user', content: 'q' }], maxTokens: 1 })).rejects.toThrow(/exited/);
    await expect(new ClaudeCliAdapter('claude', 'haiku', 5000, fakeSpawn('{"is_error":true,"result":"x"}').run).ask({ system: 's', messages: [{ role: 'user', content: 'q' }], maxTokens: 1 })).rejects.toThrow(/error result/);
  });
});
