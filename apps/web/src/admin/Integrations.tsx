import { useCallback, useEffect, useRef, useState } from 'react';
import { t, type Lang } from '../i18n';
import { Badge } from '../ui';
import type { ApiKeyItem, DeliveryItem, WebhookItem } from './client';
import { formatTimestamp, mergePage, type PagedState } from './helpers';
import {
  API_KEY_SCOPES,
  WEBHOOK_EVENTS,
  deliveryStatusKey,
  eventLabelKey,
  integrationErrorKey,
  scopeLabelKey,
  toggleOrdered,
  validateHookForm,
  validateKeyForm,
  type ApiKeyScope,
  type DeliveryStatus,
  type WebhookEvent,
} from './integrations-helpers';
import { ConfirmDialog, ErrorBox, Modal, Status, TableWrap, tf, useAdmin } from './ui';

/** Shows a secret once. It lives only in the parent's state while this dialog is mounted: never stored, never re-fetched. */
function SecretDialog({ title, secret, onDone }: { title: string; secret: string; onDone: () => void }) {
  const { lang } = useAdmin();
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      field.current?.focus(); // Clipboard API unavailable: select the text so Ctrl+C works
      field.current?.select();
    }
  };
  return (
    <Modal title={title} onClose={onDone}>
      <div className="warn" role="alert">{t(lang, 'admIntSecretWarn')}</div>
      <div className="row">
        <input ref={field} readOnly aria-label={title} data-testid="int-secret" value={secret} className="code pw" autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={() => void copy()}>{t(lang, 'admIntSecretCopy')}</button>
      </div>
      <Status text={copied ? t(lang, 'admCopied') : ''} />
      <div className="modal-actions">
        <button type="button" className="primary" onClick={onDone}>{t(lang, 'admIntSecretDone')}</button>
      </div>
    </Modal>
  );
}

function Checkboxes<T extends string>({ legend, all, value, label, onChange }: { legend: string; all: readonly T[]; value: readonly T[]; label: (v: T) => string; onChange: (v: T[]) => void }) {
  return (
    <fieldset className="checks">
      <legend>{legend}</legend>
      {all.map((v) => (
        <label key={v} className="check">
          <input type="checkbox" checked={value.includes(v)} onChange={() => onChange(toggleOrdered(value, v, all))} />
          {label(v)}
        </label>
      ))}
    </fieldset>
  );
}

// ---- API keys -------------------------------------------------------------------------------------------------------

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (k: ApiKeyItem, secret: string) => void }) {
  const { client, lang } = useAdmin();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['meetings:read']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = validateKeyForm({ name, scopes });
    if (bad) {
      setErr(t(lang, bad));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { secret, ...item } = await client.createApiKey({ name: name.trim(), scopes });
      onCreated(item, secret);
    } catch (x) {
      setErr(t(lang, integrationErrorKey(x, 'key')));
      setBusy(false);
    }
  };
  return (
    <Modal title={t(lang, 'admIntKeyCreate')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form">
        <label>{t(lang, 'admIntKeyName')}
          <input required maxLength={80} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Checkboxes legend={t(lang, 'admIntKeyScopes')} all={API_KEY_SCOPES} value={scopes} label={(s) => t(lang, scopeLabelKey(s))} onChange={setScopes} />
        <ErrorBox text={err} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t(lang, 'cancel')}</button>
          <button type="submit" className="primary" disabled={busy}>{t(lang, 'create')}</button>
        </div>
      </form>
    </Modal>
  );
}

function ApiKeys() {
  const { client, lang, report } = useAdmin();
  const [items, setItems] = useState<ApiKeyItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [revErr, setRevErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setItems(await client.listApiKeys());
    } catch (e) {
      setErr(t(lang, report(e)));
    }
  }, [client, lang, report]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setRevErr(null);
    try {
      await client.revokeApiKey(revoking.id);
      setNotice(tf(lang, 'admIntKeyRevokedMsg', { name: revoking.name }));
      setRevoking(null);
      await load();
    } catch (x) {
      setRevErr(t(lang, report(x)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="sec-int-keys" className="int-block">
      <h3 id="sec-int-keys" className="sub-title">{t(lang, 'admIntKeysTitle')}</h3>
      <p className="muted">{t(lang, 'admIntKeysHint')}</p>
      <div className="toolbar">
        <button type="button" className="primary" onClick={() => setCreating(true)}>{t(lang, 'admIntKeyCreate')}</button>
      </div>
      <Status text={notice} />
      <ErrorBox text={err} />
      {items === null && !err && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {items !== null && items.length === 0 && <p className="muted">{t(lang, 'admIntKeyNoItems')}</p>}
      {items !== null && items.length > 0 && (
        <TableWrap label={t(lang, 'admTableScroll')}>
          <table className="data" data-testid="int-keys">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'admIntKeyName')}</th>
                <th scope="col">{t(lang, 'admIntKeyPrefix')}</th>
                <th scope="col">{t(lang, 'admIntKeyScopes')}</th>
                <th scope="col">{t(lang, 'admIntKeyLastUsed')}</th>
                <th scope="col">{t(lang, 'admActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td><code className="code">dbx_{k.prefix}_…</code></td>
                  <td>{k.scopes.map((s) => t(lang, scopeLabelKey(s))).join(', ')}</td>
                  <td>{k.lastUsedAt ? formatTimestamp(k.lastUsedAt, lang) : t(lang, 'admIntKeyNever')}</td>
                  <td className="actions">
                    {k.revokedAt ? (
                      <Badge tone="neutral">{t(lang, 'admIntKeyRevoked')}</Badge>
                    ) : (
                      <button onClick={() => { setRevErr(null); setRevoking(k); }} aria-label={`${t(lang, 'admIntKeyRevoke')}: ${k.name}`}>{t(lang, 'admIntKeyRevoke')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(k, s) => {
            setCreating(false);
            setSecret(s);
            setItems((cur) => [k, ...(cur ?? [])]);
          }}
        />
      )}
      {secret !== null && <SecretDialog title={t(lang, 'admIntSecretKeyTitle')} secret={secret} onDone={() => setSecret(null)} />}
      {revoking && (
        <ConfirmDialog
          title={t(lang, 'admIntKeyRevoke')}
          message={tf(lang, 'admIntKeyRevokeConfirm', { name: revoking.name })}
          confirmLabel={t(lang, 'admIntKeyRevoke')}
          danger
          busy={busy}
          error={revErr}
          onConfirm={() => void revoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </section>
  );
}

// ---- Webhooks -------------------------------------------------------------------------------------------------------

function CreateHookDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (h: WebhookItem, secret: string) => void }) {
  const { client, lang } = useAdmin();
  const [url, setUrl] = useState('https://');
  const [events, setEvents] = useState<WebhookEvent[]>(['meeting.created']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = validateHookForm({ url, events });
    if (bad) {
      setErr(t(lang, bad));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { secret, ...item } = await client.createWebhook({ url: url.trim(), events });
      onCreated(item, secret);
    } catch (x) {
      setErr(t(lang, integrationErrorKey(x, 'hook')));
      setBusy(false);
    }
  };
  return (
    <Modal title={t(lang, 'admIntHookCreate')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form">
        <label>{t(lang, 'admIntHookUrl')}
          <input type="url" required maxLength={2048} autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <Checkboxes legend={t(lang, 'admIntHookEvents')} all={WEBHOOK_EVENTS} value={events} label={(v) => t(lang, eventLabelKey(v))} onChange={setEvents} />
        <ErrorBox text={err} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t(lang, 'cancel')}</button>
          <button type="submit" className="primary" disabled={busy}>{t(lang, 'create')}</button>
        </div>
      </form>
    </Modal>
  );
}

const STATUS_TONE: Record<DeliveryStatus, 'neutral' | 'success' | 'danger'> = { pending: 'neutral', delivered: 'success', dead: 'danger' };

function describeResult(d: DeliveryItem): string {
  if (d.lastError) return d.lastError;
  return d.lastStatus ? `HTTP ${d.lastStatus}` : '';
}

function DeliveriesDialog({ hook, lang, onClose }: { hook: WebhookItem; lang: Lang; onClose: () => void }) {
  const { client, report } = useAdmin();
  const [status, setStatus] = useState<DeliveryStatus | ''>('');
  const [state, setState] = useState<PagedState<DeliveryItem>>({ items: [], next: null });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      const id = ++reqId.current;
      setLoading(true);
      setErr(null);
      try {
        const page = await client.listDeliveries(hook.id, { status: status || undefined, limit: 25, cursor });
        if (id === reqId.current) setState((prev) => mergePage(prev, page, cursor !== null));
      } catch (e) {
        if (id === reqId.current) setErr(t(lang, report(e)));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [client, hook.id, status, lang, report],
  );
  useEffect(() => {
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <Modal title={`${t(lang, 'admIntDelTitle')}: ${hook.url}`} onClose={onClose} wide>
      <label className="inline-label">{t(lang, 'admStatus')}
        <select value={status} onChange={(e) => setStatus(e.target.value as DeliveryStatus | '')} aria-label={t(lang, 'admStatus')}>
          <option value="">{t(lang, 'admIntDelStatusAll')}</option>
          {(['pending', 'delivered', 'dead'] as const).map((s) => <option key={s} value={s}>{t(lang, deliveryStatusKey(s))}</option>)}
        </select>
      </label>
      <ErrorBox text={err} />
      {loading && state.items.length === 0 && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {!loading && !err && state.items.length === 0 && <p className="muted">{t(lang, 'admIntDelNone')}</p>}
      {state.items.length > 0 && (
        <TableWrap label={t(lang, 'admTableScroll')}>
          <table className="data" data-testid="int-deliveries">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'admTime')}</th>
                <th scope="col">{t(lang, 'admIntDelEvent')}</th>
                <th scope="col">{t(lang, 'admStatus')}</th>
                <th scope="col">{t(lang, 'admIntDelAttempts')}</th>
                <th scope="col">{t(lang, 'admIntDelResult')}</th>
                <th scope="col">{t(lang, 'admIntDelNext')}</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((d) => (
                <tr key={d.id}>
                  <td>{formatTimestamp(d.createdAt, lang)}</td>
                  <td>{d.eventType}</td>
                  <td><Badge tone={STATUS_TONE[d.status]} dot>{t(lang, deliveryStatusKey(d.status))}</Badge></td>
                  <td>{d.attempts}</td>
                  <td>{describeResult(d)}</td>
                  <td>{d.status === 'pending' ? formatTimestamp(d.nextAttemptAt, lang) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <div className="modal-actions">
        {state.next && <button type="button" disabled={loading} onClick={() => void load(state.next)}>{t(lang, 'admLoadMore')}</button>}
        <button type="button" className="primary" onClick={onClose}>{t(lang, 'admIntClose')}</button>
      </div>
    </Modal>
  );
}

function Webhooks() {
  const { client, lang, report } = useAdmin();
  const [items, setItems] = useState<WebhookItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WebhookItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<WebhookItem | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setItems(await client.listWebhooks());
    } catch (e) {
      setErr(t(lang, report(e)));
    }
  }, [client, lang, report]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setDelErr(null);
    try {
      await client.deleteWebhook(deleting.id);
      setItems((cur) => (cur ?? []).filter((h) => h.id !== deleting.id));
      setNotice(tf(lang, 'admIntHookDeletedMsg', { name: host(deleting.url) }));
      setDeleting(null);
    } catch (x) {
      setDelErr(t(lang, report(x)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="sec-int-hooks" className="int-block">
      <h3 id="sec-int-hooks" className="sub-title">{t(lang, 'admIntHooksTitle')}</h3>
      <p className="muted">{t(lang, 'admIntHooksHint')}</p>
      <div className="toolbar">
        <button type="button" className="primary" onClick={() => setCreating(true)}>{t(lang, 'admIntHookCreate')}</button>
      </div>
      <Status text={notice} />
      <ErrorBox text={err} />
      {items === null && !err && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {items !== null && items.length === 0 && <p className="muted">{t(lang, 'admIntHookNoItems')}</p>}
      {items !== null && items.length > 0 && (
        <TableWrap label={t(lang, 'admTableScroll')}>
          <table className="data" data-testid="int-hooks">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'admIntHookUrl')}</th>
                <th scope="col">{t(lang, 'admIntHookEvents')}</th>
                <th scope="col">{t(lang, 'admCreated')}</th>
                <th scope="col">{t(lang, 'admActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((h) => (
                <tr key={h.id}>
                  <td className="wrap-anywhere">{h.url}</td>
                  <td>{h.events.map((e) => t(lang, eventLabelKey(e))).join(', ')}</td>
                  <td>{formatTimestamp(h.createdAt, lang)}</td>
                  <td className="actions">
                    <button onClick={() => setViewing(h)} aria-label={`${t(lang, 'admIntHookDeliveries')}: ${host(h.url)}`}>{t(lang, 'admIntHookDeliveries')}</button>
                    <button onClick={() => { setDelErr(null); setDeleting(h); }} aria-label={`${t(lang, 'admIntHookDelete')}: ${host(h.url)}`}>{t(lang, 'admIntHookDelete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {creating && (
        <CreateHookDialog
          onClose={() => setCreating(false)}
          onCreated={(h, s) => {
            setCreating(false);
            setSecret(s);
            setItems((cur) => [h, ...(cur ?? [])]);
          }}
        />
      )}
      {secret !== null && <SecretDialog title={t(lang, 'admIntSecretHookTitle')} secret={secret} onDone={() => setSecret(null)} />}
      {viewing && <DeliveriesDialog hook={viewing} lang={lang} onClose={() => setViewing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={t(lang, 'admIntHookDelete')}
          message={tf(lang, 'admIntHookDeleteConfirm', { name: host(deleting.url) })}
          confirmLabel={t(lang, 'admIntHookDelete')}
          danger
          busy={busy}
          error={delErr}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

export function Integrations() {
  const { lang } = useAdmin();
  return (
    <section aria-labelledby="sec-integrations">
      <h2 id="sec-integrations" className="sec-title">{t(lang, 'admIntegrations')}</h2>
      <ApiKeys />
      <Webhooks />
    </section>
  );
}
