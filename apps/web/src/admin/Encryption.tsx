import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { Badge } from '../ui';
import type { KmsView } from './client';
import { kmsErrorKey, kmsStatusKey, kmsStatusTone, rewrapAll, validateKmsForm, type KmsForm } from './byok-helpers';
import { formatTimestamp } from './helpers';
import { ConfirmDialog, ErrorBox, Modal, Status, tf, useAdmin } from './ui';

/** The connection form. The token lives only in this component's state; the dialog unmounts after saving, which discards it. */
function KmsDialog({ current, onClose, onSaved }: { current: KmsView | null; onClose: () => void; onSaved: () => void }) {
  const { client, lang } = useAdmin();
  const [f, setF] = useState<KmsForm>({
    addr: current?.addr ?? 'https://',
    token: '',
    keyName: current?.keyName ?? '',
    mount: current?.mount ?? 'transit',
    namespace: current?.namespace ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof KmsForm) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = validateKmsForm(f);
    if (bad) {
      setErr(t(lang, bad));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await client.putKms({
        addr: f.addr.trim(),
        token: f.token,
        keyName: f.keyName.trim(),
        mount: f.mount.trim() || undefined,
        namespace: f.namespace.trim() || undefined,
      });
      onSaved();
    } catch (x) {
      setErr(t(lang, kmsErrorKey(x, 'put')));
      setBusy(false);
    }
  };
  return (
    <Modal title={t(lang, current ? 'admEncFormTitleEdit' : 'admEncFormTitleNew')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form" data-testid="kms-form" autoComplete="off">
        <label>{t(lang, 'admEncAddr')}
          <input type="url" required maxLength={2048} autoComplete="off" spellCheck={false} value={f.addr} onChange={set('addr')} data-testid="kms-addr" />
        </label>
        <label>{t(lang, 'admEncToken')}
          <input type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} value={f.token} onChange={set('token')} data-testid="kms-token" />
        </label>
        <p className="muted">{t(lang, 'admEncTokenHint')}</p>
        <label>{t(lang, 'admEncKeyName')}
          <input required maxLength={64} autoComplete="off" spellCheck={false} value={f.keyName} onChange={set('keyName')} data-testid="kms-key" />
        </label>
        <label>{t(lang, 'admEncMount')}
          <input maxLength={200} autoComplete="off" spellCheck={false} value={f.mount} onChange={set('mount')} />
        </label>
        <label>{t(lang, 'admEncNamespace')}
          <input maxLength={128} autoComplete="off" spellCheck={false} value={f.namespace} onChange={set('namespace')} />
        </label>
        <ErrorBox text={err} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t(lang, 'cancel')}</button>
          <button type="submit" className="primary" disabled={busy}>{t(lang, 'admEncSave')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Encryption() {
  const { client, lang, report } = useAdmin();
  const [view, setView] = useState<KmsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remErr, setRemErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setView(await client.getKms());
    } catch (e) {
      report(e); // a 403 switches the console to the "no access" page
      setErr(t(lang, kmsErrorKey(e)));
    }
  }, [client, lang, report]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const test = async () => {
    setBusy(true);
    setErr(null);
    setNotice('');
    try {
      const r = await client.testKms();
      setNotice(r.status === 'ok' ? t(lang, 'admEncTestOk') : tf(lang, 'admEncTestFailed', { status: t(lang, kmsStatusKey(r.status)) }));
      await load();
    } catch (e) {
      setErr(t(lang, kmsErrorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  const rewrap = async (target: 'customer' | 'platform') => {
    setBusy(true);
    setErr(null);
    setNotice(tf(lang, 'admEncRewrapRunning', { done: 0 }));
    try {
      const r = await rewrapAll((b) => client.rewrapKms(b), target, (n) => setNotice(tf(lang, 'admEncRewrapRunning', { done: n })));
      setNotice(tf(lang, 'admEncRewrapDone', { done: r.processed, failed: r.failed, remaining: r.remaining }));
    } catch (e) {
      setNotice('');
      setErr(t(lang, kmsErrorKey(e)));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const remove = async () => {
    setBusy(true);
    setRemErr(null);
    try {
      await client.removeKms();
      setRemoving(false);
      setNotice(t(lang, 'admEncRemoved'));
      await load();
    } catch (e) {
      setRemErr(t(lang, kmsErrorKey(e, 'remove')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="sec-encryption" data-testid="kms-section">
      <h2 id="sec-encryption" className="sec-title">{t(lang, 'admEncryption')}</h2>
      <p className="muted">{t(lang, 'admEncIntro')}</p>
      <Status text={notice} />
      <ErrorBox text={err} />
      {view === null && !err && <p className="muted" role="status">{t(lang, 'admEncLoading')}</p>}
      {view !== null && !view.configured && (
        <div className="int-block">
          <p data-testid="kms-platform">{t(lang, 'admEncPlatform')}</p>
          <div className="toolbar">
            <button type="button" className="primary" onClick={() => setEditing(true)}>{t(lang, 'admEncConfigure')}</button>
          </div>
        </div>
      )}
      {view !== null && view.configured && (
        <div className="int-block" data-testid="kms-status">
          <dl className="kv">
            <dt>{t(lang, 'admEncProvider')}</dt>
            <dd>{t(lang, 'admEncProviderVault')}</dd>
            <dt>{t(lang, 'admEncAddr')}</dt>
            <dd className="wrap-anywhere">{view.addr}</dd>
            <dt>{t(lang, 'admEncKeyId')}</dt>
            <dd><code className="code">{view.kekId}</code></dd>
            <dt>{t(lang, 'admEncStatus')}</dt>
            <dd><Badge tone={kmsStatusTone(view.status ?? 'unknown')} dot>{t(lang, kmsStatusKey(view.status ?? 'unknown'))}</Badge></dd>
            {view.checkedAt && (
              <>
                <dt>{t(lang, 'admEncChecked')}</dt>
                <dd>{formatTimestamp(view.checkedAt, lang)}</dd>
              </>
            )}
          </dl>
          <p>{tf(lang, 'admEncWrapped', { files: view.wrapped?.files ?? 0, recordings: view.wrapped?.recordings ?? 0 })}</p>
          <p className="muted">{t(lang, 'admEncRewrapHint')}</p>
          <div className="toolbar">
            <button type="button" onClick={() => void test()} disabled={busy}>{t(lang, 'admEncTest')}</button>
            <button type="button" onClick={() => void rewrap('customer')} disabled={busy}>{t(lang, 'admEncRewrapTo')}</button>
            <button type="button" onClick={() => void rewrap('platform')} disabled={busy}>{t(lang, 'admEncRewrapBack')}</button>
            <button type="button" onClick={() => setEditing(true)} disabled={busy}>{t(lang, 'admEncReplace')}</button>
            <button type="button" className="danger" onClick={() => { setRemErr(null); setRemoving(true); }} disabled={busy}>{t(lang, 'admEncRemove')}</button>
          </div>
        </div>
      )}
      {editing && (
        <KmsDialog
          current={view?.configured ? view : null}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setNotice(t(lang, 'admEncSaved'));
            void load();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={t(lang, 'admEncRemove')}
          message={t(lang, 'admEncRemoveConfirm')}
          confirmLabel={t(lang, 'admEncRemove')}
          danger
          busy={busy}
          error={remErr}
          onConfirm={() => void remove()}
          onCancel={() => setRemoving(false)}
        />
      )}
    </section>
  );
}
