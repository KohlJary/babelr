// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import pmManifest from '@babelr/plugin-project-management';

describe('project-management plugin manifest', () => {
  it('declares the expected identity + migrations', () => {
    expect(pmManifest.id).toBe('project-management');
    expect(pmManifest.name).toBe('Project Management');
    expect(pmManifest.migrations).toHaveLength(1);
    expect(pmManifest.migrations?.[0].name).toBe('init');
  });

  it('migration 1 creates the three namespaced tables', () => {
    const up = pmManifest.migrations?.[0].up;
    expect(typeof up).toBe('string');
    const sql = up as string;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS plugin_pm_boards/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS plugin_pm_columns/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS plugin_pm_work_items/);
  });

  it('targets the correct Babelr version range', () => {
    expect(pmManifest.dependencies.babelr).toBe('^0.1.0');
  });
});
