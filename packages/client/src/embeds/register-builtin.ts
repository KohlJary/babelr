// SPDX-License-Identifier: Hippocratic-3.0
import { createElement } from 'react';
import { registerEmbed } from './registry';
import type { EmbedInlineProps, EmbedPreviewProps } from './registry';
import { MessageEmbed } from '../components/MessageEmbed';
import { EventEmbed } from '../components/EventEmbed';
import FileEmbed from '../components/FileEmbed';
import { ImageEmbed } from '../components/ImageEmbed';
import { MessagePreview } from '../components/embeds/MessagePreview';
import { EventPreview } from '../components/embeds/EventPreview';
import { FilePreview } from '../components/embeds/FilePreview';
import { ImagePreview } from '../components/embeds/ImagePreview';
import { WikiPagePreview } from '../components/embeds/WikiPagePreview';
import { ManualPreview } from '../components/embeds/ManualPreview';

/**
 * Register the first-party embed kinds. Each kind contributes two
 * React components (Inline + Preview); the registry stores component
 * references and hosts mount them via createElement — which tracks
 * hooks against each mounted component instance. This removes the
 * earlier footgun where plugin authors who wrote
 * `renderInline: (props) => MyComponent(props)` invoked hooks outside
 * the reconciler and hit "rendered more hooks than previous render"
 * errors.
 */

function MessageInline({ slug, serverSlug, onClick }: EmbedInlineProps) {
  return createElement(MessageEmbed, { slug, serverSlug, onNavigate: onClick });
}
function MessagePreviewWrap({ slug, serverSlug }: EmbedPreviewProps) {
  return createElement(MessagePreview, { slug, serverSlug });
}

function EventInline({ slug, serverSlug, onClick }: EmbedInlineProps) {
  return createElement(EventEmbed, { slug, serverSlug, onNavigate: onClick });
}
function EventPreviewWrap({ slug, serverSlug }: EmbedPreviewProps) {
  return createElement(EventPreview, { slug, serverSlug });
}

function FileInline({ slug, serverSlug, onClick }: EmbedInlineProps) {
  return createElement(FileEmbed, { slug, serverSlug, onNavigate: onClick });
}
function FilePreviewWrap({ slug, serverSlug }: EmbedPreviewProps) {
  return createElement(FilePreview, { slug, serverSlug });
}

function ImageInline({ slug, serverSlug, onClick, actor }: EmbedInlineProps) {
  return createElement(ImageEmbed, { slug, serverSlug, actor, onClick });
}
function ImagePreviewWrap({ slug, serverSlug }: EmbedPreviewProps) {
  return createElement(ImagePreview, { slug, serverSlug });
}

/** Page refs are markdown links in content; the registered Inline is
 *  a fallback anchor for the rare case the host routes them here. */
function PageInline({ slug, onClick }: EmbedInlineProps) {
  return createElement(
    'a',
    {
      href: `#wiki/${slug}`,
      onClick: (e: { preventDefault: () => void }) => {
        e.preventDefault();
        onClick();
      },
    },
    slug,
  );
}
function PagePreviewWrap({ slug, serverId }: EmbedPreviewProps) {
  if (!serverId) {
    return createElement(
      'div',
      { className: 'embed-preview-locked' },
      'Wiki page preview requires a selected server',
    );
  }
  return createElement(WikiPagePreview, { slug, serverId });
}

function ManualInline({ slug, onClick }: EmbedInlineProps) {
  return createElement(
    'a',
    {
      href: `#manual/${slug}`,
      className: 'manual-embed-link',
      onClick: (e: { preventDefault: () => void }) => {
        e.preventDefault();
        onClick();
      },
    },
    slug,
  );
}
function ManualPreviewWrap({ slug }: EmbedPreviewProps) {
  return createElement(ManualPreview, { slug });
}

export function registerBuiltinEmbeds(): void {
  registerEmbed({
    kind: 'message',
    label: 'Message',
    navigateLabel: 'Go to message',
    Inline: MessageInline,
    Preview: MessagePreviewWrap,
    navigate: (args, ctx) => {
      void import('../api').then(async (api) => {
        try {
          const embed = await api.getMessageBySlug(args.slug, args.serverSlug);
          if (embed.channelId) {
            ctx.selectChannel(embed.channelId);
            ctx.closeView();
          }
        } catch {
          // ignore
        }
      });
    },
  });

  registerEmbed({
    kind: 'event',
    label: 'Event',
    navigateLabel: 'Open in Calendar',
    Inline: EventInline,
    Preview: EventPreviewWrap,
    navigate: (args, ctx) => {
      void import('../api').then(async (api) => {
        try {
          const embed = await api.getEventBySlug(args.slug, args.serverSlug);
          ctx.openView('calendar', { eventId: embed.id });
        } catch {
          // ignore
        }
      });
    },
  });

  registerEmbed({
    kind: 'file',
    label: 'File',
    navigateLabel: 'Open in Files',
    Inline: FileInline,
    Preview: FilePreviewWrap,
    navigate: (args, ctx) => {
      void import('../api').then(async (api) => {
        try {
          const embed = await api.getFileBySlug(args.slug, args.serverSlug);
          ctx.openView('files', { fileId: embed.id });
        } catch {
          // ignore
        }
      });
    },
  });

  registerEmbed({
    kind: 'image',
    label: 'Image',
    navigateLabel: 'Open in Files',
    Inline: ImageInline,
    Preview: ImagePreviewWrap,
    navigate: (args, ctx) => {
      void import('../api').then(async (api) => {
        try {
          const embed = await api.getFileBySlug(args.slug, args.serverSlug);
          ctx.openView('files', { fileId: embed.id });
        } catch {
          // ignore
        }
      });
    },
  });

  registerEmbed({
    kind: 'page',
    label: 'Wiki page',
    navigateLabel: 'Open in Wiki',
    Inline: PageInline,
    Preview: PagePreviewWrap,
    navigate: (args, ctx) => {
      ctx.openView('wiki', { slug: args.slug });
    },
  });

  registerEmbed({
    kind: 'manual',
    label: 'Manual',
    navigateLabel: 'Open in Manual',
    Inline: ManualInline,
    Preview: ManualPreviewWrap,
    navigate: (args, ctx) => {
      ctx.openView('manual', { slug: args.slug });
    },
  });
}
