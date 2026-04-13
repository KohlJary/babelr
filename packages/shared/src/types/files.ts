// SPDX-License-Identifier: Hippocratic-3.0
import type { AuthorView } from './messages.js';

export interface FileView {
  id: string;
  serverId: string;
  uploader: AuthorView;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageUrl: string;
  slug: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  folderPath: string | null;
  /** OrderedCollection id for the file's comment thread (reuses the message pipeline). */
  chatId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Compact shape for [[file:slug]] embeds. Enough to render an inline
 * file card with type icon, name, size, and description preview.
 */
export interface FileEmbedView {
  id: string;
  slug: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageUrl: string;
  title: string | null;
  description: string | null;
  serverId: string;
  serverName: string | null;
  uploader: AuthorView;
  chatId: string;
}

export interface FileListResponse {
  files: FileView[];
}
