import { Button, Combobox, DateTimePicker, TextField } from '../ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import type { AuditEntry, AuditFilters, ExportFormat } from './client';
import { EMPTY_AUDIT_FORM, formatTimestamp, mergePage, toAuditFilters, type AuditForm, type PagedState } from './helpers';
import { saveBlob } from './download';
import { ErrorBox, TableWrap, tf, useAdmin } from './ui';

const PAGE = 50;
const ACTION_HINTS = ['auth.', 'user.', 'department.', 'policy.', 'meeting.', 'audit.'];
const FORMATS: Array<{ id: ExportFormat; label: string }> = [
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON Lines' },
  { id: 'cef', label: 'CEF' },
];

export function Audit() {
  const { client, lang, report } = useAdmin();
  const [form, setForm] = useState<AuditForm>(EMPTY_AUDIT_FORM);
  const [applied, setApplied] = useState<AuditFilters>({});
  const [state, setState] = useState<PagedState<AuditEntry>>({ items: [], next: null });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const reqId = useRef(0);

  const load = useCallback(
    async (filters: AuditFilters, cursor: string | null) => {
      const id = ++reqId.current;
      setLoading(true);
      setErr(null);
      try {
        const page = await client.listAudit({ ...filters, limit: PAGE, cursor });
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
    void load(applied, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, client]);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const { filters, error } = toAuditFilters(form);
    if (error) {
      setFormErr(t(lang, error));
      return;
    }
    setFormErr(null);
    setVerifyMsg(null);
    setApplied(filters);
  };

  const reset = () => {
    setForm(EMPTY_AUDIT_FORM);
    setFormErr(null);
    setApplied({});
  };

  const doExport = async (format: ExportFormat) => {
    if (menu.current) menu.current.open = false;
    setExporting(true);
    setErr(null);
    setNotice('');
    try {
      const { blob, filename } = await client.exportAudit(format, applied);
      saveBlob(blob, filename);
      setNotice(tf(lang, 'admExported', { name: filename }));
    } catch (e) {
      setErr(t(lang, report(e)));
    } finally {
      setExporting(false);
    }
  };

  const verify = async () => {
    setVerifyBusy(true);
    setVerifyMsg(null);
    setErr(null);
    try {
      const r = await client.verifyAudit();
      setVerifyMsg(
        r.ok
          ? { ok: true, text: tf(lang, 'admVerifyOk', { n: r.checked }) }
          : { ok: false, text: tf(lang, 'admVerifyBroken', { id: r.firstBrokenId ?? '?', n: r.checked }) },
      );
    } catch (e) {
      setErr(t(lang, report(e)));
    } finally {
      setVerifyBusy(false);
    }
  };

  const set = (k: keyof AuditForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <section aria-labelledby="sec-audit">
      <h2 id="sec-audit" className="sec-title">{t(lang, 'admAudit')}</h2>
      <form onSubmit={apply} className="filters" role="search">
        <DateTimePicker label={t(lang, 'admFrom')} lang={lang} value={form.from} onChange={set('from')} />
        <DateTimePicker label={t(lang, 'admTo')} lang={lang} value={form.to} onChange={set('to')} />
        <Combobox label={t(lang, 'admAction')} hint={t(lang, 'admActionHint')} maxLength={100} value={form.action} onChange={set('action')} options={ACTION_HINTS} />
        <TextField label={t(lang, 'admActor')} maxLength={254} value={form.actor} onChange={set('actor')} autoComplete="off" />
        <TextField label={t(lang, 'admTarget')} maxLength={200} value={form.target} onChange={set('target')} autoComplete="off" />
        <div className="row filter-actions">
          <Button type="submit" className="primary" variant="primary">{t(lang, 'admApply')}</Button>
          <Button type="button" onClick={reset}>{t(lang, 'admReset')}</Button>
        </div>
      </form>
      {formErr && <div className="field-error" role="alert">{formErr}</div>}

      <div className="toolbar">
        <details className="menu" ref={menu}>
          <summary aria-disabled={exporting}>{t(lang, 'admExport')}</summary>
          <div className="menu-list" role="group" aria-label={t(lang, 'admExport')}>
            {FORMATS.map((f) => (
              <Button key={f.id} type="button" disabled={exporting} onClick={() => void doExport(f.id)}>{f.label}</Button>
            ))}
          </div>
        </details>
        <Button type="button" onClick={() => void verify()} disabled={verifyBusy}>{verifyBusy ? t(lang, 'admVerifying') : t(lang, 'admVerify')}</Button>
      </div>
      <div className="status-row" role="status" aria-live="polite">
        {verifyMsg && <span className={verifyMsg.ok ? 'ok' : 'bad'}>{verifyMsg.text}</span>}
        {notice && <span>{notice}</span>}
      </div>
      <ErrorBox text={err} />

      <TableWrap label={t(lang, 'admTableScroll')}>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">{t(lang, 'admTime')}</th>
              <th scope="col">{t(lang, 'admActor')}</th>
              <th scope="col">{t(lang, 'admAction')}</th>
              <th scope="col">{t(lang, 'admTarget')}</th>
            </tr>
          </thead>
          <tbody>
            {state.items.map((r) => (
              <tr key={r.id}>
                <td><time dateTime={r.at}>{formatTimestamp(r.at, lang)}</time></td>
                <td>{r.actorEmail ?? (r.actorId ? <span className="code">{r.actorId}</span> : <span className="muted">{t(lang, 'admSystem')}</span>)}</td>
                <td className="code">{r.action}</td>
                <td className="code">{r.target ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {loading && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {!loading && !err && state.items.length === 0 && <p className="muted">{t(lang, 'admNoItems')}</p>}
      {state.next && !loading && <Button onClick={() => void load(applied, state.next)}>{t(lang, 'admLoadMore')}</Button>}
    </section>
  );
}
