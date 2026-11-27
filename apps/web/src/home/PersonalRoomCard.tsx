import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { GuestMode, PersonalRoom, PersonalRoomView } from '../api';
import { t, type Lang } from '../i18n';
import { Alert, Badge, Button, Checkbox, Dialog, IconCopy, IconLock, IconRefresh, IconSettings, IconUnlock, IconUsers, Skeleton, Switch, TextField, useToast } from '../ui';
import { GuestModeSelect } from './GuestModeSelect';
import type { HomeApi } from './homeApi';
import { formatCode } from './logic';
import { copyJoinLink } from './Timeline';
import { tx } from './text';

export interface PersonalRoomCardProps {
  lang: Lang;
  api: Pick<HomeApi, 'personalRoom' | 'ensurePersonalRoom' | 'updatePersonalRoom' | 'regeneratePersonalRoom'>;
  /** The person's name, for the room title shown to the people who join. */
  name: string;
  onJoin: (code: string) => Promise<void>;
}

/**
 * "My personal room" (owner decision 3): a fixed number and link with copy, enter, settings (waiting room, passcode, guests
 * within the organization's policy) and "regenerate link". The server enforces every rule; this card only offers what can be saved.
 */
export function PersonalRoomCard({ lang, api, name, onJoin }: PersonalRoomCardProps) {
  const toast = useToast();
  const [view, setView] = useState<PersonalRoomView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupPass, setSetupPass] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [joining, setJoining] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    api.personalRoom().then(setView, () => setFailed(true));
  }, [api]);
  useEffect(load, [load]);

  const setRoom = (room: PersonalRoom) => setView((v) => (v ? { ...v, room } : v));

  if (failed) {
    return (
      <section className="hm-card hm-pr" aria-labelledby="hm-pr-h" data-testid="personal-room">
        <h2 className="hm-card__title" id="hm-pr-h">
          {tx(lang, 'prTitle')}
        </h2>
        <Alert tone="danger">{t(lang, 'errGeneric')}</Alert>
      </section>
    );
  }
  if (!view) {
    return (
      <section className="hm-card hm-pr" aria-busy="true" data-testid="personal-room">
        <Skeleton height="1.5rem" width="40%" />
        <Skeleton height="2.5rem" width="70%" />
      </section>
    );
  }

  const room = view.room;
  if (!room) {
    const needPass = view.policy.requirePasscode;
    const create = async (e: FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        setRoom(await api.ensurePersonalRoom({ title: tx(lang, 'prNameTemplate', { name: name || t(lang, 'appName') }).slice(0, 200), ...(setupPass ? { passcode: setupPass } : {}) }));
      } catch {
        toast({ tone: 'danger', title: tx(lang, 'prSaveFailed') });
      } finally {
        setBusy(false);
      }
    };
    return (
      <section className="hm-card hm-pr" aria-labelledby="hm-pr-h" data-testid="personal-room">
        <h2 className="hm-card__title" id="hm-pr-h">
          {tx(lang, 'prTitle')}
        </h2>
        <p className="hm-card__lead">{tx(lang, 'prSetupLead')}</p>
        <form className="hm-pr__setup" onSubmit={(e) => void create(e)}>
          {needPass ? (
            <TextField label={t(lang, 'passcode')} type="password" required minLength={6} maxLength={64} autoComplete="new-password" hint={tx(lang, 'prPasscodeRequired')} value={setupPass} onChange={(e) => setSetupPass(e.target.value)} data-testid="pr-setup-passcode" />
          ) : null}
          <Button type="submit" variant="secondary" loading={busy} data-testid="pr-setup">
            {tx(lang, 'prSetup')}
          </Button>
        </form>
      </section>
    );
  }

  const copy = async () => {
    const ok = await copyJoinLink(location.origin, room.code);
    toast(ok ? { tone: 'success', title: tx(lang, 'hLinkCopied') } : { tone: 'danger', title: tx(lang, 'hCopyFailed') });
  };
  const enter = async () => {
    setJoining(true);
    try {
      await onJoin(room.code);
    } finally {
      setJoining(false);
    }
  };
  const regenerate = async () => {
    setBusy(true);
    try {
      const r = await api.regeneratePersonalRoom();
      setRoom(r);
      setConfirmRegen(false);
      toast({ tone: 'success', title: tx(lang, 'prRegenDone', { code: formatCode(r.code) }) });
    } catch {
      toast({ tone: 'danger', title: tx(lang, 'prSaveFailed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="hm-card hm-pr" aria-labelledby="hm-pr-h" data-testid="personal-room">
      <div className="hm-pr__head">
        <div>
          <h2 className="hm-card__title" id="hm-pr-h">
            {tx(lang, 'prTitle')}
          </h2>
          <p className="hm-card__lead">{tx(lang, 'prLead')}</p>
        </div>
        <Button variant="ghost" size="sm" icon={<IconSettings size={18} />} aria-label={tx(lang, 'prEdit')} title={tx(lang, 'prEdit')} data-testid="pr-edit" onClick={() => setEditing(true)} />
      </div>
      <p className="hm-pr__number">
        <span className="hm-pr__label">{tx(lang, 'prNumber')}</span>
        <strong className="dx-tabular" data-testid="pr-code">
          {formatCode(room.code)}
        </strong>
      </p>
      <div className="hm-pr__badges">
        <Badge tone={room.waitingRoom ? 'success' : 'neutral'}>
          <IconUsers size={12} />
          {tx(lang, room.waitingRoom ? 'prWaitingOn' : 'prWaitingOff')}
        </Badge>
        <Badge tone={room.hasPasscode ? 'success' : 'neutral'}>
          {room.hasPasscode ? <IconLock size={12} /> : <IconUnlock size={12} />}
          {tx(lang, room.hasPasscode ? 'prPasscodeOn' : 'prPasscodeOff')}
        </Badge>
      </div>
      <div className="hm-pr__actions">
        <Button variant="primary" loading={joining} data-testid="pr-start" onClick={() => void enter()}>
          {tx(lang, 'prStart')}
        </Button>
        <Button variant="secondary" icon={<IconCopy size={18} />} data-testid="pr-copy" onClick={() => void copy()}>
          {tx(lang, 'prCopy')}
        </Button>
        <Button variant="ghost" icon={<IconRefresh size={18} />} data-testid="pr-regenerate" onClick={() => setConfirmRegen(true)}>
          {tx(lang, 'prRegenerate')}
        </Button>
      </div>

      <Dialog
        open={confirmRegen}
        onClose={() => setConfirmRegen(false)}
        closeLabel={t(lang, 'uiClose')}
        title={tx(lang, 'prRegenTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRegen(false)}>
              {t(lang, 'cancel')}
            </Button>
            <Button variant="danger" loading={busy} data-testid="pr-regenerate-confirm" onClick={() => void regenerate()}>
              {tx(lang, 'prRegenConfirm')}
            </Button>
          </>
        }
      >
        <p className="hm-new__lead">{tx(lang, 'prRegenBody')}</p>
      </Dialog>
      <RoomSettingsDialog lang={lang} open={editing} room={room} policy={view.policy} onClose={() => setEditing(false)} onSave={async (p) => setRoom(await api.updatePersonalRoom(p))} />
    </section>
  );
}

interface RoomSettingsDialogProps {
  lang: Lang;
  open: boolean;
  room: PersonalRoom;
  policy: PersonalRoomView['policy'];
  onClose: () => void;
  onSave: (patch: { passcode?: string | null; waitingRoom?: boolean; guests?: GuestMode }) => Promise<void>;
}

const FORM = 'hm-pr-form';

function RoomSettingsDialog({ lang, open, room, policy, onClose, onSave }: RoomSettingsDialogProps) {
  const toast = useToast();
  const [waiting, setWaiting] = useState(room.waitingRoom);
  const [pass, setPass] = useState('');
  const [remove, setRemove] = useState(false);
  const [guests, setGuests] = useState<GuestMode>(room.guests);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWaiting(room.waitingRoom);
    setPass('');
    setRemove(false);
    setGuests(room.guests);
    setFailed(false);
  }, [open, room]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const patch: { passcode?: string | null; waitingRoom?: boolean; guests?: GuestMode } = {};
    if (waiting !== room.waitingRoom) patch.waitingRoom = waiting;
    if (pass) patch.passcode = pass;
    else if (remove) patch.passcode = null;
    if (policy.guestPolicy !== 'off' && guests !== room.guests) patch.guests = guests;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      await onSave(patch);
      toast({ tone: 'success', title: tx(lang, 'prSaved') });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeLabel={t(lang, 'uiClose')}
      title={tx(lang, 'prEdit')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t(lang, 'cancel')}
          </Button>
          <Button variant="primary" type="submit" form={FORM} loading={busy} data-testid="pr-save">
            {t(lang, 'admSave')}
          </Button>
        </>
      }
    >
      <form id={FORM} className="hm-new__form" onSubmit={(e) => void submit(e)}>
        {failed ? <Alert tone="danger">{tx(lang, 'prSaveFailed')}</Alert> : null}
        <Switch label={tx(lang, 'prWaiting')} hint={tx(lang, 'hNewWaitingHint')} checked={waiting} data-testid="pr-waiting" onChange={(e) => setWaiting(e.target.checked)} />
        <TextField
          label={tx(lang, 'prPasscode')}
          type="password"
          minLength={6}
          maxLength={64}
          autoComplete="new-password"
          hint={policy.requirePasscode ? tx(lang, 'prPasscodeRequired') : room.hasPasscode ? tx(lang, 'prPasscodeKeep') : tx(lang, 'prPasscodeHint')}
          value={pass}
          disabled={remove}
          data-testid="pr-passcode"
          onChange={(e) => setPass(e.target.value)}
        />
        {room.hasPasscode && !policy.requirePasscode ? <Checkbox label={tx(lang, 'prPasscodeRemove')} checked={remove} data-testid="pr-passcode-remove" onChange={(e) => setRemove(e.target.checked)} /> : null}
        {policy.guestPolicy !== 'off' ? (
          <>
            <GuestModeSelect lang={lang} value={guests} max={policy.guestPolicy} onChange={setGuests} />
            <p className="hm-card__lead">{tx(lang, 'prGuestsNote')}</p>
          </>
        ) : null}
      </form>
    </Dialog>
  );
}
