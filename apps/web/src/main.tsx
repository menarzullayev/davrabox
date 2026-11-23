import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@davrabox/design-tokens/tokens.css';
import './fonts.css';
import './styles.css';
import './ui/ui.css';
import './home/home.css';

// /styleguide is a separate lazy chunk: it needs no sign-in and no backend, and costs the product screens nothing.
const Styleguide = lazy(() => import('./styleguide/Styleguide'));
const isStyleguide = location.pathname.replace(/\/+$/, '') === '/styleguide';

// /lab/home renders the home, sign-in and waiting screens with fake data (see home/HomeLab.tsx). The condition is a
// build-time constant: a normal production build drops the import, so the lab and its fake data are not shipped.
const Lab = import.meta.env.DEV || import.meta.env.VITE_HOME_LAB === '1' ? lazy(() => import('./home/HomeLab')) : null;
const isLab = Lab !== null && location.pathname.replace(/\/+$/, '') === '/lab/home';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isStyleguide ? (
      <Suspense fallback={null}>
        <Styleguide />
      </Suspense>
    ) : isLab && Lab ? (
      <Suspense fallback={null}>
        <Lab />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
