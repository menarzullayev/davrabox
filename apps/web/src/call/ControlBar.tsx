import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t, type Lang } from '../i18n';
import { REACTIONS, type Reaction } from '../signals';
import {
  Button,
  Popover,
  Switch,
  Tooltip,
  IconBlur,
  IconCamera,
  IconChevronDown,
  IconCameraOff,
  IconChat,
  IconHand,
  IconLayoutGrid,
  IconLayoutRing,
  IconLayoutSpeaker,
  IconMic,
  IconMicOff,
  IconMore,
  IconNoise,
  IconImage,
  IconPip,
  IconPoll,
  IconQuestion,
  IconSun,
  IconWhiteboard,
  IconPhoneOff,
  IconScreenShare,
  IconShield,
  IconSmile,
  IconUsers,
} from '../ui';
import { AppearanceFields } from '../home/AppearanceFields';
import { GuestModeSelect } from '../home/GuestModeSelect';
import type { GuestMode } from '../api';
import { hintKey, type FallbackReason, type LayoutMode } from './layout';
import { applyRoving, handleRovingKey } from './roving';
import { IconRecord, RecordingList } from './RecordingBadge';
import type { PanelId, RecordingView } from './types';

export function useMedia(query: string, initial = false): boolean {
  const [m, setM] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : initial));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

export interface ControlBarProps {
  lang: Lang;
  mic: boolean;
  cam: boolean;
  sharing: boolean;
  canShare: boolean;
  handUp: boolean;
  panel: PanelId;
  unread: number;
  /** Pending join requests (managers): shown on the People button. */
  waiting: number;
  layout: LayoutMode;
  fallback: FallbackReason;
  noiseOn: boolean | null;
  blurOn: boolean;
  relay: boolean;
  onMic(): void;
  onCam(): void;
  onShare(): void;
  onHand(): void;
  onReact(e: Reaction): void;
  onPanel(id: PanelId): void;
  onLayout(m: LayoutMode): void;
  onNoise(): void;
  onBlur(): void;
  /** Called when the More panel opens, so the noise state can be re-read from the live microphone. */
  onMoreOpen(): void;
  onLeave(): void;
  /** Recording: the consent state for everyone; `onToggle` is present only for the host or a co-host. */
  recording?: RecordingView;
  /** Host side: who may join without an account; absent for members and guests or when the organization allows no guests. */
  guests?: GuestsControl;
  /** Opens the virtual background chooser. */
  onBackground?(): void;
  /** Low-light correction of the local camera. */
  lowLightOn?: boolean;
  onLowLight?(): void;
  /** Picture-in-picture: present only when the browser supports it. */
  pip?: { active: boolean; onToggle(): void };
  /** Polls, Q&A and the whiteboard: panel toggles with an unseen-count badge. */
  activities?: ActivitiesControl;
}

export interface ActivitiesControl {
  polls: number;
  qa: number;
  board: boolean;
}

export interface GuestsControl {
  value: GuestMode;
  max: GuestMode;
  onChange(m: GuestMode): void;
}

interface CtlProps {
  /** The action as a short phrase. It is the button's visible text on wide screens (or visually hidden), so the accessible name always contains the visible text. */
  label: string;
  icon: ReactNode;
  showText: boolean;
  pressed?: boolean;
  off?: boolean;
  danger?: boolean;
  badge?: number;
  disabled?: boolean;
  /** Unavailable but still focusable and readable (the reason is part of the label); activating it does nothing. */
  softDisabled?: boolean;
  testId?: string;
  haspopup?: boolean;
  expanded?: boolean;
  onClick?: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  extra?: string;
  /** A small decorative mark on the icon (the More button shows the current view on narrow screens). */
  corner?: ReactNode;
}

/** One control bar button: icon, optional visible text, 44 px minimum target, part of the toolbar's roving tabindex. */
function Ctl({ label, icon, showText, pressed, off, danger, badge, disabled, softDisabled, testId, haspopup, expanded, onClick, buttonRef, extra, corner }: CtlProps) {
  const btn = (
    <Button
      ref={buttonRef}
      variant={danger ? 'danger' : 'secondary'}
      className="dv-ctl"
      data-roving=""
      data-off={off ? '' : undefined}
      data-active={pressed ? '' : undefined}
      aria-pressed={pressed}
      aria-haspopup={haspopup ? 'true' : undefined}
      aria-expanded={haspopup ? !!expanded : undefined}
      disabled={disabled}
      aria-disabled={softDisabled || undefined}
      data-testid={testId}
      onClick={onClick}
    >
      <span className="dv-ctl__icon">
        {icon}
        {badge ? <span className="dv-ctl__badge" aria-hidden="true">{badge > 9 ? '9+' : badge}</span> : null}
        {corner}
      </span>
      <span className={`dv-ctl__text${showText ? '' : ' dx-sr-only'}`}>
        {label}
        {badge ? <span className="dx-sr-only"> ({badge})</span> : null}
        {extra ? <span className="dx-sr-only">{extra}</span> : null}
      </span>
    </Button>
  );
  return showText ? btn : <Tooltip content={`${label}${extra ?? ''}`}>{btn}</Tooltip>;
}

function useFocusFirst(open: boolean, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return undefined;
    // A radio group is entered at its checked radio (the same stop Tab would use), not at the first one.
    const raf = requestAnimationFrame(() => (ref.current?.querySelector<HTMLElement>('input[type=radio]:checked:not(:disabled)') ?? ref.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)'))?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, ref]);
}

const MODES: Array<{ id: LayoutMode; key: 'clLayoutDavra' | 'clLayoutGrid' | 'clLayoutSpeaker'; Icon: typeof IconLayoutRing }> = [
  { id: 'davra', key: 'clLayoutDavra', Icon: IconLayoutRing },
  { id: 'gallery', key: 'clLayoutGrid', Icon: IconLayoutGrid },
  { id: 'speaker', key: 'clLayoutSpeaker', Icon: IconLayoutSpeaker },
];

/** Three-way segmented control built from native radios: arrow keys, focus and the group name come for free. */
export function LayoutSwitch({ lang, value, onChange, name }: { lang: Lang; value: LayoutMode; onChange(m: LayoutMode): void; name: string }) {
  return (
    <div className="dv-seg" role="radiogroup" aria-label={t(lang, 'clLayout')}>
      {MODES.map(({ id, key, Icon }) => (
        <label className="dv-seg__opt" key={id} data-testid={`layout-${id}`} title={id === 'davra' ? t(lang, 'clLayoutDavraHint') : undefined}>
          <input type="radio" name={name} value={id} checked={value === id} onChange={() => onChange(id)} className="dv-seg__input" />
          <span className="dv-seg__face">
            <Icon size={20} />
            <span>{t(lang, key)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** The host's record button. In an E2EE meeting it stays focusable and says why it does nothing. */
function RecordCtl({ p, showText }: { p: ControlBarProps; showText: boolean }) {
  const r = p.recording!;
  return (
    <Ctl
      label={r.on ? t(p.lang, 'clRecStop') : t(p.lang, 'clRecStart')}
      extra={r.e2ee ? `, ${t(p.lang, 'clRecE2ee')}` : undefined}
      icon={<IconRecord />}
      showText={showText}
      pressed={r.on}
      softDisabled={r.e2ee || r.busy}
      onClick={() => r.onToggle?.()}
      testId="record"
    />
  );
}

export function ControlBar(p: ControlBarProps) {
  const { lang } = p;
  const root = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLElement | null>(null);
  const wide = useMedia('(min-width: 1180px)');
  const compact = useMedia('(max-width: 559px)');

  // Roving tabindex: re-applied after every render because buttons come and go (disabled, compact mode).
  useLayoutEffect(() => {
    if (root.current) active.current = applyRoving(root.current, active.current);
  });

  const [open, setOpen] = useState<'react' | 'layout' | 'more' | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const reactBtn = useRef<HTMLButtonElement>(null);
  const layoutBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const reactBox = useRef<HTMLDivElement>(null);
  const layoutBox = useRef<HTMLDivElement>(null);
  const moreBox = useRef<HTMLDivElement>(null);
  useFocusFirst(open === 'react', reactBox);
  useFocusFirst(open === 'layout', layoutBox);
  useFocusFirst(open === 'more', moreBox);
  const toggle = (id: 'react' | 'layout' | 'more') => {
    setOpen((o) => (o === id ? null : id));
    if (id === 'more' && open !== 'more') p.onMoreOpen();
  };

  const layoutIcon = MODES.find((m) => m.id === p.layout)!.Icon;
  const LayoutIcon = layoutIcon;
  const layoutName = t(lang, MODES.find((m) => m.id === p.layout)!.key);

  return (
    <section className="dv-controls" aria-label={t(lang, 'clControls')}>
      <div
        ref={root}
        className="controls dv-toolbar"
        role="toolbar"
        aria-label={t(lang, 'clControls')}
        aria-orientation="horizontal"
        onFocusCapture={(e) => {
          const el = e.target as HTMLElement;
          if (el.hasAttribute('data-roving') && root.current) active.current = applyRoving(root.current, el);
        }}
        onKeyDown={(e) => {
          if (root.current) handleRovingKey(root.current, e);
        }}
      >
        <Ctl label={t(lang, 'mic')} extra={`, ${t(lang, p.mic ? 'clActOff' : 'clActOn')}`} icon={p.mic ? <IconMic /> : <IconMicOff />} showText={wide} off={!p.mic} onClick={p.onMic} testId="mic" />
        <Ctl label={t(lang, 'camera')} extra={`, ${t(lang, p.cam ? 'clActOff' : 'clActOn')}`} icon={p.cam ? <IconCamera /> : <IconCameraOff />} showText={wide} off={!p.cam} onClick={p.onCam} testId="cam" />
        {!compact && p.canShare ? (
          <Ctl label={p.sharing ? t(lang, 'stopShare') : t(lang, 'share')} icon={<IconScreenShare />} showText={wide} pressed={p.sharing} onClick={p.onShare} testId="share" />
        ) : null}
        <span className="dv-sep" aria-hidden="true" />
        <Ctl label={p.handUp ? t(lang, 'lowerHand') : t(lang, 'raiseHand')} icon={<IconHand />} showText={wide} pressed={p.handUp} onClick={p.onHand} testId="hand" />
        <Ctl label={t(lang, 'clReact')} icon={<IconSmile />} showText={wide} haspopup expanded={open === 'react'} onClick={() => toggle('react')} buttonRef={reactBtn} testId="reactions" />
        <Ctl label={t(lang, 'chat')} icon={<IconChat />} showText={wide} pressed={p.panel === 'chat'} badge={p.unread} onClick={() => p.onPanel(p.panel === 'chat' ? null : 'chat')} testId="chat-toggle" />
        {!compact ? (
          <Ctl label={t(lang, 'clPeopleTitle')} icon={<IconUsers />} showText={wide} pressed={p.panel === 'people'} badge={p.waiting} onClick={() => p.onPanel(p.panel === 'people' ? null : 'people')} testId="people-toggle" />
        ) : null}
        {!compact ? (
          <Ctl label={layoutName} extra={`, ${t(lang, 'clLayout')}`} icon={<LayoutIcon />} showText={wide} haspopup expanded={open === 'layout'} onClick={() => toggle('layout')} buttonRef={layoutBtn} testId="layout" />
        ) : null}
        {!compact && p.recording?.onToggle ? <RecordCtl p={p} showText={wide} /> : null}
        <Ctl
          label={t(lang, 'clMore')}
          extra={`, ${t(lang, 'clMoreTitle')}${compact ? `, ${t(lang, 'clLayout')}: ${layoutName}` : ''}`}
          icon={<IconMore />}
          corner={compact ? <span className="dv-ctl__mode" data-testid="more-mode" aria-hidden="true"><LayoutIcon size={12} /></span> : undefined}
          showText={wide}
          haspopup expanded={open === 'more'} onClick={() => toggle('more')} buttonRef={moreBtn} testId="more" />
        <span className="dv-sep" aria-hidden="true" />
        <Ctl label={t(lang, 'leave')} icon={<IconPhoneOff />} showText={wide} danger onClick={p.onLeave} testId="leave" />
      </div>

      <Popover open={open === 'react'} anchorRef={reactBtn} onClose={close} role="group" aria-label={t(lang, 'reactions')}>
        <div ref={reactBox} className="dv-reactions" data-testid="reaction-bar">
          {REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              className="dv-emoji"
              aria-label={e}
              data-testid={`react-${e}`}
              onClick={() => {
                p.onReact(e);
                close();
                reactBtn.current?.focus();
              }}
              onKeyDown={(ev) => {
                const list = Array.from(reactBox.current?.querySelectorAll<HTMLElement>('button') ?? []);
                const i = list.indexOf(ev.currentTarget);
                const n = ev.key === 'ArrowRight' ? (i + 1) % list.length : ev.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length : ev.key === 'Home' ? 0 : ev.key === 'End' ? list.length - 1 : -1;
                if (n >= 0) {
                  ev.preventDefault();
                  list[n]!.focus();
                }
              }}
            >
              {e}
            </button>
          ))}
        </div>
      </Popover>

      <Popover open={open === 'layout'} anchorRef={layoutBtn} onClose={close} role="group" aria-label={t(lang, 'clLayout')}>
        <div ref={layoutBox} className="dv-pop">
          <LayoutSwitch lang={lang} value={p.layout} onChange={(m) => p.onLayout(m)} name="dv-layout" />
          <p className="dv-pop__note">{t(lang, 'clLayoutDavraHint')}</p>
          {p.fallback ? <p className="dv-pop__note">{t(lang, hintKey(p.fallback))}</p> : null}
        </div>
      </Popover>

      <Popover open={open === 'more'} anchorRef={moreBtn} onClose={close} align="end" role="group" aria-label={t(lang, 'clMoreTitle')}>
        <div ref={moreBox} className="dv-pop dv-more">
          {compact && p.canShare ? (
            <Button variant="secondary" icon={<IconScreenShare size={18} />} fullWidth data-testid="share" aria-pressed={p.sharing} onClick={() => { p.onShare(); close(); }}>
              {p.sharing ? t(lang, 'stopShare') : t(lang, 'share')}
            </Button>
          ) : null}
          {compact ? (
            <Button variant="secondary" icon={<IconUsers size={18} />} fullWidth data-testid="people-toggle" aria-pressed={p.panel === 'people'} onClick={() => { p.onPanel(p.panel === 'people' ? null : 'people'); close(); }}>
              {t(lang, 'clPeopleTitle')}
              {p.waiting ? ` (${p.waiting})` : ''}
            </Button>
          ) : null}
          {compact && p.recording?.onToggle ? (
            <Button
              variant="secondary"
              icon={<IconRecord size={18} />}
              fullWidth
              data-testid="record"
              aria-pressed={p.recording.on}
              aria-disabled={p.recording.e2ee || p.recording.busy || undefined}
              onClick={() => p.recording?.onToggle?.()}
            >
              {p.recording.on ? t(lang, 'clRecStop') : t(lang, 'clRecStart')}
              {p.recording.e2ee ? <span className="dx-sr-only">, {t(lang, 'clRecE2ee')}</span> : null}
            </Button>
          ) : null}
          {compact ? <LayoutSwitch lang={lang} value={p.layout} onChange={(m) => p.onLayout(m)} name="dv-layout-m" /> : null}
          {compact && p.fallback ? <p className="dv-pop__note">{t(lang, hintKey(p.fallback))}</p> : null}
          {p.recording?.onToggle ? (
            <>
              {p.recording.e2ee ? <p className="dv-pop__note" data-testid="rec-e2ee-note">{t(lang, 'clRecE2ee')}</p> : <p className="dv-pop__note">{t(lang, 'clRecConsentNote')}</p>}
              <RecordingList lang={lang} items={p.recording.items ?? []} onDownload={p.recording.onDownload} />
            </>
          ) : null}
          {p.guests ? <GuestModeSelect lang={lang} value={p.guests.value} max={p.guests.max} onChange={(m) => p.guests?.onChange(m)} testId="more-guests" /> : null}
          <details className="dv-more__appearance" data-testid="more-appearance" onToggle={() => window.dispatchEvent(new Event('resize'))}>
            <summary className="dv-more__appearance-title">
              <span>{t(lang, 'clAppearance')}</span>
              <IconChevronDown size={18} />
            </summary>
            <div className="dv-more__appearance-body">
              <AppearanceFields lang={lang} />
            </div>
          </details>
          {p.activities ? (
            <div className="dv-more__acts">
              <Button variant="secondary" icon={<IconPoll size={18} />} fullWidth data-testid="polls-toggle" aria-pressed={p.panel === 'polls'} onClick={() => { p.onPanel(p.panel === 'polls' ? null : 'polls'); close(); }}>
                {t(lang, 'pollTitle')}
                {p.activities.polls ? <span className="dv-more__count" data-testid="polls-badge">{p.activities.polls}</span> : null}
              </Button>
              <Button variant="secondary" icon={<IconQuestion size={18} />} fullWidth data-testid="qa-toggle" aria-pressed={p.panel === 'qa'} onClick={() => { p.onPanel(p.panel === 'qa' ? null : 'qa'); close(); }}>
                {t(lang, 'qaTitle')}
                {p.activities.qa ? <span className="dv-more__count" data-testid="qa-badge">{p.activities.qa}</span> : null}
              </Button>
              <Button variant="secondary" icon={<IconWhiteboard size={18} />} fullWidth data-testid="board-toggle" aria-pressed={p.panel === 'board'} onClick={() => { p.onPanel(p.panel === 'board' ? null : 'board'); close(); }}>
                {t(lang, 'wbTitle')}
                {p.activities.board ? <span className="dv-more__dot" aria-hidden="true" /> : null}
              </Button>
            </div>
          ) : null}
          {p.onBackground || p.pip ? (
            <div className="dv-more__acts">
              {p.onBackground ? (
                <Button variant="secondary" icon={<IconImage size={18} />} fullWidth data-testid="bg-open" disabled={!p.cam} onClick={() => { close(); p.onBackground?.(); }}>
                  {t(lang, 'fxBackground')}
                </Button>
              ) : null}
              {p.pip ? (
                <Button variant="secondary" icon={<IconPip size={18} />} fullWidth data-testid="pip" aria-pressed={p.pip.active} onClick={() => { close(); p.pip?.onToggle(); }}>
                  {t(lang, 'pip')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="dv-more__switches">
            <Switch
              label={<span className="dv-more__lbl"><IconNoise size={16} />{t(lang, 'noiseSuppression')}</span>}
              checked={p.noiseOn ?? true}
              disabled={!p.mic}
              onChange={p.onNoise}
              data-testid="noise"
              data-state={String(p.noiseOn)}
            />
            <Switch
              label={<span className="dv-more__lbl"><IconBlur size={16} />{t(lang, 'blurBackground')}</span>}
              checked={p.blurOn}
              disabled={!p.cam}
              onChange={p.onBlur}
              data-testid="blur"
              data-state={String(p.blurOn)}
            />
            {p.onLowLight ? (
              <Switch
                label={<span className="dv-more__lbl"><IconSun size={16} />{t(lang, 'fxLowLight')}</span>}
                checked={!!p.lowLightOn}
                disabled={!p.cam}
                onChange={p.onLowLight}
                data-testid="lowlight"
                data-state={String(!!p.lowLightOn)}
              />
            ) : null}
          </div>
          <div className="dv-more__info" data-testid="firewall-info">
            <IconShield size={16} />
            <div>
              <strong>{t(lang, 'relayMode')}: {p.relay ? t(lang, 'clFirewallOn') : t(lang, 'clFirewallOff')}</strong>
              <span>{t(lang, 'clFirewallNote')}</span>
            </div>
          </div>
        </div>
      </Popover>
    </section>
  );
}
