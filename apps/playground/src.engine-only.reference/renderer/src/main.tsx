// Import fx-port FIRST so its window.addEventListener is registered
// before any other code has a chance to run, guaranteeing we catch the
// port that the preload forwards via window.postMessage.
import './fx-port';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// StrictMode intentionally omitted: its double-render interacts badly
// with useSyncExternalStore when the store notifies synchronously from
// a port 'message' event during the second render's subscribe phase.
// React 19 surfaces this as "Cannot update a component while rendering
// a different component". Production usage doesn't hit this.

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

createRoot(el).render(<App />);
