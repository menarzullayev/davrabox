import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@davrabox/design-tokens/tokens.css';
import './fonts.css';
import './styles.css';
import './ui/ui.css';

// /styleguide is a separate lazy chunk: it needs no sign-in and no backend, and costs the product screens nothing.
const Styleguide = lazy(() => import('./styleguide/Styleguide'));
const isStyleguide = location.pathname.replace(/\/+$/, '') === '/styleguide';
// /lab/call renders the call screen with fake participants. Development builds (or VITE_CALL_LAB=1) only: in a normal
// production build the condition is a compile-time false and the whole lab is dropped from the bundle.
const LAB_ENABLED = import.meta.env.DEV || import.meta.env.VITE_CALL_LAB === '1';
const CallLab = LAB_ENABLED ? lazy(() => import('./call/lab/CallLab')) : null;
const isCallLab = LAB_ENABLED && location.pathname.replace(/\/+$/, '') === '/lab/call';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isCallLab && CallLab ? (
      <Suspense fallback={null}>
        <CallLab />
      </Suspense>
    ) : isStyleguide ? (
      <Suspense fallback={null}>
        <Styleguide />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
