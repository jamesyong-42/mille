// Phase 15.3 — mille-ui playground renderer entry.
//
// Imports `fx-port` FIRST so its window.addEventListener is registered
// before any other code has a chance to run, guaranteeing we catch the
// port that the preload forwards via window.postMessage.
//
// `@vibecook/mille-ui/tokens.css` is imported at the top of the renderer
// so the CSS-variable surface (colors, focus-ring tokens, density) is
// available everywhere. The playground's `index.css` layers local
// app-chrome styles on top.

import './fx-port';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@vibecook/mille-ui/tokens.css';
import '@vibecook/mille-ui/theme/minimal.css';
import './index.css';

// StrictMode intentionally omitted: its double-render interacts badly
// with useSyncExternalStore when the store notifies synchronously from
// a port 'message' event during the second render's subscribe phase.
// React 19 surfaces this as "Cannot update a component while rendering
// a different component". Production usage doesn't hit this.

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

createRoot(el).render(<App />);
