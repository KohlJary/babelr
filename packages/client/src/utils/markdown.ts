// SPDX-License-Identifier: Hippocratic-3.0
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked for chat messages
marked.setOptions({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(content: string): string {
  const raw = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre',
      'ul', 'ol', 'li', 'blockquote', 'a', 'span',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  });
}
