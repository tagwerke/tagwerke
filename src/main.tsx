import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
// Split out of index.css (3.6k lines) so the two document surfaces can be worked on
// independently. Loaded after it, so these may override the base styles.
import './styles/documents.css';
import './styles/document-panel.css';
import App from './App.tsx';
import { dlog } from './util/dlog';

dlog('boot', `app runtime start — doc/CRDT trace ACTIVE (dev=${import.meta.env.DEV}). Note: React StrictMode double-invokes mounts.`);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Register the app-shell service worker in production only (dev uses Vite HMR,
// which a SW would interfere with).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW unsupported / blocked — the app still works, just without shell caching */
    });
  });
}
