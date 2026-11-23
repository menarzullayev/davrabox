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
  IconPhoneOff,
  IconScreenShare,
  IconShield,
  IconSmile,
  IconUsers,
} from '../ui';
import { hintKey, type FallbackReason, type LayoutMode } from './layout';
import { applyRoving, handleRovingKey } from './roving';
import type { PanelId } from './types';

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
  testId?: string;
  haspopup?: boolean;
  expanded?: boolean;
  onClick?: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  extra?: string;
}

/** One control bar button: icon, optional visible text, 44 px minimum target, part of the toolbar's roving tabindex. */
function Ctl({ label, icon, showText, pressed, off, danger, badge, disabled, testId, haspopup, expanded, onClick, buttonRef, extra }: CtlProps) {
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
      data-testid={testId}
      onClick={onClick}
    >
      <span className="dv-ctl__icon">
        {icon}
        {badge ? <span className="dv-ctl__badge" aria-hidden="true">{badge > 9 ? '9+' : badge}</span> : null}
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

function useFocusFirst(open: boolean, ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return undefined;
    const raf = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus());
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
        <label className="dv-seg__opt" key={id} data-testid={`layout-${id}`}>
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
        <Ctl label={t(lang, 'clMore')} extra={`, ${t(lang, 'clMoreTitle')}`} icon={<IconMore />} showText={wide} haspopup expanded={open === 'more'} onClick={() => toggle('more')} buttonRef={moreBtn} testId="more" />
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
          {compact ? <LayoutSwitch lang={lang} value={p.layout} onChange={(m) => p.onLayout(m)} name="dv-layout-m" /> : null}
          {compact && p.fallback ? <p className="dv-pop__note">{t(lang, hintKey(p.fallback))}</p> : null}
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
