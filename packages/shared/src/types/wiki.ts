// SPDX-License-Identifier: Hippocratic-3.0
import type { AuthorView } from './messages.js';

export interface WikiPageView {
  id: string;
  serverId: string;
  slug: string;
  title: string;
  /** Markdown source */
  content: string;
  tags: string[];
  /** Parent page id for nesting. Null = root-level page. */
  parentId: string | null;
  /** Sort order within siblings. Lower = first. */
  position: number;
  /** OrderedCollection id for the page's comment thread. */
  chatId: string | null;
  createdBy: AuthorView;
  lastEditedBy: AuthorView;
  createdAt: string;
  updatedAt: string;
}

/**
 * Summary form returned by list endpoints — no content body, to keep
 * list responses small. Clients fetch the single-page endpoint for the
 * full markdown.
 */
export interface WikiPageSummary {
  id: string;
  serverId: string;
  slug: string;
  title: string;
  tags: string[];
  parentId: string | null;
  position: number;
  lastEditedBy: AuthorView;
  updatedAt: string;
}

export interface WikiPageRevisionView {
  id: string;
  pageId: string;
  revisionNumber: number;
  title: string;
  content: string;
  editedBy: AuthorView;
  editedAt: string;
  summary: string | null;
}

export interface CreateWikiPageInput {
  /** Optional — if omitted, server derives from title */
  slug?: string;
  title: string;
  content?: string;
  tags?: string[];
  /** Parent page id for nesting. Omit or null for root-level. */
  parentId?: string | null;
  /** Sort position among siblings. Defaults to 0. */
  position?: number;
}

export interface UpdateWikiPageInput {
  title?: string;
  content?: string;
  tags?: string[];
  /** Short message describing the change, stored on the revision row */
  summary?: string;
  /** Move the page to a new parent (null = root). */
  parentId?: string | null;
  /** Reorder within siblings. */
  position?: number;
}

/**
 * Per-server wiki-level settings. Currently just the home page slug;
 * this shape is intentionally a container so future settings (default
 * edit permission, default tag, etc.) can join it without another
 * round of type plumbing.
 */
export interface WikiSettingsView {
  homeSlug: string | null;
}

export interface UpdateWikiSettingsInput {
  homeSlug?: string | null;
}

export interface WikiSettingsResponse {
  settings: WikiSettingsView;
}

export interface WikiPageListResponse {
  pages: WikiPageSummary[];
}

export interface WikiPageResponse {
  page: WikiPageView;
}

/**
 * An incoming reference to a wiki page, either from another page or
 * from a chat message. Returned by the backlinks endpoint.
 */
export interface WikiBacklinkView {
  sourceType: 'page' | 'message';
  /** Populated when sourceType === 'page' */
  page?: WikiPageSummary;
  /** Populated when sourceType === 'message' */
  message?: {
    id: string;
    channelId: string;
    channelName: string | null;
    author: AuthorView;
    content: string;
    createdAt: string;
  };
  createdAt: string;
}

export interface WikiBacklinksResponse {
  backlinks: WikiBacklinkView[];
}
