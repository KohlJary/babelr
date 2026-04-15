// SPDX-License-Identifier: Hippocratic-3.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
// Side-effect import: attaches window.babelrDebug for runtime diagnostic toggles.
import './debug';
import { registerBuiltinEmbeds } from './embeds/register-builtin';
import { registerBuiltinViews } from './views/register-builtin';
import { initPlugins } from './plugins/plugin-loader';

registerBuiltinEmbeds();
registerBuiltinViews();
// Plugins load after built-ins so a plugin can override a built-in
// registration if it intentionally wants to (last-write-wins in the
// registries). Fire-and-forget — plugin init shouldn't block the UI,
// and individual failures are swallowed inside initPlugins.
void initPlugins();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
