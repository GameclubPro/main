import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/app';
import './styles.css';

const reportRendererError = (message: string) => {
  window.launcher?.reportRendererError?.(message);
};

window.addEventListener('error', (event) => {
  reportRendererError(event.error instanceof Error ? event.error.stack ?? event.error.message : event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportRendererError(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
});

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

queueMicrotask(() => {
  window.launcher?.reportRendererReady?.();
});
