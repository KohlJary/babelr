// SPDX-License-Identifier: Hippocratic-3.0
import type { PluginManifest } from '@babelr/plugin-sdk';

/**
 * Static list of in-tree plugins the client knows about. Matches the
 * server-side registered.ts — each plugin that ships in-tree adds an
 * entry here so the plugin loader can call its setupClient() at boot.
 *
 * Imports should be static on the server side (manifest parsing) but
 * setupClient specifically must be safe to call in the browser — plugin
 * authors should keep any React / DOM code inside setupClient's body
 * via lazy imports, so the top-level manifest stays runtime-agnostic.
 *
 * Keep alphabetized.
 */

import helloManifest from '@babelr/plugin-hello';

const manifests: PluginManifest[] = [helloManifest];

export const registeredPlugins: PluginManifest[] = manifests;
