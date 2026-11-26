import { useCallback, useEffect, useState } from 'react';
import { t, type Key } from '../i18n';
import { Button } from '../ui';
import type { AssistantConversation, AssistantMessage, AssistantUsage } from './client';
import { ConfirmDialog, ErrorBox, Modal, TableWrap, tf, useAdmin } from './ui';

const when = (iso: string, lang: string) => new Date(iso).toLocaleString(lang === 'uz' ? 'uz-Latn' : lang, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Platform owner only (decision 5d): the stored conversations of the public help assistant, today's model spend, and
 * delete. The section is only shown when /v1/platform/assistant/owner says so; the server enforces it on every call.
 * Errors are shown here and never switch the console to "no access" (a 403 here says nothing about the org admin role).
 */
export function AssistantLog() {
  const { client, lang } = useAdmin();
  const [usage, setUsage] = useState<AssistantUsage | null>(null);
  const [items, setItems] = useState<AssistantConversation[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ conv: AssistantConversation; messages: AssistantMessage[] | null } | null>(null);
  const [del, setDel] = useState<AssistantConversation | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback(() => setErr(t(lang, 'errGeneric')), [lang]);

  const load = useCallback(
    async (before: string | null) => {
      setErr(null);
      try {
        const [u, page] = await Promise.all([before ? Promise.resolve(null) : client.assistantUsage(), client.assistantList({ before, limit: 30 })]);
        if (u) setUsage(u);
        setItems((cur) => (before ? [...cur, ...page.items] : page.items));
        setNext(page.next);
      } catch {
        fail();
      } finally {
        setLoaded(true);
      }
    },
    [client, fail],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const show = async (conv: AssistantConversation) => {
    setOpen({ conv, messages: null });
    try {
      const r = await client.assistantMessages(conv.id);
      setOpen({ conv, messages: r.items });
    } catch {
      setOpen(null);
      fail();
    }
  };

  const remove = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await client.assistantDelete(del.id);
      setItems((cur) => cur.filter((c) => c.id !== del.id));
      setDel(null);
    } catch {
      fail();
      setDel(null);
    } finally {
      setBusy(false);
    }
  };

  const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

  return (
    <section aria-labelledby="sec-assistant" data-testid="admin-assistant">
      <h2 id="sec-assistant" className="sec-title">{t(lang, 'admAssistant')}</h2>
      <p className="muted">{t(lang, 'admAsLead')}</p>
      <ErrorBox text={err} />
      {usage && (
        <dl className="stats">
          <div className="stat"><dt>{t(lang, 'admAsToday')}</dt><dd>{usage.day}</dd></div>
          <div className="stat"><dt>{t(lang, 'admAsLlm')}</dt><dd>{usage.llm === 'none' ? t(lang, 'admAsLlmNone') : `${usage.llm}${usage.model ? ` · ${usage.model}` : ''}`}</dd></div>
          <div className="stat"><dt>{t(lang, 'admAsCalls')}</dt><dd>{`${usage.llmRequests} / ${usage.dailyLlmRequests}`}</dd></div>
          <div className="stat"><dt>{t(lang, 'admAsCost')}</dt><dd>{`${money(usage.costUsd)} · ${tf(lang, 'admAsCap', { cap: money(usage.dailyUsdCap) })}`}</dd></div>
        </dl>
      )}
      {loaded && !items.length && !err ? <p className="muted">{t(lang, 'admAsEmpty')}</p> : null}
      {items.length ? (
        <TableWrap label={t(lang, 'admAssistant')}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'admAsWhen')}</th>
                <th scope="col">{t(lang, 'admAsLang')}</th>
                <th scope="col">{t(lang, 'admAsPage')}</th>
                <th scope="col">{t(lang, 'admAsCount')}</th>
                <th scope="col">{t(lang, 'admAsFirst')}</th>
                <th scope="col"><span className="as-sr">{t(lang, 'admAsOpen')}</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>{when(c.lastAt, lang)}</td>
                  <td>{c.lang}</td>
                  <td>{c.page}</td>
                  <td>{c.messages}</td>
                  <td className="as-first">{c.firstQuestion}</td>
                  <td className="as-actions">
                    <Button size="sm" onClick={() => void show(c)}>{t(lang, 'admAsOpen')}</Button>
                    <Button size="sm" variant="ghost" className="danger" onClick={() => setDel(c)}>{t(lang, 'admAsDelete')}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : null}
      {next ? <Button onClick={() => void load(next)}>{t(lang, 'admAsMore')}</Button> : null}
      {open && (
        <Modal title={`${t(lang, 'admAssistant')} · ${when(open.conv.lastAt, lang)}`} onClose={() => setOpen(null)} wide>
          {!open.messages ? (
            <p className="muted" role="status">{t(lang, 'admLoading')}</p>
          ) : (
            <ol className="as-thread">
              {open.messages.map((m, i) => (
                <li key={i} className={`as-thread__msg as-thread__msg--${m.role}`}>
                  <p className="as-thread__who">
                    {t(lang, m.role === 'user' ? 'admAsUser' : 'admAsBot')}
                    {m.source ? ` · ${t(lang, `admAsSrc_${m.source}` as Key)}` : ''} · {when(m.at, lang)}
                  </p>
                  <p className="as-thread__text">{m.text}</p>
                </li>
              ))}
            </ol>
          )}
        </Modal>
      )}
      {del && (
        <ConfirmDialog title={t(lang, 'admAsDeleteTitle')} message={t(lang, 'admAsDeleteText')} confirmLabel={t(lang, 'admAsDelete')} danger busy={busy} error={null} onConfirm={() => void remove()} onCancel={() => setDel(null)} />
      )}
    </section>
  );
}
