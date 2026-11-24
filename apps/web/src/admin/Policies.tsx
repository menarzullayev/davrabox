import { Button, TextField, Checkbox, Select } from '../ui';
import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import type { Policies as PolicyData } from './client';
import { MAX_PARTICIPANTS, MIN_PARTICIPANTS, parseMaxParticipants } from './helpers';
import { ErrorBox, Status, useAdmin } from './ui';

export function Policies() {
  const { client, lang, report } = useAdmin();
  const [form, setForm] = useState<{ requirePasscode: boolean; waitingRoomDefault: boolean; requireTotp: boolean; guestPolicy: PolicyData['guestPolicy']; max: string } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = (p: PolicyData) =>
    setForm({ requirePasscode: p.requirePasscode, waitingRoomDefault: p.waitingRoomDefault, requireTotp: p.requireTotp, guestPolicy: p.guestPolicy, max: String(p.maxParticipants) });

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      apply(await client.getPolicies());
    } catch (e) {
      setLoadErr(t(lang, report(e)));
    }
  }, [client, lang, report]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaved('');
    setSaveErr(null);
    const max = parseMaxParticipants(form.max);
    if (max === null) {
      setFieldErr(t(lang, 'admErrMax'));
      return;
    }
    setFieldErr(null);
    setBusy(true);
    try {
      apply(await client.putPolicies({ requirePasscode: form.requirePasscode, waitingRoomDefault: form.waitingRoomDefault, maxParticipants: max, requireTotp: form.requireTotp, guestPolicy: form.guestPolicy }));
      setSaved(t(lang, 'admPolSaved'));
    } catch (x) {
      setSaveErr(`${t(lang, 'admPolFailed')}: ${t(lang, report(x))}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="sec-policies">
      <h2 id="sec-policies" className="sec-title">{t(lang, 'admPolicies')}</h2>
      <ErrorBox text={loadErr} />
      {loadErr && <Button onClick={() => void load()}>{t(lang, 'admRetry')}</Button>}
      {!form && !loadErr && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {form && (
        <form onSubmit={(e) => void save(e)} className="form narrow" noValidate>
          <Checkbox label={t(lang, 'admPolPasscode')} checked={form.requirePasscode} onChange={(e) => setForm({ ...form, requirePasscode: e.target.checked })} />
          <Checkbox label={t(lang, 'admPolWaiting')} checked={form.waitingRoomDefault} onChange={(e) => setForm({ ...form, waitingRoomDefault: e.target.checked })} />
          <Checkbox label={t(lang, 'admPolTotp')} checked={form.requireTotp} onChange={(e) => setForm({ ...form, requireTotp: e.target.checked })} />
          <Select label={t(lang, 'admPolGuests')} data-testid="guest-policy" value={form.guestPolicy} onChange={(e) => setForm({ ...form, guestPolicy: e.target.value as PolicyData['guestPolicy'] })}>
              <option value="off">{t(lang, 'admPolGuestsOff')}</option>
              <option value="waiting_room">{t(lang, 'admPolGuestsWait')}</option>
              <option value="open">{t(lang, 'admPolGuestsOpen')}</option>
            </Select>
          <TextField label={t(lang, 'admPolMax')}
              inputMode="numeric"
              min={MIN_PARTICIPANTS}
              max={MAX_PARTICIPANTS}
              value={form.max}
              aria-invalid={fieldErr ? true : undefined}
              aria-describedby={fieldErr ? 'max-err' : undefined}
              onChange={(e) => setForm({ ...form, max: e.target.value })} />
          {fieldErr && <div id="max-err" className="field-error" role="alert">{fieldErr}</div>}
          <ErrorBox text={saveErr} />
          <div className="row">
            <Button type="submit" className="primary" variant="primary" disabled={busy}>{busy ? t(lang, 'admSaving') : t(lang, 'admPolSave')}</Button>
          </div>
        </form>
      )}
      <Status text={saved} />
    </section>
  );
}
