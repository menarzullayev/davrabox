// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionaries, type Lang } from '../i18n';
import { isHelpPath } from '../routes';
import AssistantPanel from './AssistantPanel';
import { AssistantLauncher } from './AssistantLauncher';
import { HELP } from './content';
import HelpPage from './HelpPage';
import { helpEn, helpRu, helpUz } from './i18n-help';

const LANGS: Lang[] = ['uz', 'ru', 'en'];

interface Call {
  url: string;
  init?: RequestInit;
}
let calls: Call[] = [];
let askReply: { status: number; body: unknown } = { status: 200, body: {} };
let statusReply: unknown = { enabled: true, mode: 'faq', maxChars: 500, retentionDays: 30 };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/status')) return new Response(JSON.stringify(statusReply), { status: 200 });
    return new Response(JSON.stringify(askReply.body), { status: askReply.status });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  location.hash = '';
});

describe('help dictionaries and route', () => {
  it('has the same keys in uz, ru and en, all non-empty and merged into the main dictionaries', () => {
    const keys = Object.keys(helpUz).sort();
    expect(Object.keys(helpRu).sort()).toEqual(keys);
    expect(Object.keys(helpEn).sort()).toEqual(keys);
    for (const lang of LANGS) for (const k of keys) expect((dictionaries[lang] as Record<string, string>)[k]?.trim(), `${lang}.${k}`).toBeTruthy();
  });

  it('/help is its own route', () => {
    expect(isHelpPath('/help')).toBe(true);
    expect(isHelpPath('/help/')).toBe(true);
    expect(isHelpPath('/helpdesk')).toBe(false);
  });
});

describe('help page', () => {
  it('renders one h1, every guide and every FAQ entry in each language', () => {
    for (const lang of LANGS) {
      localStorage.setItem('lang', lang);
      const { container, unmount } = render(<HelpPage />);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      expect(container.querySelectorAll('[data-testid=faq]')).toHaveLength(HELP.faq.length);
      for (const g of HELP.guides) expect(container.querySelector(`#guide-${g.id}`)?.textContent).toContain(g[lang].title);
      for (const e of HELP.faq) expect(container.querySelector(`#faq-${e.id} summary`)?.textContent).toBe(e[lang].q);
      expect(document.title).toBe(dictionaries[lang].hpPageTitle);
      expect(container.textContent).not.toMatch(/\b(hp|as|ln)[A-Z][A-Za-z0-9]+\b/);
      unmount();
    }
  });

  it('searches the FAQ as you type and links to the answer', () => {
    localStorage.setItem('lang', 'ru');
    render(<HelpPage />);
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'не работает камера' } });
    const results = screen.getByTestId('help-results');
    const first = within(results).getAllByRole('link')[0]!;
    expect(first.getAttribute('href')).toBe('#faq-camera-mic');
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'qwertyuiop zxcvb' } });
    expect(within(screen.getByTestId('help-results')).getByText(dictionaries.ru.hpSearchNone)).toBeTruthy();
  });

  it('opens the FAQ entry named in the address fragment', () => {
    location.hash = '#faq-checksum';
    render(<HelpPage />);
    expect((document.getElementById('faq-checksum') as HTMLDetailsElement).open).toBe(true);
    expect((document.getElementById('faq-trial') as HTMLDetailsElement).open).toBe(false);
  });

  it('has the help assistant button', () => {
    render(<HelpPage />);
    expect(screen.getByTestId('assistant-open')).toBeTruthy();
  });
});

describe('help assistant window', () => {
  const panel = (lang: Lang = 'en', onClose = vi.fn()) => render(<AssistantPanel lang={lang} page="landing" onClose={onClose} />);

  it('says up front that conversations are stored for 30 days, and links the privacy notice', async () => {
    panel('uz');
    const note = screen.getByTestId('assistant-stored');
    expect(note.textContent).toContain(dictionaries.uz.asStored);
    expect(within(note).getByRole('link').getAttribute('href')).toBe('/privacy#legal-assistant');
    await screen.findByText(dictionaries.uz.asModeFaq);
  });

  it('offers FAQ answers while typing and shows one without asking the server', async () => {
    panel('en');
    fireEvent.change(screen.getByTestId('assistant-input'), { target: { value: 'how to share my screen' } });
    const ready = screen.getByTestId('assistant-ready');
    const entry = HELP.faq.find((e) => e.id === 'screen-share')!;
    fireEvent.click(within(ready).getByRole('button', { name: entry.en.q }));
    expect(screen.getByText(entry.en.a)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/ask'))).toHaveLength(0);
  });

  it('sends a question with the page and language, keeps the conversation id, and labels a model answer', async () => {
    askReply = { status: 200, body: { conversationId: '0b9a7d3e-6f1c-4c2a-9d1e-2f3a4b5c6d7e', answer: 'Model answer', source: 'llm', faqId: null, lang: 'en', suggestions: [] } };
    panel('en');
    fireEvent.change(screen.getByTestId('assistant-input'), { target: { value: 'something unusual' } });
    fireEvent.click(screen.getByTestId('assistant-send'));
    await screen.findByText('Model answer');
    expect(screen.getByText(helpEn.asSourceLlm)).toBeTruthy();
    const ask = calls.find((c) => c.url.endsWith('/ask'))!;
    expect(ask.url).toBe('/api/v1/public/assistant/ask');
    expect(JSON.parse(String(ask.init!.body))).toEqual({ message: 'something unusual', lang: 'en', page: 'landing', conversationId: null });
    expect(sessionStorage.getItem('davra.assistant.conversation')).toBe('0b9a7d3e-6f1c-4c2a-9d1e-2f3a4b5c6d7e');
  });

  it('Enter sends, Shift+Enter does not', async () => {
    askReply = { status: 200, body: { conversationId: '0b9a7d3e-6f1c-4c2a-9d1e-2f3a4b5c6d7e', answer: 'ok', source: 'fallback', faqId: null, lang: 'en', suggestions: [] } };
    panel('en');
    const input = screen.getByTestId('assistant-input');
    fireEvent.change(input, { target: { value: 'hello there' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(calls.filter((c) => c.url.endsWith('/ask'))).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText('ok');
  });

  it('explains a rate limit and refuses a too-long question before sending', async () => {
    askReply = { status: 429, body: { code: 'rate_limited' } };
    panel('ru');
    const input = screen.getByTestId('assistant-input');
    fireEvent.change(input, { target: { value: 'вопрос' } });
    fireEvent.click(screen.getByTestId('assistant-send'));
    await screen.findByText(new RegExp(dictionaries.ru.asErrRate));
    fireEvent.change(input, { target: { value: 'x'.repeat(501) } });
    expect((screen.getByTestId('assistant-send') as HTMLButtonElement).disabled).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('Escape closes the window', () => {
    const onClose = vi.fn();
    panel('en', onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('the launcher loads the window only when opened', async () => {
    render(<AssistantLauncher lang="en" page="help" />);
    expect(screen.queryByTestId('assistant-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('assistant-open'));
    await screen.findByTestId('assistant-panel');
    expect(screen.getByTestId('assistant-open').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('assistant-close'));
    await waitFor(() => expect(screen.queryByTestId('assistant-panel')).toBeNull());
  });
});
