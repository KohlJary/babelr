// SPDX-License-Identifier: MIT
import type { PluginManifest } from '@babelr/plugin-sdk';

/**
 * Static list of in-tree plugins the server knows about. Phase 5 will
 * replace this with runtime scanning of an installed-plugins directory;
 * until then, adding a plugin means adding its import + entry here.
 *
 * Imports go through the plugin's package.json main entry — which in
 * turn points at the plugin's manifest.ts. Each plugin is a workspace
 * package at packages/plugins/<id>/.
 *
 * Keep the list alphabetized.
 */

import blindsManifest from '@babelr/plugin-blinds';
import deckManifest from '@babelr/plugin-deck';
import helloManifest from '@babelr/plugin-hello';
import pollsManifest from '@babelr/plugin-polls';
import plansManifest from '@babelr/plugin-plans';
import pmManifest from '@babelr/plugin-project-management';
import reviewManifest from '@babelr/plugin-review';
import roomManifest from '@babelr/plugin-room';
import recordManifest from '@babelr/plugin-record';
import musicManifest from '@babelr/plugin-music';
import panelManifest from '@babelr/plugin-panel';
import daybookManifest from '@babelr/plugin-daybook';
import remembersManifest from '@babelr/plugin-remembers';

const manifests: PluginManifest[] = [
  blindsManifest,
  deckManifest,
  helloManifest,
  plansManifest,
  pollsManifest,
  pmManifest,
  reviewManifest,
  roomManifest,
  recordManifest,
  musicManifest,
  panelManifest,
  daybookManifest,
  remembersManifest,
];

export const registeredPlugins: PluginManifest[] = manifests;
