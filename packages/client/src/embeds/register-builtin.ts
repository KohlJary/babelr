// SPDX-License-Identifier: Hippocratic-3.0
import { createElement } from 'react';
import { registerEmbed } from './registry';
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
 * Register the first-party embed kinds. Called once at app boot from
 * main.tsx. The plugin system (when shipped) will call registerEmbed
 * with the same shape from each plugin's manifest.
 */
export function registerBuiltinEmbeds(): void {
  registerEmbed({
    kind: 'message',
    label: 'Message',
    navigateLabel: 'Go to message',
    renderInline: (props) =>
      createElement(MessageEmbed, {
        slug: props.slug,
        serverSlug: props.serverSlug,
        onNavigate: () => props.onClick(),
      }),
    renderPreview: (props) =>
      createElement(MessagePreview, { slug: props.slug, serverSlug: props.serverSlug }),
    navigate: (args, ctx) => {
      // Resolve message → channel by re-fetching, then navigate to its
      // channel. The inline embed has a channelId in its view; we rely
      // on the same fetch path. Falls back to no-op if locked.
      void import('../api').then(async (api) => {
        try {
          const embed = await api.getMessageBySlug(args.slug, args.serverSlug);
          if (embed.channelId) {
            ctx.selectChannel(embed.channelId);
            ctx.setMainView('chat');
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
    renderInline: (props) =>
      createElement(EventEmbed, {
        slug: props.slug,
        serverSlug: props.serverSlug,
        onNavigate: () => props.onClick(),
      }),
    renderPreview: (props) =>
      createElement(EventPreview, { slug: props.slug, serverSlug: props.serverSlug }),
    navigate: (args, ctx) => {
      void import('../api').then(async (api) => {
        try {
          const embed = await api.getEventBySlug(args.slug, args.serverSlug);
          ctx.setCalendarInitialEventId(embed.id);
          ctx.setMainView('calendar');
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
    renderInline: (props) =>
      createElement(FileEmbed, {
        slug: props.slug,
        serverSlug: props.serverSlug,
        onNavigate: () => props.onClick(),
      }),
    renderPreview: (props) =>
      createElement(FilePreview, { slug: props.slug, serverSlug: props.serverSlug }),
    navigate: (args, ctx) => {
      void import('../api').then(async (api) => {
        try {
          const embed = await api.getFileBySlug(args.slug, args.serverSlug);
          ctx.setFilesInitialFileId(embed.id);
          ctx.setMainView('files');
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
    renderInline: (props) =>
      createElement(ImageEmbed, {
        slug: props.slug,
        serverSlug: props.serverSlug,
        actor: props.actor,
        onClick: () => props.onClick(),
      }),
    renderPreview: (props) =>
      createElement(ImagePreview, { slug: props.slug, serverSlug: props.serverSlug }),
    navigate: (args, ctx) => {
      void import('../api').then(async (api) => {
        try {
          const embed = await api.getFileBySlug(args.slug, args.serverSlug);
          ctx.setFilesInitialFileId(embed.id);
          ctx.setMainView('files');
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
    // Inline page refs are markdown links; this stub is unused but kept
    // for symmetry. The render pipeline still routes page refs through
    // markdown for in-line readability.
    renderInline: (props) =>
      createElement(
        'a',
        {
          href: `#wiki/${props.slug}`,
          onClick: (e: { preventDefault: () => void }) => {
            e.preventDefault();
            props.onClick();
          },
        },
        props.slug,
      ),
    renderPreview: (props) => {
      if (!props.serverId) {
        return createElement(
          'div',
          { className: 'embed-preview-locked' },
          'Wiki page preview requires a selected server',
        );
      }
      return createElement(WikiPagePreview, { slug: props.slug, serverId: props.serverId });
    },
    navigate: (args, ctx) => {
      ctx.setWikiInitialSlug(args.slug);
      ctx.setMainView('wiki');
    },
  });

  registerEmbed({
    kind: 'manual',
    label: 'Manual',
    navigateLabel: 'Open in Manual',
    renderInline: (props) =>
      createElement(
        'a',
        {
          href: `#manual/${props.slug}`,
          className: 'manual-embed-link',
          onClick: (e: { preventDefault: () => void }) => {
            e.preventDefault();
            props.onClick();
          },
        },
        props.slug,
      ),
    renderPreview: (props) => createElement(ManualPreview, { slug: props.slug }),
    navigate: (args, ctx) => {
      ctx.openManualSlug(args.slug);
    },
  });
}
