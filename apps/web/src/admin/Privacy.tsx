import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { Avatar, Badge, Button, TextField } from '../ui';
import type { AdminUser } from './client';
import { saveBlob } from './download';
import { isForbidden, mergePage, type PagedState } from './helpers';
import { confirmMatches, ERASED_EMAIL, isErased, privacyErrorKey } from './privacy-helpers';
import { ErrorBox, Modal, Status, TableWrap, tf, useAdmin } from './ui';

const PAGE = 25;

/** Typed confirmation: the button stays disabled until the exact e-mail address of the account has been typed. */
function EraseDialog({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
  const { client, lang, report } = useAdmin();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = user.displayName || user.email;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmMatches(typed, user.email) || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await client.eraseUser(user.id, typed);
      onDone();
    } catch (x) {
      setErr(t(lang, isForbidden(x) ? report(x) : privacyErrorKey(x)));
      setBusy(false);
    }
  };
  return (
    <Modal title={tf(lang, 'admPrivEraseTitle', { name })} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form">
        <p>{t(lang, 'admPrivEraseBody')}</p>
        <TextField label={tf(lang, 'admPrivEraseType', { email: user.email })} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} maxLength={320} autoFocus />
        <ErrorBox text={err} />
        <div className="modal-actions">
          <Button type="button" onClick={onClose}>{t(lang, 'cancel')}</Button>
          <Button type="submit" className="danger" variant="danger" disabled={busy || !confirmMatches(typed, user.email)}>{t(lang, 'admPrivEraseGo')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Admin console "Privacy": export or erase one person's data. `save` is injectable for tests. */
export function Privacy({ save = saveBlob }: { save?: (blob: Blob, filename: string) => void }) {
  const { client, lang, report } = useAdmin();
  const [state, setState] = useState<PagedState<AdminUser>>({ items: [], next: null });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [erasing, setErasing] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (q: string, cursor: string | null) => {
      const id = ++reqId.current;
      setLoading(true);
      setErr(null);
      try {
        const page = await client.listUsers({ search: q, limit: PAGE, cursor });
        if (id !== reqId.current) return;
        setState((prev) => mergePage(prev, page, cursor !== null));
      } catch (e) {
        if (id === reqId.current) setErr(t(lang, report(e)));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [client, lang, report],
  );

  useEffect(() => {
    void load(search, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, client]);

  const nameOf = (u: AdminUser) => u.displayName || u.email;

  const exportOne = async (u: AdminUser) => {
    setBusyId(u.id);
    setErr(null);
    setNotice('');
    try {
      const { blob, filename } = await client.exportUserData(u.id);
      save(blob, filename);
      setNotice(tf(lang, 'admPrivExportDone', { name: nameOf(u) }));
    } catch (e) {
      setErr(t(lang, isForbidden(e) ? report(e) : privacyErrorKey(e)));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-labelledby="sec-privacy">
      <h2 id="sec-privacy" className="sec-title">{t(lang, 'admPrivacy')}</h2>
      <p className="muted">{t(lang, 'admPrivIntro')}</p>
      <div className="toolbar">
        <form
          role="search"
          className="row grow"
          onSubmit={(e) => {
            e.preventDefault();
            const q = searchInput.trim();
            if (q === search) void load(q, null);
            else setSearch(q);
          }}
        >
          <input type="search" aria-label={t(lang, 'admSearch')} placeholder={t(lang, 'admSearchPh')} maxLength={100} value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          <Button type="submit">{t(lang, 'admSearch')}</Button>
        </form>
      </div>
      <Status text={notice} />
      <ErrorBox text={err} />
      <TableWrap label={t(lang, 'admTableScroll')}>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">{t(lang, 'admEmail')}</th>
              <th scope="col">{t(lang, 'admName')}</th>
              <th scope="col">{t(lang, 'admStatus')}</th>
              <th scope="col">{t(lang, 'admActions')}</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((u) => (
              <tr key={u.id} className={u.disabled ? 'is-disabled' : undefined}>
                <td>
                  <span className="who-cell">
                    <Avatar name={nameOf(u)} id={u.id} size={28} decorative />
                    <span>{u.email}</span>
                  </span>
                </td>
                <td>{u.displayName}</td>
                <td>
                  {isErased(u) ? (
                    <Badge tone="neutral">{t(lang, 'admPrivErased')}</Badge>
                  ) : (
                    <Badge tone={u.disabled ? 'neutral' : 'success'} dot>{u.disabled ? t(lang, 'admDisabled') : t(lang, 'admActive')}</Badge>
                  )}
                </td>
                <td className="actions">
                  {!isErased(u) && (
                    <>
                      <Button disabled={busyId === u.id} onClick={() => void exportOne(u)} aria-label={`${t(lang, 'admPrivExport')}: ${u.email}`}>{t(lang, 'admPrivExport')}</Button>
                      <Button className="danger" variant="danger" onClick={() => setErasing(u)} aria-label={`${t(lang, 'admPrivErase')}: ${u.email}`}>{t(lang, 'admPrivErase')}</Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {loading && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {!loading && !err && state.items.length === 0 && <p className="muted">{t(lang, 'admNoItems')}</p>}
      {state.next && !loading && <Button onClick={() => void load(search, state.next)}>{t(lang, 'admLoadMore')}</Button>}
      {erasing && (
        <EraseDialog
          user={erasing}
          onClose={() => setErasing(null)}
          onDone={() => {
            const done = erasing;
            setState((s) => ({
              ...s,
              items: s.items.map((x) => (x.id === done.id ? { ...x, email: ERASED_EMAIL, displayName: 'Erased user', disabled: true, role: 'member', department: null } : x)),
            }));
            setNotice(tf(lang, 'admPrivEraseDone', { name: nameOf(done) }));
            setErasing(null);
          }}
        />
      )}
    </section>
  );
}
