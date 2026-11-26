import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { tx } from '../home/text';
import type { Lang } from '../i18n';
import { Button, IconButton, IconHelp, IconSend, IconX, Spinner, useEscapeLayer } from '../ui';
import { AssistantApiError, assistantAsk, assistantStatus, loadConversationId, saveConversationId, type AnswerSource, type AssistantPage, type TokenSource } from './assistant-api';
import { faqById, isConfident, searchHelp } from './content';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  source?: AnswerSource;
  related?: Array<{ id: string; q: string }>;
}

export interface AssistantPanelProps {
  lang: Lang;
  page: AssistantPage;
  token?: TokenSource;
  onClose: () => void;
}

const DEFAULT_MAX = 500;

/**
 * The help assistant window (decisions 5-5e). FAQ first: while the person types, matching FAQ entries are offered and
 * answered locally without a request. A sent question goes to the API, which answers from the FAQ, from the language
 * model (if configured) or with a fixed fallback. The window says up front that conversations are stored.
 */
export default function AssistantPanel({ lang, page, token, onClose }: AssistantPanelProps) {
  const titleId = useId();
  const inputId = useId();
  const counterId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const seq = useRef(1);
  const [messages, setMessages] = useState<Message[]>([{ id: 0, role: 'assistant', text: tx(lang, 'asIntro') }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'llm' | 'faq' | null>(null);
  const [maxChars, setMaxChars] = useState(DEFAULT_MAX);
  const isTop = useEscapeLayer(true);

  useEffect(() => {
    inputRef.current?.focus();
    let live = true;
    assistantStatus(token).then(
      (s) => {
        if (!live) return;
        setMode(s.enabled ? s.mode : null);
        setMaxChars(s.maxChars);
        if (!s.enabled) setError(tx(lang, 'asErrDisabled'));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // lang is read once for the error text; the status itself does not depend on it.
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, isTop]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, busy]);

  // FAQ search first (decision 5a): offered while typing, answered without a request.
  const ready = useMemo(() => {
    const q = text.trim();
    if (q.length < 3) return [];
    return searchHelp(lang, q, 3)
      .filter((h) => h.matched > 0 && (isConfident(h) || h.score >= 0.8))
      .map((h) => faqById(h.id))
      .filter((e): e is NonNullable<typeof e> => !!e);
  }, [text, lang]);

  const push = (m: Omit<Message, 'id'>) => setMessages((list) => [...list, { ...m, id: seq.current++ }]);

  const showFaq = (id: string) => {
    const e = faqById(id);
    if (!e) return;
    push({ role: 'user', text: e[lang].q });
    push({ role: 'assistant', text: e[lang].a, source: 'faq' });
    setText('');
    inputRef.current?.focus();
  };

  const length = [...text].length;
  const tooLong = length > maxChars;

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const message = text.trim();
    if (!message || busy || tooLong) return;
    setError(null);
    push({ role: 'user', text: message });
    setText('');
    setBusy(true);
    try {
      const r = await assistantAsk({ message, lang, page, conversationId: loadConversationId() }, token);
      saveConversationId(r.conversationId);
      push({ role: 'assistant', text: r.answer, source: r.source, related: r.suggestions });
    } catch (err) {
      const code = err instanceof AssistantApiError ? err.code : '';
      setError(tx(lang, code === 'rate_limited' ? 'asErrRate' : code === 'daily_limit' ? 'asErrDaily' : code === 'disabled' ? 'asErrDisabled' : code === 'too_long' ? 'asTooLong' : 'asErrGeneric', { max: maxChars }));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="as-panel lg-panel" role="dialog" aria-modal="false" aria-labelledby={titleId} ref={panelRef} data-testid="assistant-panel">
      <div className="as-head">
        <h2 className="as-title" id={titleId}>
          {tx(lang, 'asTitle')}
        </h2>
        <IconButton label={tx(lang, 'asClose')} icon={<IconX size={18} />} onClick={onClose} tooltip={false} size="sm" data-testid="assistant-close" />
      </div>
      <p className="as-notice" data-testid="assistant-stored">
        {tx(lang, 'asStored')} <a href="/privacy#legal-assistant">{tx(lang, 'asPrivacyLink')}</a>
      </p>
      {mode === 'faq' ? <p className="as-mode">{tx(lang, 'asModeFaq')}</p> : null}
      <div className="as-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-busy={busy}>
        {messages.map((m) => (
          <div key={m.id} className={`as-msg as-msg--${m.role}`} data-source={m.source}>
            <span className="ln-sr">{tx(lang, m.role === 'user' ? 'asYou' : 'asBot')}: </span>
            <p className="as-msg__text">{m.text}</p>
            {m.source === 'faq' ? <p className="as-msg__meta">{tx(lang, 'asSourceFaq')}</p> : m.source === 'llm' ? <p className="as-msg__meta">{tx(lang, 'asSourceLlm')}</p> : null}
            {m.related && m.related.length ? (
              <div className="as-chips" aria-label={tx(lang, 'asRelated')} role="group">
                {m.related.map((r) => (
                  <Button key={r.id} size="sm" variant="secondary" className="as-chip" onClick={() => showFaq(r.id)}>
                    {r.q}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {busy ? (
          <div className="as-msg as-msg--assistant as-msg--busy" role="status">
            <Spinner size={16} />
            <span>{tx(lang, 'asSending')}</span>
          </div>
        ) : null}
      </div>
      {ready.length ? (
        <div className="as-ready" role="group" aria-label={tx(lang, 'asSuggestTitle')} data-testid="assistant-ready">
          <span className="as-ready__title">{tx(lang, 'asSuggestTitle')}</span>
          {ready.map((e) => (
            <Button key={e.id} size="sm" variant="ghost" className="as-chip" onClick={() => showFaq(e.id)}>
              {e[lang].q}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="as-error" role="alert">
          {error} <a href="/help">{tx(lang, 'asHelpPage')}</a>
        </p>
      ) : null}
      <form className="as-form" onSubmit={send}>
        <label className="ln-sr" htmlFor={inputId}>
          {tx(lang, 'asInputLabel')}
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          className="as-input"
          rows={2}
          value={text}
          placeholder={tx(lang, 'asPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={counterId}
          aria-invalid={tooLong || undefined}
          maxLength={maxChars * 2}
          data-testid="assistant-input"
        />
        <div className="as-form__row">
          <span id={counterId} className={`as-counter${tooLong ? ' as-counter--over' : ''}`}>
            {tooLong ? tx(lang, 'asTooLong', { max: maxChars }) : tx(lang, 'asCounter', { n: length, max: maxChars })}
          </span>
          <a className="as-help" href="/help">
            <IconHelp size={16} />
            {tx(lang, 'asHelpPage')}
          </a>
          <Button type="submit" variant="primary" size="sm" icon={<IconSend size={16} />} disabled={!text.trim() || tooLong} loading={busy} data-testid="assistant-send">
            {tx(lang, 'asSend')}
          </Button>
        </div>
      </form>
    </div>
  );
}
