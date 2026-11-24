import { Button, TextField } from '../ui';
import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import type { Department } from './client';
import { ConfirmDialog, ErrorBox, Modal, Status, TableWrap, tf, useAdmin } from './ui';

function RenameDialog({ dept, onClose, onSaved }: { dept: Department; onClose: () => void; onSaved: (d: Department) => void }) {
  const { client, lang, report } = useAdmin();
  const [name, setName] = useState(dept.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === dept.name) {
      onClose();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      onSaved(await client.renameDepartment(dept.id, n));
    } catch (x) {
      setErr(t(lang, report(x)));
      setBusy(false);
    }
  };
  return (
    <Modal title={`${t(lang, 'admDeptRename')}: ${dept.name}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="form">
        <TextField label={t(lang, 'admDeptName')} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <ErrorBox text={err} />
        <div className="modal-actions">
          <Button type="button" onClick={onClose}>{t(lang, 'cancel')}</Button>
          <Button type="submit" className="primary" variant="primary" disabled={busy}>{t(lang, 'admSave')}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function Departments() {
  const { client, lang, report } = useAdmin();
  const [items, setItems] = useState<Department[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Department | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setItems(await client.listDepartments());
    } catch (e) {
      setErr(t(lang, report(e)));
    }
  }, [client, lang, report]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = newName.trim();
    if (!n) return;
    setCreating(true);
    setErr(null);
    try {
      const d = await client.createDepartment(n);
      setItems((s) => [...(s ?? []), d]);
      setNewName('');
      setNotice(tf(lang, 'admDeptCreated', { name: d.name }));
    } catch (x) {
      setErr(t(lang, report(x, { conflict: 'admErrConflict' })));
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDelBusy(true);
    setDelErr(null);
    try {
      await client.deleteDepartment(deleting.id);
      setItems((s) => (s ?? []).filter((d) => d.id !== deleting.id));
      setNotice(tf(lang, 'admDeptDeleted', { name: deleting.name }));
      setDeleting(null);
    } catch (x) {
      setDelErr(t(lang, report(x, { conflict: 'admErrDeptHasUsers' })));
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <section aria-labelledby="sec-depts">
      <h2 id="sec-depts" className="sec-title">{t(lang, 'admDepartments')}</h2>
      <form onSubmit={(e) => void create(e)} className="row toolbar">
        <input required maxLength={100} aria-label={t(lang, 'admDeptName')} placeholder={t(lang, 'admDeptName')} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Button type="submit" className="primary" variant="primary" disabled={creating}>{t(lang, 'admDeptCreate')}</Button>
      </form>
      <Status text={notice} />
      <ErrorBox text={err} />
      {items === null && !err && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {items !== null && items.length === 0 && <p className="muted">{t(lang, 'admNoItems')}</p>}
      {items !== null && items.length > 0 && (
        <TableWrap label={t(lang, 'admTableScroll')}>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'admDeptName')}</th>
                <th scope="col">{t(lang, 'admDeptUsers')}</th>
                <th scope="col">{t(lang, 'admActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{d.userCount}</td>
                  <td className="actions">
                    <Button onClick={() => setRenaming(d)} aria-label={`${t(lang, 'admDeptRename')}: ${d.name}`}>{t(lang, 'admDeptRename')}</Button>
                    <Button onClick={() => { setDelErr(null); setDeleting(d); }} aria-label={`${t(lang, 'admDeptDelete')}: ${d.name}`}>{t(lang, 'admDeptDelete')}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {renaming && (
        <RenameDialog
          dept={renaming}
          onClose={() => setRenaming(null)}
          onSaved={(d) => {
            setItems((s) => (s ?? []).map((x) => (x.id === d.id ? d : x)));
            setNotice(tf(lang, 'admDeptRenamed', { name: d.name }));
            setRenaming(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t(lang, 'admDeptDelete')}
          message={tf(lang, 'admDeptConfirmDelete', { name: deleting.name })}
          confirmLabel={t(lang, 'admDeptDelete')}
          danger
          busy={delBusy}
          error={delErr}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
