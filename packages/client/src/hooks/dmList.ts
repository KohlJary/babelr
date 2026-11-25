// SPDX-License-Identifier: MIT
import type { DMConversation, MessageView } from '@babelr/shared';

/**
 * A new message in one of the DMs in `list`: it becomes the preview, the
 * conversation moves to the top, and it counts as unread unless it's
 * mine or that DM is on screen (which reads it). A thread reply, a
 * message for a DM not in the list, or one already applied changes nothing.
 */
export function applyDMMessage(
  list: DMConversation[],
  message: MessageView,
  how: { mine: boolean; onScreen: boolean },
): DMConversation[] {
  if (message.inReplyTo) return list;
  const i = list.findIndex((c) => c.id === message.channelId);
  if (i < 0) return list;
  const c = list[i];
  if (c.lastMessage?.id === message.id) return list;
  const unread = how.onScreen ? 0 : how.mine ? c.unread : (c.unread ?? 0) + 1;
  const next: DMConversation = { ...c, lastMessage: message, unread };
  return [next, ...list.slice(0, i), ...list.slice(i + 1)];
}
