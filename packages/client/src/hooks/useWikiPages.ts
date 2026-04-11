// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type {
  WikiPageSummary,
  WikiPageView,
  CreateWikiPageInput,
  UpdateWikiPageInput,
} from '@babelr/shared';
import * as api from '../api';

/**
 * Loads and mutates wiki pages for a given server. List view holds
 * summaries (no content body); `getPage` fetches the full markdown
 * for a selected slug.
 */
export function useWikiPages(serverId: string | null) {
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!serverId) {
      setPages([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.listWikiPages(serverId);
      setPages(res.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wiki');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const getPage = useCallback(
    async (slug: string): Promise<WikiPageView | null> => {
      if (!serverId) return null;
      try {
        const res = await api.getWikiPage(serverId, slug);
        return res.page;
      } catch {
        return null;
      }
    },
    [serverId],
  );

  const createPage = useCallback(
    async (input: CreateWikiPageInput): Promise<WikiPageView | null> => {
      if (!serverId) return null;
      const res = await api.createWikiPage(serverId, input);
      await reload();
      return res.page;
    },
    [serverId, reload],
  );

  const updatePage = useCallback(
    async (slug: string, input: UpdateWikiPageInput): Promise<WikiPageView | null> => {
      if (!serverId) return null;
      const res = await api.updateWikiPage(serverId, slug, input);
      await reload();
      return res.page;
    },
    [serverId, reload],
  );

  const deletePage = useCallback(
    async (slug: string): Promise<boolean> => {
      if (!serverId) return false;
      await api.deleteWikiPage(serverId, slug);
      await reload();
      return true;
    },
    [serverId, reload],
  );

  return { pages, loading, error, reload, getPage, createPage, updatePage, deletePage };
}
