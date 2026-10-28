// SPDX-License-Identifier: Hippocratic-3.0
import type { PluginManifest, PluginClientApi } from '@babelr/plugin-sdk';

/**
 * Static list of in-tree plugins the client knows about. Each plugin
 * contributes a server-safe manifest (which the server also imports)
 * plus an optional client-entry setupClient that lives in a separate
 * file — keeping client-only JSX / bundler-style imports out of the
 * server's tsc pass.
 *
 * Keep alphabetized.
 */

import helloManifest from '@babelr/plugin-hello';
import pollsManifest from '@babelr/plugin-polls';
import plansManifest from '@babelr/plugin-plans';
import pmManifest from '@babelr/plugin-project-management';
import reviewManifest from '@babelr/plugin-review';
// blinds' server manifest imports node:fs, so the client takes its
// browser-safe clientManifest from client-entry instead.
import {
  clientManifest as blindsManifest,
  setupClient as blindsSetupClient,
} from '@babelr/plugin-blinds/client-entry';
import { setupClient as pollsSetupClient } from '@babelr/plugin-polls/client-entry';
import { setupClient as plansSetupClient } from '@babelr/plugin-plans/client-entry';
import { setupClient as pmSetupClient } from '@babelr/plugin-project-management/client-entry';
import { setupClient as reviewSetupClient } from '@babelr/plugin-review/client-entry';

export interface RegisteredPlugin {
  manifest: PluginManifest;
  /** Client-only setup. Wired here (on the client) rather than on the
   *  manifest so server tsc never traces into JSX-heavy client code. */
  setupClient?: (api: PluginClientApi) => Promise<void> | void;
}

export const registeredPlugins: RegisteredPlugin[] = [
  { manifest: blindsManifest, setupClient: blindsSetupClient },
  { manifest: helloManifest },
  { manifest: plansManifest, setupClient: plansSetupClient },
  { manifest: pollsManifest, setupClient: pollsSetupClient },
  { manifest: pmManifest, setupClient: pmSetupClient },
  { manifest: reviewManifest, setupClient: reviewSetupClient },
];
