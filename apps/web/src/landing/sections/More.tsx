import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tx } from '../../home/text';
import type { Key, Lang } from '../../i18n';
import {
  Button, IconBook, IconCheck, IconCopy, IconDownload, IconGlobe, IconLock, IconMonitor, IconPause, IconPlay, IconShieldCheck, IconSmartphone, IconUsers, IconWarning,
  type IconComponent,
} from '../../ui';
import { ButtonLink } from '../ButtonLink';
import { CONTACT_EMAIL } from './Footer';
import { MANIFEST_URL, parseManifest, sizeMb, type DownloadItem, type Platform } from '../downloads';
import { REPO_URL, docUrl } from '../menu';

interface Props {
  lang: Lang;
}

function Head({ id, title, lead }: { id: string; title: ReactNode; lead?: ReactNode }) {
  return (
    <div className="ln-head">
      <h2 className="ln-h2" id={id}>
        {title}
      </h2>
      {lead ? <p className="ln-lead">{lead}</p> : null}
    </div>
  );
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The demo clips (decision 7): recorded by apps/e2e/demo.videos.mjs from the labs with synthetic media. */
export const DEMOS = [
  { id: 'join', title: 'lnDemo1T', desc: 'lnDemo1D' },
  { id: 'waiting', title: 'lnDemo2T', desc: 'lnDemo2D' },
  { id: 'share', title: 'lnDemo3T', desc: 'lnDemo3D' },
  { id: 'admin', title: 'lnDemo4T', desc: 'lnDemo4D' },
] as const satisfies ReadonlyArray<{ id: string; title: Key; desc: Key }>;

/** One clip per demo and language (the clips show the interface text): /landing/demo/<id>-<lang>.mp4 + .webp poster. */
export const demoSrc = (id: string, lang: Lang) => ({ video: `/landing/demo/${id}-${lang}.mp4`, poster: `/landing/demo/${id}-${lang}.webp` });

/**
 * A silent looping clip that costs nothing until it is near the viewport: no `src` before that (preload none), playing
 * only while visible, never autoplaying for people who asked for reduced motion, and always with a pause control
 * (WCAG 2.2.2).
 */
function DemoVideo({ id, label, lang }: { id: string; label: string; lang: Lang }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [paused, setPaused] = useState(reducedMotion);
  const visible = useRef(false);
  const { video, poster } = demoSrc(id, lang);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          visible.current = e.isIntersecting;
          if (e.isIntersecting) setNear(true);
          if (!e.isIntersecting) el.pause();
          else if (!paused) void el.play().catch(() => undefined);
        }
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [paused]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !near) return;
    if (paused) el.pause();
    else if (visible.current) void el.play().catch(() => undefined);
  }, [near, paused]);

  return (
    <div className="ln-demo__media">
      <video ref={ref} className="ln-demo__video" muted loop playsInline preload="none" poster={poster} width={960} height={540} aria-label={label} src={near ? video : undefined} />
      <Button
        className="ln-demo__toggle"
        variant="secondary"
        size="sm"
        icon={paused ? <IconPlay size={16} /> : <IconPause size={16} />}
        aria-pressed={!paused}
        onClick={() => setPaused((p) => !p)}
        data-testid={`demo-toggle-${id}`}
      >
        {tx(lang, paused ? 'lnDemoPlay' : 'lnDemoPause')}
      </Button>
    </div>
  );
}

export function Demos({ lang }: Props) {
  return (
    <section className="ln-section" id="demo" aria-labelledby="ln-demo-h">
      <Head id="ln-demo-h" title={tx(lang, 'lnDemoTitle')} lead={tx(lang, 'lnDemoLead')} />
      <ul className="ln-grid ln-grid--demo">
        {DEMOS.map((d) => (
          <li key={d.id} className="ln-tile ln-demo" data-testid="demo">
            <DemoVideo id={d.id} label={tx(lang, d.title)} lang={lang} />
            <h3 className="ln-tile__title">{tx(lang, d.title)}</h3>
            <p className="ln-tile__text">{tx(lang, d.desc)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Verifiable facts only (decision 2): each one links to the document or code that proves it. */
export const TRUST: ReadonlyArray<{ n: 1 | 2 | 3 | 4 | 5 | 6; icon: IconComponent; href: string }> = [
  { n: 1, icon: IconBook, href: REPO_URL },
  { n: 2, icon: IconLock, href: docUrl('docs/e2ee.md') },
  { n: 3, icon: IconShieldCheck, href: docUrl('docs/AUDIT.md') },
  { n: 4, icon: IconUsers, href: docUrl('docs/sso.md') },
  { n: 5, icon: IconWarning, href: docUrl('docs/security-testing.md') },
  { n: 6, icon: IconGlobe, href: docUrl('docs/lighthouse.md') },
];

export function Trust({ lang }: Props) {
  return (
    <section className="ln-section" id="trust" aria-labelledby="ln-trust-h">
      <Head id="ln-trust-h" title={tx(lang, 'lnTrustTitle')} lead={tx(lang, 'lnTrustLead')} />
      <ul className="ln-grid ln-grid--caps">
        {TRUST.map(({ n, icon: Icon, href }) => (
          <li key={n} className="ln-tile" data-testid="trust-fact">
            <span className="ln-tile__icon">
              <Icon size={22} />
            </span>
            <h3 className="ln-tile__title">{tx(lang, `lnTrust${n}T` as Key)}</h3>
            <p className="ln-tile__text">{tx(lang, `lnTrust${n}D` as Key)}</p>
            <a className="ln-tile__link" href={href} target="_blank" rel="noopener noreferrer">
              {tx(lang, `lnTrust${n}L` as Key)}
              <span className="ln-sr"> ({tx(lang, 'lnTrustExternal')})</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const mailto = (lang: Lang, plan: string) => `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`${tx(lang, 'lnPriceMailSubject')}: ${plan}`)}`;

/** Trial limits are the real ones from the code (apps/api/src/signup/limits.ts TRIAL, files/policy.ts); paid plans list features only. */
export function Pricing({ lang }: Props) {
  const plans = [
    { id: 'trial', name: tx(lang, 'lnPriceTrialName'), price: tx(lang, 'lnPriceTrialPrice'), note: tx(lang, 'lnPriceTrialNote'), items: [1, 2, 3, 4, 5].map((n) => tx(lang, `lnPriceTrial${n}` as Key)), cta: <ButtonLink href="/app/signup" variant="primary">{tx(lang, 'lnStartFree')}</ButtonLink> },
    { id: 'business', name: tx(lang, 'lnPriceBizName'), price: tx(lang, 'lnPriceAgreed'), note: tx(lang, 'lnPriceBizNote'), items: [1, 2, 3, 4, 5].map((n) => tx(lang, `lnPriceBiz${n}` as Key)), cta: <ButtonLink href={mailto(lang, 'Business')} variant="secondary">{tx(lang, 'lnPriceContact')}</ButtonLink> },
    { id: 'enterprise', name: tx(lang, 'lnPriceEntName'), price: tx(lang, 'lnPriceAgreed'), note: tx(lang, 'lnPriceEntNote'), items: [1, 2, 3, 4, 5].map((n) => tx(lang, `lnPriceEnt${n}` as Key)), cta: <ButtonLink href={mailto(lang, 'Enterprise')} variant="secondary">{tx(lang, 'lnPriceContact')}</ButtonLink> },
  ];
  return (
    <section className="ln-section" id="pricing" aria-labelledby="ln-price-h">
      <Head id="ln-price-h" title={tx(lang, 'lnPriceTitle')} lead={tx(lang, 'lnPriceLead')} />
      <ul className="ln-plans">
        {plans.map((p) => (
          <li key={p.id} className="ln-tile ln-plan" data-plan={p.id} data-testid="plan">
            <h3 className="ln-plan__name">{p.name}</h3>
            <p className="ln-plan__price">{p.price}</p>
            <p className="ln-plan__note">{p.note}</p>
            <ul className="ln-plan__list">
              {p.items.map((it) => (
                <li key={it}>
                  <IconCheck size={18} className="ln-plan__tick" />
                  <span>{it}</span>
                </li>
              ))}
            </ul>
            <div className="ln-plan__cta">{p.cta}</div>
          </li>
        ))}
      </ul>
      <p className="ln-plan__limits">{tx(lang, 'lnPriceLimits')}</p>
    </section>
  );
}

function CopySha({ lang, sha }: { lang: Lang; sha: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={done ? <IconCheck size={16} /> : <IconCopy size={16} />}
      onClick={() => {
        void navigator.clipboard?.writeText(sha).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        }, () => undefined);
      }}
    >
      {tx(lang, done ? 'lnDlCopied' : 'lnDlCopy')}
    </Button>
  );
}

const PLATFORM: Record<Platform, { icon: IconComponent; title: Key; desc: Key }> = {
  android: { icon: IconSmartphone, title: 'lnDlAndroidT', desc: 'lnDlAndroidD' },
  windows: { icon: IconMonitor, title: 'lnDlWindowsT', desc: 'lnDlWindowsD' },
};

function AppCard({ lang, platform, item, state }: { lang: Lang; platform: Platform; item: DownloadItem | undefined; state: 'loading' | 'ready' }) {
  const P = PLATFORM[platform];
  return (
    <li className="ln-tile ln-app" data-testid={`download-${platform}`}>
      <span className="ln-tile__icon">
        <P.icon size={22} />
      </span>
      <h3 className="ln-tile__title">
        {tx(lang, P.title)} <span className="ln-soon ln-beta">{tx(lang, 'lnDlBeta')}</span>
      </h3>
      <p className="ln-tile__text">{tx(lang, P.desc)}</p>
      {item ? (
        <>
          <ButtonLink href={item.url} variant="primary" download={item.file} iconEnd={<IconDownload size={18} />} data-testid={`download-link-${platform}`}>
            {tx(lang, 'lnDlButton')}
          </ButtonLink>
          <p className="ln-app__meta">
            {[item.version ? tx(lang, 'lnDlVersion', { v: item.version }) : null, tx(lang, 'lnDlSize', { size: sizeMb(item.size, lang) })].filter(Boolean).join(' · ')}
            {' · '}
            <a href={item.runUrl} target="_blank" rel="noopener noreferrer">
              {tx(lang, 'lnDlBuild')} {item.commit}
              <span className="ln-sr"> ({tx(lang, 'lnTrustExternal')})</span>
            </a>
          </p>
          <div className="ln-app__sha">
            <span className="ln-app__sha-label">{tx(lang, 'lnDlSha')}</span>
            <code className="ln-app__sha-value" data-testid={`sha-${platform}`}>
              {item.sha256}
            </code>
            <CopySha lang={lang} sha={item.sha256} />
          </div>
        </>
      ) : (
        <p className="ln-app__none" role="status">
          {tx(lang, state === 'loading' ? 'lnDlLoading' : 'lnDlUnavailable')}
        </p>
      )}
    </li>
  );
}

export function Downloads({ lang, fetchManifest = defaultFetch }: Props & { fetchManifest?: () => Promise<unknown> }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready'; items: DownloadItem[] }>({ status: 'loading', items: [] });
  useEffect(() => {
    let live = true;
    fetchManifest().then(
      (raw) => live && setState({ status: 'ready', items: parseManifest(raw) }),
      () => live && setState({ status: 'ready', items: [] }),
    );
    return () => {
      live = false;
    };
  }, [fetchManifest]);
  const byPlatform = (p: Platform) => state.items.find((i) => i.platform === p);
  return (
    <section className="ln-section" id="download" aria-labelledby="ln-dl-h">
      <Head id="ln-dl-h" title={tx(lang, 'lnDlTitle')} lead={tx(lang, 'lnDlLead')} />
      <ul className="ln-grid ln-grid--three">
        <li className="ln-tile ln-app" data-testid="download-browser">
          <span className="ln-tile__icon">
            <IconGlobe size={22} />
          </span>
          <h3 className="ln-tile__title">{tx(lang, 'lnDlBrowserT')}</h3>
          <p className="ln-tile__text">{tx(lang, 'lnDlBrowserD')}</p>
          <ButtonLink href="/app" variant="secondary">
            {tx(lang, 'lnDlBrowserCta')}
          </ButtonLink>
        </li>
        <AppCard lang={lang} platform="android" item={byPlatform('android')} state={state.status} />
        <AppCard lang={lang} platform="windows" item={byPlatform('windows')} state={state.status} />
      </ul>
      <div className="ln-dl-warn" role="note" data-testid="beta-warning">
        <IconWarning size={20} className="ln-dl-warn__icon" />
        <div>
          <p className="ln-dl-warn__title">{tx(lang, 'lnDlWarnTitle')}</p>
          <p className="ln-dl-warn__text">{tx(lang, 'lnDlWarn')}</p>
          <p className="ln-dl-warn__links">
            <a href="/help#guide-android-install">{tx(lang, 'lnDlGuide')}</a>
            <a href="/help#faq-checksum">{tx(lang, 'lnDlVerify')}</a>
          </p>
        </div>
      </div>
    </section>
  );
}

async function defaultFetch(): Promise<unknown> {
  const r = await fetch(MANIFEST_URL, { cache: 'no-cache', credentials: 'omit' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
