import type { JSX, ReactNode, SVGProps } from 'react';

/**
 * DavraBox icon set: hand-drawn on a 24 px grid, 1.75 px stroke, round caps and joins, `currentColor`.
 * Decorative by default (aria-hidden); pass `title` to expose the icon to assistive technology.
 * Every icon is its own export built by a pure factory call, so unused icons are tree-shaken away.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'strokeWidth'> {
  /** Pixel size (square). Default 20. */
  size?: number | string;
  /** Accessible name. Without it the icon is hidden from assistive technology. */
  title?: string;
}
export type IconComponent = ((props: IconProps) => JSX.Element) & { displayName?: string };

export const ICON_STROKE = 1.75;

function makeIcon(name: string, body: () => ReactNode): IconComponent {
  const Icon: IconComponent = ({ size = 20, title, ...rest }) => (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
      data-icon={name}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {body()}
    </svg>
  );
  Icon.displayName = `Icon${name}`;
  return Icon;
}

const dot = (cx: number, cy: number, r = 1.5) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

// Calls
export const IconMic = /*#__PURE__*/ makeIcon('mic', () => (
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
  </>
));
export const IconMicOff = /*#__PURE__*/ makeIcon('mic-off', () => (
  <>
    <path d="M9 9.5V6a3 3 0 0 1 5.6-1.5M15 10v1.5a3 3 0 0 1-4.5 2.6" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 9.8 5.6M18.5 11.5c0 .9-.2 1.7-.6 2.5M12 18v3M9 21h6M4 4l16 16" />
  </>
));
export const IconCamera = /*#__PURE__*/ makeIcon('camera', () => (
  <>
    <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" />
    <path d="m15.5 10.5 5-3v9l-5-3" />
  </>
));
export const IconCameraOff = /*#__PURE__*/ makeIcon('camera-off', () => (
  <>
    <path d="M7.5 6.5h5.5a2.5 2.5 0 0 1 2.5 2.5v6.5M3 9.5V15a2.5 2.5 0 0 0 2.5 2.5h8.5" />
    <path d="m15.5 10.5 5-3v9l-3.2-1.9M4 4l16 16" />
  </>
));
export const IconScreenShare = /*#__PURE__*/ makeIcon('screen-share', () => (
  <>
    <rect x="3" y="4" width="18" height="12.5" rx="2.5" />
    <path d="M8 20.5h8M12 16.5v4M12 13V8.2m0 0L9.6 10.6M12 8.2l2.4 2.4" />
  </>
));
export const IconChat = /*#__PURE__*/ makeIcon('chat', () => <path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.3A8.5 8.5 0 1 1 20.5 12z" />);
export const IconHand = /*#__PURE__*/ makeIcon('hand', () => (
  <path d="M8 12.5V6a1.5 1.5 0 0 1 3 0v4.5V4.5a1.5 1.5 0 0 1 3 0V10V5.5a1.5 1.5 0 0 1 3 0V12.5V9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.7a6.5 6.5 0 0 1-5.2-2.6L4.4 14.6a1.7 1.7 0 0 1 2.7-2L8 13.8" />
));
export const IconSmile = /*#__PURE__*/ makeIcon('smile', () => (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.4 14.3a4.2 4.2 0 0 0 7.2 0M9 9.6h.01M15 9.6h.01" />
  </>
));
export const IconUsers = /*#__PURE__*/ makeIcon('users', () => (
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M15.5 4.7a3.5 3.5 0 0 1 0 6.6M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
  </>
));
export const IconUser = /*#__PURE__*/ makeIcon('user', () => (
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  </>
));
export const IconPhoneOff = /*#__PURE__*/ makeIcon('phone-off', () => (
  <path d="M3.3 14.6c5.2-4.3 12.2-4.3 17.4 0l-1.1 2.3a1.7 1.7 0 0 1-2.1.8l-2.3-.9a1.7 1.7 0 0 1-1.1-1.6v-1.3a9.6 9.6 0 0 0-4.6 0v1.3a1.7 1.7 0 0 1-1.1 1.6l-2.3.9a1.7 1.7 0 0 1-2.1-.8l-1-2.3z" />
));
export const IconVolume = /*#__PURE__*/ makeIcon('volume', () => (
  <>
    <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </>
));
export const IconBlur = /*#__PURE__*/ makeIcon('blur', () => (
  <>
    <circle cx="12" cy="12" r="9" strokeDasharray="2.2 3.1" />
    <circle cx="12" cy="10" r="2.6" />
    <path d="M7.4 17.6a5 5 0 0 1 9.2 0" />
  </>
));
export const IconNoise = /*#__PURE__*/ makeIcon('noise', () => <path d="M4 10.5v3M8 7v10M12 4v16M16 8v8M20 10.5v3" />);

// Layouts
export const IconLayoutRing = /*#__PURE__*/ makeIcon('layout-ring', () => (
  <>
    <circle cx="12" cy="12" r="3.2" />
    {[
      [12, 3.8],
      [19.1, 7.9],
      [19.1, 16.1],
      [12, 20.2],
      [4.9, 16.1],
      [4.9, 7.9],
    ].map(([x, y]) => (
      <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" />
    ))}
  </>
));
export const IconLayoutGrid = /*#__PURE__*/ makeIcon('layout-grid', () => (
  <>
    <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
    <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
    <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
    <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
  </>
));
export const IconLayoutSpeaker = /*#__PURE__*/ makeIcon('layout-speaker', () => (
  <>
    <rect x="3.5" y="3.5" width="17" height="10.5" rx="2.2" />
    <rect x="3.5" y="16.5" width="4.8" height="4" rx="1.3" />
    <rect x="9.6" y="16.5" width="4.8" height="4" rx="1.3" />
    <rect x="15.7" y="16.5" width="4.8" height="4" rx="1.3" />
  </>
));

// Security
export const IconLock = /*#__PURE__*/ makeIcon('lock', () => (
  <>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 15v2" />
  </>
));
export const IconUnlock = /*#__PURE__*/ makeIcon('unlock', () => (
  <>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 7.6-1.7M12 15v2" />
  </>
));
export const IconShield = /*#__PURE__*/ makeIcon('shield', () => <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z" />);
export const IconShieldCheck = /*#__PURE__*/ makeIcon('shield-check', () => (
  <>
    <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z" />
    <path d="m8.8 12 2.2 2.2 4.2-4.4" />
  </>
));
export const IconEye = /*#__PURE__*/ makeIcon('eye', () => (
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </>
));
export const IconEyeOff = /*#__PURE__*/ makeIcon('eye-off', () => (
  <>
    <path d="M9.9 5.7a8 8 0 0 1 2.1-.2c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.5M6.3 7.7A16.4 16.4 0 0 0 2.5 12S6 18.5 12 18.5a8.4 8.4 0 0 0 3.5-.8" />
    <path d="M10 10a3 3 0 0 0 4 4M4 4l16 16" />
  </>
));

// Actions
export const IconSettings = /*#__PURE__*/ makeIcon('settings', () => (
  <>
    <path d="M4 7h8M18 7h2M4 17h2M12 17h8" />
    <circle cx="15" cy="7" r="2.2" />
    <circle cx="9" cy="17" r="2.2" />
  </>
));
export const IconLink = /*#__PURE__*/ makeIcon('link', () => (
  <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
));
export const IconCopy = /*#__PURE__*/ makeIcon('copy', () => (
  <>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.8" />
    <path d="M15.5 8.5V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v5.5a3 3 0 0 0 3 3h1.5" />
  </>
));
export const IconPlus = /*#__PURE__*/ makeIcon('plus', () => <path d="M12 5v14M5 12h14" />);
export const IconMinus = /*#__PURE__*/ makeIcon('minus', () => <path d="M5 12h14" />);
export const IconSearch = /*#__PURE__*/ makeIcon('search', () => (
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </>
));
export const IconCalendar = /*#__PURE__*/ makeIcon('calendar', () => (
  <>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </>
));
export const IconClock = /*#__PURE__*/ makeIcon('clock', () => (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>
));
export const IconX = /*#__PURE__*/ makeIcon('x', () => <path d="m6 6 12 12M18 6 6 18" />);
export const IconCheck = /*#__PURE__*/ makeIcon('check', () => <path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconChevronDown = /*#__PURE__*/ makeIcon('chevron-down', () => <path d="m6 9 6 6 6-6" />);
export const IconChevronUp = /*#__PURE__*/ makeIcon('chevron-up', () => <path d="m6 15 6-6 6 6" />);
export const IconChevronLeft = /*#__PURE__*/ makeIcon('chevron-left', () => <path d="m15 6-6 6 6 6" />);
export const IconChevronRight = /*#__PURE__*/ makeIcon('chevron-right', () => <path d="m9 6 6 6-6 6" />);
export const IconMore = /*#__PURE__*/ makeIcon('more', () => (
  <>
    {dot(5.5, 12)}
    {dot(12, 12)}
    {dot(18.5, 12)}
  </>
));
export const IconMenu = /*#__PURE__*/ makeIcon('menu', () => <path d="M4 7h16M4 12h16M4 17h16" />);
export const IconLogout = /*#__PURE__*/ makeIcon('logout', () => <path d="M9 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9M15 8l4 4-4 4M19 12H9.5" />);
export const IconDownload = /*#__PURE__*/ makeIcon('download', () => <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />);
export const IconUpload = /*#__PURE__*/ makeIcon('upload', () => <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 19.5h14" />);
export const IconPaperclip = /*#__PURE__*/ makeIcon('paperclip', () => (
  <path d="m20 11.5-8.2 8.2a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15.5 7" />
));
export const IconPin = /*#__PURE__*/ makeIcon('pin', () => <path d="M9 3.5h6l-1 5.5 3 3.5V14H7v-1.5L10 9 9 3.5zM12 14v6.5" />);
export const IconSend = /*#__PURE__*/ makeIcon('send', () => <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5 21 3z" />);
export const IconTrash = /*#__PURE__*/ makeIcon('trash', () => <path d="M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 13.5h9l1-13.5M10 10.5v6M14 10.5v6" />);
export const IconEdit = /*#__PURE__*/ makeIcon('edit', () => <path d="M4 20h4l11-11-4-4L4 16v4zM13 7l4 4" />);
export const IconGlobe = /*#__PURE__*/ makeIcon('globe', () => (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z" />
  </>
));
export const IconSun = /*#__PURE__*/ makeIcon('sun', () => (
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </>
));
export const IconMoon = /*#__PURE__*/ makeIcon('moon', () => <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />);

// Status
export const IconInfo = /*#__PURE__*/ makeIcon('info', () => (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </>
));
export const IconWarning = /*#__PURE__*/ makeIcon('warning', () => (
  <>
    <path d="M12 3.8 21 19.5H3L12 3.8z" />
    <path d="M12 10v4.2M12 17h.01" />
  </>
));
export const IconError = /*#__PURE__*/ makeIcon('error', () => (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </>
));
export const IconCheckCircle = /*#__PURE__*/ makeIcon('check-circle', () => (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.2 12.4 2.6 2.6 5-5.4" />
  </>
));
export const IconHelp = /*#__PURE__*/ makeIcon('help', () => (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.7" />
    <path d="M12 17.2v.01" />
  </>
));
export const IconBook = /*#__PURE__*/ makeIcon('book', () => (
  <>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" />
  </>
));
export const IconPlay = /*#__PURE__*/ makeIcon('play', () => <path d="M8 5.5v13a.7.7 0 0 0 1.05.6l10.4-6.5a.7.7 0 0 0 0-1.2L9.05 4.9A.7.7 0 0 0 8 5.5z" />);
export const IconPause = /*#__PURE__*/ makeIcon('pause', () => <path d="M8 5v14M16 5v14" />);
export const IconSmartphone = /*#__PURE__*/ makeIcon('smartphone', () => (
  <>
    <rect x="7" y="3" width="10" height="18" rx="2" />
    <path d="M11 17.5h2" />
  </>
));
export const IconMonitor = /*#__PURE__*/ makeIcon('monitor', () => (
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>
));
export const IconTag = /*#__PURE__*/ makeIcon('tag', () => (
  <>
    <path d="M3.5 12.1V4.5a1 1 0 0 1 1-1h7.6l8.4 8.4a1 1 0 0 1 0 1.4l-7.2 7.2a1 1 0 0 1-1.4 0z" />
    <path d="M8 8h.01" />
  </>
));

// ---- in-call feature package (2026-11-26) ----------------------------------------------------------------------------
export const IconSpotlight = /*#__PURE__*/ makeIcon('spotlight', () => (
  <>
    <circle cx="12" cy="9" r="3" />
    <path d="M6.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M12 2v1.5M4.9 4.9 6 6M19.1 4.9 18 6M2.5 11H4M20 11h1.5" />
  </>
));
export const IconPip = /*#__PURE__*/ makeIcon('pip', () => (
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <rect x="12" y="11.5" width="6.5" height="5" rx="1.2" />
  </>
));
export const IconImage = /*#__PURE__*/ makeIcon('image', () => (
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
  </>
));
export const IconMicMuteAll = /*#__PURE__*/ makeIcon('mic-mute-all', () => (
  <>
    <rect x="7" y="3" width="6" height="10" rx="3" />
    <path d="M4 10a6 6 0 0 0 9.5 4.9M10 16v4M7 20h6M3 3l14 14" />
    <path d="M17 8h4M17 12h4" />
  </>
));
export const IconPoll = /*#__PURE__*/ makeIcon('poll', () => (
  <>
    <path d="M4 20h16" />
    <rect x="5" y="11" width="3.2" height="6.5" rx="1" />
    <rect x="10.4" y="5" width="3.2" height="12.5" rx="1" />
    <rect x="15.8" y="8.5" width="3.2" height="9" rx="1" />
  </>
));
export const IconQuestion = /*#__PURE__*/ makeIcon('question', () => (
  <>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v9a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 15.5z" />
    <path d="M10 8.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.5M12 13.7v.1" />
  </>
));
export const IconArrowUp = /*#__PURE__*/ makeIcon('arrow-up', () => <path d="M12 19V5M6 11l6-6 6 6" />);
export const IconWhiteboard = /*#__PURE__*/ makeIcon('whiteboard', () => (
  <>
    <rect x="3" y="4" width="18" height="12.5" rx="2" />
    <path d="M8 20l2.5-3.5M16 20l-2.5-3.5M7 12.5c1.5-3 3-3 4.5-1s3 2 5.5-2" />
  </>
));
