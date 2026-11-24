import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { contrast, nonTextPairs, scales, textPairs, themes, NON_TEXT_MIN, TEXT_MIN, type TokenName } from '@davrabox/design-tokens';
import { Davra } from '../brand/Davra';
import { Logo, LogoMark } from '../brand/Logo';
import { t, type Lang } from '../i18n';
import { usePrefs } from '../prefs';
import * as Icons from '../ui/icons';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardTitle,
  Checkbox,
  ConnectingRing,
  Dialog,
  EmptyState,
  IconButton,
  Kbd,
  Menu,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  TextField,
  ToastProvider,
  Tooltip,
  IconCheck,
  useToast,
  type ThemeChoice,
} from '../ui';
import { sg, type SgKey } from './strings';
import './styleguide.css';

type S = (k: SgKey) => string;

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section className="sg-section" id={id} aria-labelledby={`${id}-h`}>
      <header>
        <h2 className="dx-t-h2" id={`${id}-h`}>
          {title}
        </h2>
        {lead ? <p>{lead}</p> : null}
      </header>
      {children}
    </section>
  );
}
const Sub = ({ children }: { children: ReactNode }) => <h3 className="sg-sub">{children}</h3>;

const kebab = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
const px = (rem: string) => `${Math.round(parseFloat(rem) * 16)}px`;

// ---- colour ---------------------------------------------------------------------------------------------------
const colourGroups: Array<{ title: SgKey; tokens: TokenName[] }> = [
  { title: 'groupSurfaces', tokens: ['bg', 'surface1', 'surface2', 'surface3', 'videoBg'] },
  { title: 'groupText', tokens: ['text', 'textMuted', 'textSubtle', 'textOnVideo'] },
  { title: 'groupAccent', tokens: ['accent', 'accentHover', 'accentActive', 'accentSoft', 'textOnAccent'] },
  { title: 'groupGold', tokens: ['gold', 'goldRing', 'goldFg', 'goldSoft', 'textOnGold'] },
  { title: 'groupStatus', tokens: ['success', 'successSoft', 'warning', 'warningSoft', 'danger', 'dangerHover', 'dangerSoft'] },
  { title: 'groupLines', tokens: ['border', 'borderStrong', 'focusRing', 'inverseBg', 'inverseText'] },
];

function Colours({ theme, s }: { theme: ThemeChoice; s: S }) {
  const c = themes[theme];
  const ratio = (a: TokenName, b: TokenName) => contrast(c[a], c[b]);
  return (
    <>
      {colourGroups.map((g) => (
        <div key={g.title}>
          <Sub>{s(g.title)}</Sub>
          <div className="sg-grid">
            {g.tokens.map((k) => (
              <div className="sg-swatch" key={k}>
                <div className="sg-swatch__chip" style={{ background: c[k] }} />
                <div>
                  <b>--{kebab(k)}</b>
                  <span className="sg-mono">{c[k]}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <Sub>{s('pairsText')} (≥ {TEXT_MIN}:1)</Sub>
      <div className="sg-grid" data-testid="sg-text-pairs">
        {textPairs.map(([fg, bg]) => {
          const r = ratio(fg, bg);
          return (
            <div className="sg-pair" key={`${fg}-${bg}`}>
              <div className="sg-pair__tile" style={{ color: c[fg], background: c[bg] }}>
                Aa
              </div>
              <div>
                <b>
                  {kebab(fg)} / {kebab(bg)}
                </b>
                <span className="sg-mono">
                  {r.toFixed(2)}:1 · {r >= TEXT_MIN ? s('passes') : 'FAIL'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <Sub>{s('pairsControl')} (≥ {NON_TEXT_MIN}:1)</Sub>
      <div className="sg-grid">
        {nonTextPairs.map(([fg, bg]) => {
          const r = ratio(fg, bg);
          return (
            <div className="sg-pair" key={`${fg}-${bg}`}>
              <div className="sg-pair__tile" style={{ background: c[bg] }}>
                <span className="sg-pair__ring" style={{ borderColor: c[fg] }} />
              </div>
              <div>
                <b>
                  {kebab(fg)} / {kebab(bg)}
                </b>
                <span className="sg-mono">
                  {r.toFixed(2)}:1 · {r >= NON_TEXT_MIN ? s('passes') : 'FAIL'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---- type -----------------------------------------------------------------------------------------------------
function TypeSection({ lang, s }: { lang: Lang; s: S }) {
  const sample = lang === 'ru' ? s('sampleCyrillic') : lang === 'en' ? s('sampleLatinEn') : s('sampleLatin');
  return (
    <>
      <p className="sg-glyphs" lang="uz" data-testid="glyph-line">
        O‘ o‘ G‘ g‘ ʻ ʼ ’ ‘ Sh Ch ng
      </p>
      <p className="sg-glyphs" lang="ru" style={{ marginTop: 'var(--space-2)' }}>
        Ў ў Қ қ Ғ ғ Ҳ ҳ Ё Щ Ъ Ы
      </p>
      <Sub>{s('weights')}</Sub>
      <div className="sg-stack">
        {(['regular', 'medium', 'semibold', 'bold'] as const).map((w) => (
          <p key={w} className="dx-t-h4" style={{ fontWeight: `var(--weight-${w})` }}>
            {sample} <span className="sg-mono">{scales.weight[w]}</span>
          </p>
        ))}
      </div>
      <Sub>{s('figures')}</Sub>
      <div className="sg-figures">
        <p>
          <small>{s('figuresProportional')}</small>
          <span style={{ fontVariantNumeric: 'proportional-nums' }}>111 111 111 · 00:11:11</span>
        </p>
        <p>
          <small>{s('figuresTabular')}</small>
          <span className="dx-tabular">111 111 111 · 00:11:11</span>
        </p>
        <p>
          <small>{s('meetingCode')}</small>
          <span className="dx-tabular">482 905 117 · 00:42:17</span>
        </p>
      </div>
      <Sub>{s('scaleRow')}</Sub>
      <div>
        {(Object.entries(scales.text) as Array<[string, readonly [string, string]]>).reverse().map(([name, [size, line]]) => (
          <div className="sg-scale" key={name}>
            <span>
              {name} · {px(size)}/{px(line)}
            </span>
            <div style={{ fontSize: `var(--text-${name})`, lineHeight: `var(--leading-${name})`, fontWeight: name === '4xl' || name === '3xl' ? 700 : name === 'base' || name === 'sm' || name === 'xs' ? 400 : 600 }}>
              {sample}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---- scales ---------------------------------------------------------------------------------------------------
function MotionRow({ n, s }: { n: 1 | 2 | 3 | 4; s: S }) {
  const [on, setOn] = useState(false);
  return (
    <div className="sg-motion">
      <Button size="sm" onClick={() => setOn((v) => !v)}>
        {s('replay')} · {scales.duration[n]}
      </Button>
      <div className="sg-track">
        <span className="sg-dot" data-on={on} style={{ transitionDuration: `var(--dur-${n})` }} />
      </div>
    </div>
  );
}

function ScalesSection({ s }: { s: S }) {
  return (
    <>
      <Sub>{s('spacing')}</Sub>
      <div className="sg-stack" style={{ gap: 'var(--space-2)' }}>
        {Object.entries(scales.space).map(([k, v]) => (
          <div className="sg-space" key={k}>
            <span style={{ width: 84 }}>--space-{k}</span>
            <i style={{ width: v }} />
            <span>{v}</span>
          </div>
        ))}
      </div>
      <Sub>{s('radii')}</Sub>
      <div className="sg-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
        {Object.entries(scales.radius).map(([k, v]) => (
          <div className="sg-box" key={k} style={{ borderRadius: v }}>
            {k} · {v}
          </div>
        ))}
      </div>
      <Sub>{s('elevation')}</Sub>
      <div className="sg-grid">
        {(['shadow-1', 'shadow-2', 'shadow-3', 'glow-gold'] as const).map((k) => (
          <div className="sg-box" key={k} style={{ borderRadius: 'var(--radius-lg)', boxShadow: `var(--${k})`, border: 0 }}>
            --{k}
          </div>
        ))}
      </div>
      <Sub>{s('motion')}</Sub>
      <div className="sg-stack">
        {([1, 2, 3, 4] as const).map((n) => (
          <MotionRow key={n} n={n} s={s} />
        ))}
        <p className="dx-t-caption" style={{ color: 'var(--text-muted)' }}>
          {s('motionHint')} · {Object.entries(scales.ease).map(([k, v]) => `${k}: ${v}`).join(' · ')}
        </p>
        <p className="sg-mono">{Object.entries(scales.z).map(([k, v]) => `z-${k}: ${v}`).join(' · ')}</p>
      </div>
    </>
  );
}

// ---- brand ----------------------------------------------------------------------------------------------------
function BrandSection({ s }: { s: S }) {
  const [rings, setRings] = useState(3);
  const [petals, setPetals] = useState(12);
  const [rotation, setRotation] = useState(0);
  const [animated, setAnimated] = useState(false);
  return (
    <>
      <div className="sg-split">
        <div className="sg-tile sg-tile--dark">
          <img src="/brand/logo.svg" alt="DavraBox" height={44} />
          <span className="dx-t-caption">{s('logoOnDark')}</span>
        </div>
        <div className="sg-tile sg-tile--light">
          <img src="/brand/logo-light.svg" alt="DavraBox" height={44} />
          <span className="dx-t-caption">{s('logoOnLight')}</span>
        </div>
      </div>
      <Sub>{s('markSizes')}</Sub>
      <div className="sg-split">
        <div className="sg-tile sg-tile--dark">
          <div className="sg-marks">
            {[16, 24, 32, 48, 64, 96].map((n) => (
              <img key={n} src="/brand/mark.svg" alt="" width={n} height={n} />
            ))}
          </div>
        </div>
        <div className="sg-tile sg-tile--light">
          <div className="sg-marks">
            {[16, 24, 32, 48, 64, 96].map((n) => (
              <img key={n} src="/brand/mark-light.svg" alt="" width={n} height={n} />
            ))}
          </div>
        </div>
      </div>
      <Sub>{s('favicon')}</Sub>
      <div className="sg-fav">
        {[16, 32, 48].map((n) => (
          <img key={n} src={`/brand/favicon-${n}.png`} alt={`${n} px`} width={n} height={n} />
        ))}
        <img src="/brand/app-icon.svg" alt="" width={64} height={64} />
        <Logo height={36} />
      </div>
      <Sub>{s('ornament')}</Sub>
      <p className="dx-t-small" style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-4)', maxWidth: '68ch' }}>
        {s('ornamentText')}
      </p>
      <div className="sg-orn">
        <div className="sg-orn__controls">
          {(
            [
              ['rings', 'rings', 1, 6, rings, setRings],
              ['petals', 'petals', 3, 24, petals, setPetals],
              ['rotation', 'rotation', 0, 360, rotation, setRotation],
            ] as const
          ).map(([id, key, min, max, val, set]) => (
            <div className="sg-range" key={id}>
              <label htmlFor={`orn-${id}`}>
                {s(key)}
                <span className="sg-mono">{val}</span>
              </label>
              <input id={`orn-${id}`} type="range" min={min} max={max} value={val} onChange={(e) => set(Number(e.target.value))} />
            </div>
          ))}
          <Switch label={s('animated')} checked={animated} onChange={(e) => setAnimated(e.target.checked)} />
        </div>
        <Davra size={240} rings={rings} petals={petals} rotation={rotation} animated={animated} />
      </div>
      <div className="sg-ornaments" style={{ marginTop: 'var(--space-6)' }}>
        <Davra size={64} rings={1} petals={6} />
        <Davra size={64} rings={2} petals={8} rotation={22.5} />
        <Davra size={96} rings={3} petals={12} />
        <Davra size={96} rings={4} petals={16} rotation={11} muted />
        <Davra size={128} rings={5} petals={20} rotation={4} />
        <Davra size={128} rings={6} petals={24} />
      </div>
    </>
  );
}

// ---- icons ----------------------------------------------------------------------------------------------------
function IconsSection() {
  const entries = useMemo(
    () => Object.entries(Icons).filter(([k, v]) => k.startsWith('Icon') && typeof v === 'function') as Array<[string, Icons.IconComponent]>,
    [],
  );
  return (
    <>
      <div className="sg-row" style={{ marginBottom: 'var(--space-5)', color: 'var(--text)' }}>
        {[16, 20, 24, 32, 40].map((n) => (
          <Icons.IconLayoutRing key={n} size={n} />
        ))}
        <Icons.IconShieldCheck size={24} title="Shield with check" />
      </div>
      <div className="sg-icongrid" data-testid="icon-gallery">
        {entries.map(([name, Icon]) => (
          <div className="sg-icon" key={name}>
            <Icon size={24} />
            <span>{kebab(name.replace(/^Icon/, ''))}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---- buttons --------------------------------------------------------------------------------------------------
function ButtonsSection({ s }: { s: S }) {
  const variants = [
    ['primary', s('btnPrimary')],
    ['secondary', s('btnSecondary')],
    ['ghost', s('btnGhost')],
    ['danger', s('btnDanger')],
    ['highlight', s('btnHighlight')],
  ] as const;
  const states: Array<[string, string, Record<string, unknown>]> = [
    ['default', s('stDefault'), {}],
    ['hover', s('stHover'), { 'data-demo': 'hover' }],
    ['pressed', s('stPressed'), { 'data-demo': 'active' }],
    ['focus', s('stFocus'), { 'data-demo': 'focus' }],
    ['disabled', s('stDisabled'), { disabled: true }],
    ['loading', s('stLoading'), { loading: true }],
  ];
  return (
    <>
      <Sub>
        {s('btnVariants')} × {s('btnStates')}
      </Sub>
      <div className="sg-table-wrap">
        <table className="sg-table">
          <thead>
            <tr>
              <td />
              {states.map(([k, label]) => (
                <th scope="col" key={k}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {variants.map(([v, label]) => (
              <tr key={v}>
                <th scope="row">{label}</th>
                {states.map(([k, , props]) => (
                  <td key={k}>
                    <Button variant={v} {...props}>
                      {label}
                    </Button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Sub>{s('btnSizes')}</Sub>
      <div className="sg-row">
        <Button variant="primary" size="sm">
          {s('sizeSmall')}
        </Button>
        <Button variant="primary">{s('sizeMedium')}</Button>
        <Button variant="primary" size="lg">
          {s('sizeLarge')}
        </Button>
      </div>
      <Sub>{s('btnIcon')}</Sub>
      <div className="sg-row">
        <Button variant="primary" icon={<Icons.IconPlus size={18} />}>
          {s('newRoom')}
        </Button>
        <Button iconEnd={<Icons.IconChevronRight size={18} />}>{s('joinNow')}</Button>
        <Button variant="danger" icon={<Icons.IconPhoneOff size={18} />}>
          {s('dialogLeave')}
        </Button>
        <IconButton label={s('muteLabel')} icon={<Icons.IconMicOff />} variant="secondary" />
        <IconButton label={s('cameraLabel')} icon={<Icons.IconCameraOff />} variant="secondary" />
        <IconButton label={s('btnDanger')} icon={<Icons.IconPhoneOff />} variant="danger" />
        <IconButton label={s('btnPrimary')} icon={<Icons.IconPlus />} variant="primary" size="sm" />
        <IconButton label={s('btnGhost')} icon={<Icons.IconSettings />} />
      </div>
    </>
  );
}

// ---- fields ---------------------------------------------------------------------------------------------------
function FieldsSection({ lang, s }: { lang: Lang; s: S }) {
  const [code, setCode] = useState('4829051');
  const [all, setAll] = useState<[boolean, boolean]>([true, false]);
  const mixed = all[0] !== all[1];
  return (
    <div className="sg-split">
      <div className="sg-stack">
        <TextField label={s('fieldName')} hint={s('fieldNameHint')} defaultValue="Aziza Karimova" autoComplete="off" />
        <TextField label={s('fieldCode')} code inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} error={code.replace(/\s/g, '').length < 11 ? s('fieldCodeError') : undefined} optionalText={t(lang, 'uiOptional')} />
        <TextField label={s('fieldDisabled')} disabled defaultValue="DavraBox" />
        <Select label={s('fieldLang')} defaultValue={lang}>
          <option value="uz">O‘zbekcha</option>
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </Select>
      </div>
      <div className="sg-stack">
        <Sub>{s('checkboxes')}</Sub>
        <Checkbox label={s('checkWaiting')} hint={s('checkWaitingHint')} defaultChecked />
        <Checkbox label={s('checkMixed')} indeterminate={mixed} checked={all[0] && all[1]} onChange={(e) => setAll([e.target.checked, e.target.checked])} />
        <div style={{ display: 'grid', gap: 'var(--space-2)', paddingInlineStart: 'var(--space-6)' }}>
          <Checkbox label="A" checked={all[0]} onChange={(e) => setAll([e.target.checked, all[1]])} />
          <Checkbox label="B" checked={all[1]} onChange={(e) => setAll([all[0], e.target.checked])} />
        </div>
        <Checkbox label={s('checkOff')} disabled />
        <Sub>{s('switches')}</Sub>
        <Switch label={s('switchMic')} defaultChecked />
        <Switch label={s('switchBlur')} />
        <Switch label={s('stDisabled')} disabled />
      </div>
    </div>
  );
}

// ---- feedback -------------------------------------------------------------------------------------------------
function ToastButtons({ s }: { s: S }) {
  const toast = useToast();
  return (
    <div className="sg-row">
      <Button onClick={() => toast({ tone: 'success', title: s('toastSaved') })}>{s('toastShow')}: <IconCheck size={16} /></Button>
      <Button onClick={() => toast({ tone: 'danger', title: s('toastFailed'), description: s('alertDangerText') })}>{s('toastShow')}: !</Button>
    </div>
  );
}

function FeedbackSection({ lang, s }: { lang: Lang; s: S }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="sg-split">
        <div className="sg-stack">
          <Alert tone="info" title={s('alertInfoTitle')}>
            {s('alertInfoText')}
          </Alert>
          <Alert tone="success" title={s('alertSuccessTitle')} />
          {open ? (
            <Alert tone="warning" title={s('alertWarningTitle')} onDismiss={() => setOpen(false)} dismissLabel={t(lang, 'uiDismiss')}>
              {s('alertWarningText')}
            </Alert>
          ) : (
            <Button size="sm" onClick={() => setOpen(true)}>
              {s('alertWarningTitle')}
            </Button>
          )}
          <Alert tone="danger" title={s('alertDangerTitle')}>
            {s('alertDangerText')}
          </Alert>
          <ToastButtons s={s} />
        </div>
        <div className="sg-stack">
          <Sub>{s('badges')}</Sub>
          <div className="sg-row">
            <Badge>{s('badgeNew')}</Badge>
            <Badge tone="accent">{s('badgeHost')}</Badge>
            <Badge tone="gold" dot>
              {s('badgeLive')}
            </Badge>
            <Badge tone="success" dot>
              {s('badgeLive')}
            </Badge>
            <Badge tone="warning">{s('badgeWarn')}</Badge>
            <Badge tone="danger">{s('badgeError')}</Badge>
            <Badge tone="neutral">
              <Icons.IconLock size={12} /> {s('badgeLocked')}
            </Badge>
          </div>
          <Sub>{s('spinners')}</Sub>
          <div className="sg-row" style={{ color: 'var(--accent)' }}>
            <Spinner size={16} />
            <Spinner size={24} label={t(lang, 'uiLoading')} />
            <Spinner size={40} />
          </div>
          <Sub>{s('skeletons')}</Sub>
          <div className="sg-panel" aria-busy="true">
            <div className="sg-row" style={{ flexWrap: 'nowrap' }}>
              <Skeleton width={40} height={40} radius={20} />
              <div style={{ flex: 1, display: 'grid', gap: 8 }}>
                <Skeleton width="60%" height={14} />
                <Skeleton width="85%" height={12} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <Sub>{s('connecting')}</Sub>
      <div className="sg-panel" style={{ display: 'grid', placeItems: 'center', padding: 'var(--space-10)' }}>
        <ConnectingRing label={t(lang, 'uiConnecting')} />
      </div>
    </>
  );
}

// ---- overlays -------------------------------------------------------------------------------------------------
function OverlaysSection({ lang, s }: { lang: Lang; s: S }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <>
      <p className="dx-t-small" style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-4)' }}>
        {s('tooltipText')}
      </p>
      <div className="sg-row">
        <IconButton label={s('muteLabel')} icon={<Icons.IconMic />} variant="secondary" />
        <Tooltip content={s('cameraLabel')} side="bottom">
          <Button variant="secondary" icon={<Icons.IconCamera size={18} />}>
            {s('btnPrimary')}
          </Button>
        </Tooltip>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {s('openDialog')}
        </Button>
        <Menu
          items={[
            { id: 'copy', label: s('menuCopyLink'), icon: <Icons.IconLink size={18} />, onSelect: () => toast({ tone: 'success', title: t(lang, 'uiCopied') }) },
            { id: 'invite', label: s('menuInvite'), icon: <Icons.IconUsers size={18} />, onSelect: () => undefined },
            { id: 'lock', label: s('menuLock'), icon: <Icons.IconLock size={18} />, onSelect: () => undefined },
            { id: 'end', label: s('menuEnd'), icon: <Icons.IconPhoneOff size={18} />, tone: 'danger', separatorBefore: true, onSelect: () => undefined },
          ]}
          trigger={(p) => (
            <Button {...p} variant="secondary" iconEnd={<Icons.IconChevronDown size={18} />}>
              {s('menuOpen')}
            </Button>
          )}
        />
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={s('dialogTitle')}
        closeLabel={t(lang, 'uiClose')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{s('dialogStay')}</Button>
            <Button variant="danger" onClick={() => setOpen(false)}>
              {s('dialogLeave')}
            </Button>
          </>
        }
      >
        {s('dialogText')}
      </Dialog>
    </>
  );
}

// ---- navigation, data ------------------------------------------------------------------------------------------
function NavigationSection({ s }: { s: S }) {
  return (
    <>
      <Tabs
        label={s('tabsLabel')}
        tabs={[
          { id: 'overview', label: s('tabOverview'), panel: <p>{s('tabOverviewText')}</p> },
          { id: 'people', label: s('tabParticipants'), panel: <p>{s('tabParticipantsText')}</p> },
          { id: 'settings', label: s('tabSettings'), panel: <p>{s('tabSettingsText')}</p> },
          { id: 'rec', label: s('tabDisabled'), panel: null, disabled: true },
        ]}
      />
      <Sub>{s('shortcuts')}</Sub>
      <div className="sg-row">
        <span>
          {s('shortcutMute')} <Kbd>Ctrl</Kbd> + <Kbd>D</Kbd>
        </span>
        <span>
          {s('shortcutHand')} <Kbd>Alt</Kbd> + <Kbd>Y</Kbd>
        </span>
        <span>
          <Kbd>Esc</Kbd>
        </span>
      </div>
    </>
  );
}

const people = [
  ['u1', 'Aziza Karimova'],
  ['u2', 'Bobur Toshmatov'],
  ['u3', 'O‘ktam G‘ulomov'],
  ['u4', 'Дилноза Юсупова'],
  ['u5', 'Jasur Rahimov'],
  ['u6', 'Madina Abdullayeva'],
  ['u7', 'Sherzod'],
  ['u8', 'Nodira Ergasheva'],
] as const;

function DataSection({ s }: { s: S }) {
  return (
    <>
      <Sub>{s('avatars')}</Sub>
      <div className="sg-people">
        {people.map(([id, name]) => (
          <div className="sg-person" key={id}>
            <Avatar id={id} name={name} decorative />
            {name}
          </div>
        ))}
      </div>
      <div className="sg-avatars" style={{ marginTop: 'var(--space-5)' }}>
        {[24, 32, 40, 56, 72].map((n) => (
          <Avatar key={n} id="u1" name="Aziza Karimova" size={n} />
        ))}
      </div>
      <Sub>{s('avatarRing')}</Sub>
      <div className="sg-ringrow">
        <Avatar id="u2" name="Bobur Toshmatov" size={56} ring="speaking" />
        <Avatar id="u3" name="O‘ktam G‘ulomov" size={56} ring="hand" />
      </div>
      <Sub>{s('cards')}</Sub>
      <div className="sg-split">
        <Card>
          <CardTitle>{s('cardPlain')}</CardTitle>
          <p className="dx-t-small" style={{ color: 'var(--text-muted)' }}>
            {s('cardPlainText')}
          </p>
        </Card>
        <Card interactive tabIndex={0} role="button">
          <CardTitle>{s('cardInteractive')}</CardTitle>
          <p className="dx-t-small" style={{ color: 'var(--text-muted)' }}>
            {s('cardInteractiveText')}
          </p>
        </Card>
        <Card elevated>
          <CardTitle>{s('cardElevated')}</CardTitle>
          <p className="dx-t-small" style={{ color: 'var(--text-muted)' }}>
            {s('cardElevatedText')}
          </p>
        </Card>
      </div>
      <div className="sg-panel" style={{ marginTop: 'var(--space-5)' }}>
        <EmptyState
          title={s('emptyTitle')}
          description={s('emptyText')}
          action={
            <Button variant="primary" icon={<Icons.IconPlus size={18} />}>
              {s('newRoom')}
            </Button>
          }
        />
      </div>
    </>
  );
}

// ---- page -----------------------------------------------------------------------------------------------------
export default function Styleguide() {
  const { lang, theme, setLang: changeLang, setTheme } = usePrefs();
  const rootRef = useRef<HTMLDivElement>(null);
  const s: S = (k) => sg(lang, k);

  useEffect(() => {
    document.title = sg(lang, 'docTitle');
  }, [lang]);

  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  const nav: Array<[string, SgKey]> = [
    ['colors', 'secColors'],
    ['type', 'secType'],
    ['scales', 'secScales'],
    ['brand', 'secBrand'],
    ['icons', 'secIcons'],
    ['buttons', 'secButtons'],
    ['fields', 'secFields'],
    ['feedback', 'secFeedback'],
    ['overlays', 'secOverlays'],
    ['navigation', 'secNavigation'],
    ['data', 'secData'],
  ];

  return (
    <ToastProvider dismissLabel={t(lang, 'uiDismiss')} regionLabel={s('toastRegion')}>
      <div className="sg" ref={rootRef}>
        <a className="sg-skip" href="#main">
          {s('skip')}
        </a>
        <header className="sg-header">
          <span className="sg-logo-lockup">
            <Logo height={28} />
          </span>
          <nav className="sg-nav" aria-label={s('nav')}>
            {nav.map(([id, key]) => (
              <a key={id} href={`#${id}`}>
                {s(key)}
              </a>
            ))}
          </nav>
          <div className="sg-tools">
            <IconButton
              label={theme === 'dark' ? s('themeToLight') : s('themeToDark')}
              icon={theme === 'dark' ? <Icons.IconSun /> : <Icons.IconMoon />}
              onClick={toggleTheme}
              data-testid="theme-toggle"
            />
            <Select label={<span className="dx-sr-only">{s('langLabel')}</span>} value={lang} onChange={(e) => changeLang(e.target.value as Lang)} data-testid="lang-select">
              <option value="uz">O‘zbekcha</option>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </Select>
          </div>
        </header>
        <main className="sg-main" id="main">
          <div className="sg-hero">
            <div className="sg-hero__art" aria-hidden="true">
              <Davra size={460} rings={4} petals={14} rotation={8} />
            </div>
            <LogoMark size={56} />
            <h1 className="dx-t-display">{s('introTitle')}</h1>
            <p className="sg-hero__text dx-t-lead">{s('introText')}</p>
            <p className="sg-hero__line">{s('brandLine')}</p>
          </div>
          <Section id="colors" title={s('secColors')} lead={s('colorsText')}>
            <Colours theme={theme} s={s} />
          </Section>
          <Section id="type" title={s('secType')} lead={s('typeText')}>
            <TypeSection lang={lang} s={s} />
          </Section>
          <Section id="scales" title={s('secScales')} lead={s('scalesText')}>
            <ScalesSection s={s} />
          </Section>
          <Section id="brand" title={s('secBrand')} lead={s('brandText')}>
            <BrandSection s={s} />
          </Section>
          <Section id="icons" title={s('secIcons')} lead={s('iconsText')}>
            <IconsSection />
          </Section>
          <Section id="buttons" title={s('secButtons')}>
            <ButtonsSection s={s} />
          </Section>
          <Section id="fields" title={s('secFields')}>
            <FieldsSection lang={lang} s={s} />
          </Section>
          <Section id="feedback" title={s('secFeedback')}>
            <FeedbackSection lang={lang} s={s} />
          </Section>
          <Section id="overlays" title={s('secOverlays')}>
            <OverlaysSection lang={lang} s={s} />
          </Section>
          <Section id="navigation" title={s('secNavigation')}>
            <NavigationSection s={s} />
          </Section>
          <Section id="data" title={s('secData')}>
            <DataSection s={s} />
          </Section>
        </main>
      </div>
    </ToastProvider>
  );
}
