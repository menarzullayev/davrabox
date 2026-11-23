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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isStyleguide ? (
      <Suspense fallback={null}>
        <Styleguide />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
