import { BootScreen } from './ui/BootScreen';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { isLandingPath, isPrivacyPath, isSignupPath, isTermsPath, legacyJoinRedirect } from './routes';
import '@davrabox/design-tokens/tokens.css';
import './fonts.css';
import './styles.css';
import './ui/ui.css';
import './home/home.css';
import { initErrorTracking } from './observability/errorTracking';
import { watchSystemBars } from './platform/system-bars';
import { watchBackButton } from './platform/back-button';

// Error tracking (GlitchTip) is off unless the deployment serves a DSN in /runtime-config.json; see docs/observability.md.
void initErrorTracking();

// /styleguide is a separate lazy chunk: it needs no sign-in and no backend, and costs the product screens nothing.
// Like the labs below it is compiled out of a normal production build (development or VITE_CALL_LAB=1 only).
const STYLEGUIDE_ENABLED = import.meta.env.DEV || import.meta.env.VITE_CALL_LAB === '1';
const Styleguide = STYLEGUIDE_ENABLED ? lazy(() => import('./styleguide/Styleguide')) : null;
const isStyleguide = Styleguide !== null && location.pathname.replace(/\/+$/, '') === '/styleguide';
// /lab/call renders the call screen with fake participants. Development builds (or VITE_CALL_LAB=1) only: in a normal
// production build the condition is a compile-time false and the whole lab is dropped from the bundle.
const LAB_ENABLED = import.meta.env.DEV || import.meta.env.VITE_CALL_LAB === '1';
const CallLab = LAB_ENABLED ? lazy(() => import('./call/lab/CallLab')) : null;
const isCallLab = LAB_ENABLED && location.pathname.replace(/\/+$/, '') === '/lab/call';

// /lab/home renders the home, sign-in and waiting screens with fake data (see home/HomeLab.tsx). The condition is a
// build-time constant: a normal production build drops the import, so the lab and its fake data are not shipped.
const Lab = import.meta.env.DEV || import.meta.env.VITE_HOME_LAB === '1' ? lazy(() => import('./home/HomeLab')) : null;
const isLab = Lab !== null && location.pathname.replace(/\/+$/, '') === '/lab/home';

// "/" is the landing page and "/app/signup" the trial sign-up, both lazy chunks that cost the application nothing; every
// other path (/app, /admin) is the application. Old meeting links (/j/<code>, /?join=<code>, /?code=<code>) are sent to /app.
const legacy = legacyJoinRedirect(location);
if (legacy) location.replace(legacy);
// The application (call SDK, admin, OIDC) is a chunk of its own, so a visitor of the landing page does not download it.
const App = lazy(() => import('./App').then((m) => ({ default: m.App })));
const Landing = lazy(() => import('./landing/Landing'));
const Signup = lazy(() => import('./landing/Signup'));
// /privacy and /terms: static legal pages (a lazy chunk of their own, no sign-in, no backend call).
const PrivacyPage = lazy(() => import('./privacy/PrivacyPage').then((m) => ({ default: m.PrivacyPage })));
const legalKind = isPrivacyPath(location.pathname) ? 'privacy' : isTermsPath(location.pathname) ? 'terms' : null;
const isLanding = !legacy && isLandingPath(location.pathname);
const isSignup = isSignupPath(location.pathname);

watchSystemBars(); // Android shell only: status-bar icons that match the page theme
watchBackButton(); // Android shell only: Back closes the innermost layer, then goes back, then leaves the app

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isCallLab && CallLab ? (
      <Suspense fallback={null}>
        <CallLab />
      </Suspense>
    ) : isStyleguide && Styleguide ? (
      <Suspense fallback={null}>
        <Styleguide />
      </Suspense>
    ) : isLab && Lab ? (
      <Suspense fallback={null}>
        <Lab />
      </Suspense>
    ) : legalKind ? (
      <Suspense fallback={<BootScreen />}>
        <PrivacyPage kind={legalKind} />
      </Suspense>
    ) : isSignup ? (
      <Suspense fallback={<BootScreen />}>
        <Signup />
      </Suspense>
    ) : isLanding ? (
      <Suspense fallback={<BootScreen />}>
        <Landing />
      </Suspense>
    ) : legacy ? null : (
      <Suspense fallback={<BootScreen />}>
        <App />
      </Suspense>
    )}
  </StrictMode>,
);
