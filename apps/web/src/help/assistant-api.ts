import type { Lang } from '../i18n';

export type AssistantPage = 'landing' | 'help' | 'signin' | 'home';
export type AnswerSource = 'faq' | 'llm' | 'fallback' | 'refusal';

export interface AskResponse {
  conversationId: string;
  answer: string;
  source: AnswerSource;
  faqId: string | null;
  lang: Lang;
  suggestions: Array<{ id: string; q: string }>;
}

export interface AssistantStatus {
  enabled: boolean;
  mode: 'llm' | 'faq';
  maxChars: number;
  retentionDays: number;
}

export class AssistantApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** Optional bearer token: only the platform owner's token matters (the staging CLI answers him only); never required. */
export type TokenSource = () => Promise<string | null>;

async function headers(token?: TokenSource): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const t = token ? await token().catch(() => null) : null;
  if (t) h['authorization'] = `Bearer ${t}`;
  return h;
}

export async function assistantStatus(token?: TokenSource): Promise<AssistantStatus> {
  const r = await fetch('/api/v1/public/assistant/status', { headers: await headers(token), credentials: 'omit' });
  if (!r.ok) throw new AssistantApiError(r.status, 'status');
  return (await r.json()) as AssistantStatus;
}

export async function assistantAsk(body: { message: string; lang: Lang; page: AssistantPage; conversationId: string | null }, token?: TokenSource): Promise<AskResponse> {
  const r = await fetch('/api/v1/public/assistant/ask', { method: 'POST', headers: await headers(token), body: JSON.stringify(body), credentials: 'omit' });
  if (!r.ok) {
    let code = 'error';
    try {
      code = ((await r.json()) as { code?: string }).code ?? code;
    } catch {
      /* not json */
    }
    throw new AssistantApiError(r.status, code);
  }
  return (await r.json()) as AskResponse;
}

const CONV_KEY = 'davra.assistant.conversation';

/** The conversation continues across the public pages of one tab (sessionStorage; gone when the tab closes). */
export function loadConversationId(): string | null {
  try {
    const v = sessionStorage.getItem(CONV_KEY);
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveConversationId(id: string): void {
  try {
    sessionStorage.setItem(CONV_KEY, id);
  } catch {
    /* storage blocked: the next question starts a new conversation */
  }
}
