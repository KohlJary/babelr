// SPDX-License-Identifier: Hippocratic-3.0
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import helloManifest from '@babelr/plugin-hello';

const manifests: PluginManifest[] = [helloManifest];

export const registeredPlugins: PluginManifest[] = manifests;
