import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { t } from '../i18n';
import type { AdminUser, Department, Role } from './client';
import { createFlowReducer, mergePage, type PagedState } from './helpers';
import { ConfirmDialog, ErrorBox, Modal, Status, TableWrap, tf, useAdmin } from './ui';

const PAGE = 25;

function roleLabel(lang: Parameters<typeof t>[0], r: Role): string {
  return t(lang, r === 'org_admin' ? 'admRoleAdmin' : 'admRoleMember');
}

function DeptSelect({ id, value, onChange, depts }: { id: string; value: string; onChange: (v: string) => void; depts: Department[] }) {
  const { lang } = useAdmin();
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t(lang, 'admNoDepartment')}</option>
      {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );
}

/** Shows the temporary password once. The secret lives only in the parent's reducer state while this is mounted. */
function TempPasswordDialog({ email, password, onDone }: { email: string; password: string; onDone: () => void }) {
  const { lang } = useAdmin();
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (insecure context / denied): select the text so Ctrl+C works.
      field.current?.focus();
      field.current?.select();
    }
  };
  return (
    <Modal title={t(lang, 'admTempPwTitle')} onClose={onDone}>
      <p className="muted">{email}</p>
      <div className="warn" role="alert">{t(lang, 'admTempPwWarn')}</div>
      <div className="row">
        <input ref={field} readOnly aria-label={t(lang, 'admTempPwTitle')} value={password} className="code pw" autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={() => void copy()}>{t(lang, 'admTempPwCopy')}</button>
      </div>
      <Status text={copied ? t(lang, 'admCopied') : ''} />
      <div className="modal-actions">
        <button type="button" className="primary" onClick={onDone}>{t(lang, 'admTempPwDone')}</button>
      </div>
    </Modal>
  );
}

function CreateDialog({ depts, onClose, onCreated }: { depts: Department[]; onClose: () => void; onCreated: (u: AdminUser, pw: string) => void }) {
  const { client, lang, report } = useAdmin();
  const [f, setF] = useState({ email: '', firstName: '', lastName: '', role: 'member' as Role, departmentId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await client.createUser({
        email: f.email.trim(),
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        role: f.role,
        ...(f.departmentId ? { departmentId: f.departmentId } : {}),
      });
      onCreated(r.user, r.temporaryPassword);
    } catch (x) {
      setErr(t(lang, report(x, { conflict: 'admErrConflictUser' })));
      setBusy(false);
    }
  };
  return (
    <Modal title={t(lang, 'admCreateUser')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form">
        <label>{t(lang, 'admEmail')}
          <input type="email" required maxLength={254} autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label>{t(lang, 'admFirstName')}
          <input required maxLength={100} autoComplete="off" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} />
        </label>
        <label>{t(lang, 'admLastName')}
          <input required maxLength={100} autoComplete="off" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} />
        </label>
        <label>{t(lang, 'admRole')}
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            <option value="member">{roleLabel(lang, 'member')}</option>
            <option value="org_admin">{roleLabel(lang, 'org_admin')}</option>
          </select>
        </label>
        <label>{t(lang, 'admDepartment')}
          <DeptSelect id="cu-dept" value={f.departmentId} onChange={(v) => setF({ ...f, departmentId: v })} depts={depts} />
        </label>
        <ErrorBox text={err} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t(lang, 'cancel')}</button>
          <button type="submit" className="primary" disabled={busy}>{t(lang, 'create')}</button>
        </div>
      </form>
    </Modal>
  );
}

function EditDialog({ user, depts, onClose, onSaved }: { user: AdminUser; depts: Department[]; onClose: () => void; onSaved: (u: AdminUser) => void }) {
  const { client, lang, report } = useAdmin();
  const [role, setRole] = useState<Role>(user.role);
  const [dept, setDept] = useState(user.department?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const patch: { role?: Role; departmentId?: string | null } = {};
    if (role !== user.role) patch.role = role;
    if (dept !== (user.department?.id ?? '')) patch.departmentId = dept || null;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      onSaved(await client.updateUser(user.id, patch));
    } catch (x) {
      setErr(t(lang, report(x)));
      setBusy(false);
    }
  };
  return (
    <Modal title={`${t(lang, 'admEdit')}: ${user.email}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form">
        <label>{t(lang, 'admRole')}
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">{roleLabel(lang, 'member')}</option>
            <option value="org_admin">{roleLabel(lang, 'org_admin')}</option>
          </select>
        </label>
        <label>{t(lang, 'admDepartment')}
          <DeptSelect id="eu-dept" value={dept} onChange={setDept} depts={depts} />
        </label>
        <ErrorBox text={err} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t(lang, 'cancel')}</button>
          <button type="submit" className="primary" disabled={busy}>{t(lang, 'admSave')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Users() {
  const { client, lang, report } = useAdmin();
  const [state, setState] = useState<PagedState<AdminUser>>({ items: [], next: null });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [depts, setDepts] = useState<Department[]>([]);
  const [flow, dispatch] = useReducer(createFlowReducer, { phase: 'closed' });
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [toggling, setToggling] = useState<AdminUser | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleErr, setToggleErr] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (q: string, cursor: string | null) => {
      const id = ++reqId.current;
      setLoading(true);
      setErr(null);
      try {
        const page = await client.listUsers({ search: q, limit: PAGE, cursor });
        if (id !== reqId.current) return; // a newer search superseded this one
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

  useEffect(() => {
    client.listDepartments().then(setDepts).catch(() => setDepts([]));
  }, [client]);

  const name = (u: AdminUser) => u.displayName || u.email;
  const replaceUser = (u: AdminUser) => setState((s) => ({ ...s, items: s.items.map((x) => (x.id === u.id ? u : x)) }));

  const confirmToggle = async () => {
    if (!toggling) return;
    setToggleBusy(true);
    setToggleErr(null);
    try {
      const u = await client.updateUser(toggling.id, { disabled: !toggling.disabled });
      replaceUser(u);
      setNotice(tf(lang, 'admUserUpdated', { name: name(u) }));
      setToggling(null);
    } catch (e) {
      setToggleErr(t(lang, report(e)));
    } finally {
      setToggleBusy(false);
    }
  };

  return (
    <section aria-labelledby="sec-users">
      <h2 id="sec-users" className="sec-title">{t(lang, 'admUsers')}</h2>
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
          <button type="submit">{t(lang, 'admSearch')}</button>
        </form>
        <button className="primary" onClick={() => dispatch({ type: 'open' })}>{t(lang, 'admCreateUser')}</button>
      </div>
      <Status text={notice} />
      <ErrorBox text={err} />

      <TableWrap label={t(lang, 'admTableScroll')}>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">{t(lang, 'admEmail')}</th>
              <th scope="col">{t(lang, 'admName')}</th>
              <th scope="col">{t(lang, 'admRole')}</th>
              <th scope="col">{t(lang, 'admDepartment')}</th>
              <th scope="col">{t(lang, 'admStatus')}</th>
              <th scope="col">{t(lang, 'admActions')}</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((u) => (
              <tr key={u.id} className={u.disabled ? 'is-disabled' : undefined}>
                <td>{u.email}</td>
                <td>{u.displayName}</td>
                <td>{roleLabel(lang, u.role)}</td>
                <td>{u.department?.name ?? <span className="muted">{t(lang, 'admNoDepartment')}</span>}</td>
                <td>{u.disabled ? t(lang, 'admDisabled') : t(lang, 'admActive')}</td>
                <td className="actions">
                  <button onClick={() => setEditing(u)} aria-label={`${t(lang, 'admEdit')}: ${u.email}`}>{t(lang, 'admEdit')}</button>
                  <button onClick={() => { setToggleErr(null); setToggling(u); }} aria-label={`${t(lang, u.disabled ? 'admEnable' : 'admDisable')}: ${u.email}`}>
                    {t(lang, u.disabled ? 'admEnable' : 'admDisable')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {loading && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {!loading && !err && state.items.length === 0 && <p className="muted">{t(lang, 'admNoItems')}</p>}
      {state.next && !loading && <button onClick={() => void load(search, state.next)}>{t(lang, 'admLoadMore')}</button>}

      {flow.phase === 'form' && (
        <CreateDialog
          depts={depts}
          onClose={() => dispatch({ type: 'dismiss' })}
          onCreated={(u, pw) => {
            dispatch({ type: 'created', email: u.email, temporaryPassword: pw });
            setState((s) => ({ ...s, items: [u, ...s.items.filter((x) => x.id !== u.id)] }));
            setNotice(tf(lang, 'admUserCreated', { name: name(u) }));
          }}
        />
      )}
      {flow.phase === 'shown' && <TempPasswordDialog email={flow.email} password={flow.temporaryPassword} onDone={() => dispatch({ type: 'dismiss' })} />}
      {editing && (
        <EditDialog
          user={editing}
          depts={depts}
          onClose={() => setEditing(null)}
          onSaved={(u) => {
            replaceUser(u);
            setNotice(tf(lang, 'admUserUpdated', { name: name(u) }));
            setEditing(null);
          }}
        />
      )}
      {toggling && (
        <ConfirmDialog
          title={t(lang, toggling.disabled ? 'admEnable' : 'admDisable')}
          message={tf(lang, toggling.disabled ? 'admConfirmEnable' : 'admConfirmDisable', { name: toggling.email })}
          confirmLabel={t(lang, 'admConfirm')}
          danger={!toggling.disabled}
          busy={toggleBusy}
          error={toggleErr}
          onConfirm={() => void confirmToggle()}
          onCancel={() => setToggling(null)}
        />
      )}
    </section>
  );
}
