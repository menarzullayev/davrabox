import { useState } from 'react';
import type { Key, Lang } from '../i18n';
import { t } from '../i18n';
import type { OnboardingStepId, OnboardingView } from '../api';
import { Alert, Button, IconCamera, IconCheck, IconMail, IconPlus, IconShield, IconUsers, IconX } from '../ui';
import { tx } from './text';

const STEP: Record<OnboardingStepId, { title: Key; text: Key; action: Key; icon: typeof IconCamera }> = {
  devices: { title: 'obDevicesT', text: 'obDevicesD', action: 'obDevicesA', icon: IconCamera },
  invite: { title: 'obInviteT', text: 'obInviteD', action: 'obInviteA', icon: IconUsers },
  meeting: { title: 'obMeetingT', text: 'obMeetingD', action: 'obMeetingA', icon: IconPlus },
  guests: { title: 'obGuestsT', text: 'obGuestsD', action: 'obGuestsA', icon: IconShield },
  email: { title: 'obEmailT', text: 'obEmailD', action: 'obEmailA', icon: IconMail },
};

/** Where a step's action goes: a link (administration sections) or an in-app action. */
export const STEP_LINK: Partial<Record<OnboardingStepId, string>> = { invite: '/admin#users', guests: '/admin#policies' };

export interface GetStartedProps {
  lang: Lang;
  view: OnboardingView;
  onTestDevices: () => void;
  onNewMeeting: () => void;
  /** Sends (again) the verification link; resolves when the API accepted it. */
  onSendVerification: () => Promise<void>;
  onDismiss: () => void;
}

/**
 * The "Get started" card on the home screen (owner decision 5): five short steps for an administrator (three for a member),
 * each ticking itself from what really happened. Optional and dismissable; it disappears for good once closed or finished.
 */
export function GetStarted({ lang, view, onTestDevices, onNewMeeting, onSendVerification, onDismiss }: GetStartedProps) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<'ok' | 'fail' | null>(null);
  const done = view.steps.filter((s) => s.done).length;
  const total = view.steps.length;

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      await onSendVerification();
      setSent('ok');
    } catch {
      setSent('fail');
    } finally {
      setSending(false);
    }
  };

  const action = (id: OnboardingStepId) => {
    const meta = STEP[id];
    const href = STEP_LINK[id];
    if (href) {
      return (
        <a className="dx-btn hm-gs__btn" data-variant="secondary" data-size="sm" href={href} data-testid={`gs-action-${id}`}>
          <span className="dx-btn__label">{tx(lang, meta.action)}</span>
        </a>
      );
    }
    if (id === 'email' && !view.canSendVerification) return null;
    return (
      <Button
        variant="secondary"
        size="sm"
        className="hm-gs__btn"
        loading={id === 'email' && sending}
        data-testid={`gs-action-${id}`}
        onClick={id === 'devices' ? onTestDevices : id === 'meeting' ? onNewMeeting : () => void send()}
      >
        {tx(lang, meta.action)}
      </Button>
    );
  };

  return (
    <section className="hm-card hm-gs" aria-labelledby="hm-gs-h" data-testid="get-started">
      <div className="hm-gs__head">
        <div>
          <h2 className="hm-card__title" id="hm-gs-h">
            {tx(lang, 'obTitle')}
          </h2>
          <p className="hm-card__lead hm-gs__progress" data-testid="gs-progress">
            {tx(lang, 'obProgress', { done, total })}
          </p>
        </div>
        <Button variant="ghost" size="sm" icon={<IconX size={18} />} onClick={onDismiss} aria-label={tx(lang, 'obDismiss')} title={tx(lang, 'obDismiss')} data-testid="gs-dismiss" />
      </div>
      <div className="hm-gs__bar" role="progressbar" aria-label={tx(lang, 'obTitle')} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ inlineSize: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <ol className="hm-gs__list">
        {view.steps.map((s) => {
          const meta = STEP[s.id];
          const Icon = meta.icon;
          return (
            <li key={s.id} className="hm-gs__step" data-done={s.done ? '' : undefined} data-testid={`gs-step-${s.id}`}>
              <span className="hm-gs__mark" aria-hidden="true">
                {s.done ? <IconCheck size={16} /> : <Icon size={16} />}
              </span>
              <span className="hm-gs__body">
                <span className="hm-gs__title">
                  {tx(lang, meta.title)}
                  <span className="dx-sr-only">{s.done ? ` (${tx(lang, 'obDone')})` : ''}</span>
                </span>
                {!s.done ? <span className="hm-gs__text">{tx(lang, meta.text)}</span> : null}
              </span>
              {!s.done ? action(s.id) : null}
            </li>
          );
        })}
      </ol>
      {sent ? (
        <div role="status" data-testid="gs-sent">
          <Alert tone={sent === 'ok' ? 'success' : 'danger'}>{tx(lang, sent === 'ok' ? 'obEmailSent' : 'obEmailFail')}</Alert>
        </div>
      ) : null}
    </section>
  );
}

export interface VerifyReminderProps {
  lang: Lang;
  email: string;
  canSend: boolean;
  onSend: () => Promise<void>;
  onDismiss: () => void;
}

/** The unverified-email reminder (decision 2): nothing is blocked, the person is only reminded and offered the link again. */
export function VerifyReminder({ lang, email, canSend, onSend, onDismiss }: VerifyReminderProps) {
  const [state, setState] = useState<'idle' | 'sending' | 'ok' | 'fail'>('idle');
  const send = async () => {
    setState('sending');
    try {
      await onSend();
      setState('ok');
    } catch {
      setState('fail');
    }
  };
  return (
    <div data-testid="verify-reminder">
      <Alert tone={state === 'fail' ? 'danger' : 'info'} className="hm-error" onDismiss={onDismiss} dismissLabel={t(lang, 'uiDismiss')}>
        <span className="hm-verify">
          <span>{state === 'ok' ? tx(lang, 'obEmailSentTo', { email }) : state === 'fail' ? tx(lang, 'obEmailFail') : tx(lang, 'obVerifyReminder', { email })}</span>
          {canSend && state !== 'ok' ? (
            <Button variant="ghost" size="sm" loading={state === 'sending'} onClick={() => void send()} data-testid="verify-send">
              {tx(lang, 'obEmailA')}
            </Button>
          ) : null}
        </span>
      </Alert>
    </div>
  );
}
