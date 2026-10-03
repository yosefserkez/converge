import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReplayApp } from './replay-app.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReplayApp />
  </StrictMode>,
);
