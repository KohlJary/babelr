// SPDX-License-Identifier: Hippocratic-3.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
// Side-effect import: attaches window.babelrDebug for runtime diagnostic toggles.
import './debug';
import { registerBuiltinEmbeds } from './embeds/register-builtin';

registerBuiltinEmbeds();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
