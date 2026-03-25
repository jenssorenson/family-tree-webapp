import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Suppress "ResizeObserver loop completed with undelivered notifications" —
// a harmless browser warning that fires when layout changes cascade faster
// than the browser can deliver resize notifications. The warning is spurious
// and causes no functional issues.
const _consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (msg.includes('ResizeObserver loop completed with undelivered notifications')) {
    return;
  }
  _consoleError(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
