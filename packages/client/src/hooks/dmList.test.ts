// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import type { DMConversation, MessageView } from '@babelr/shared';
import { applyDMMessage } from './dmList';

const dm = (id: string, extra: Partial<DMConversation> = {}): DMConversation => ({
  id,
  participants: [],
  ...extra,
});
const msg = (id: string, channelId: string, extra: Partial<MessageView> = {}): MessageView => ({
  id,
  channelId,
  content: 'ciphertext',
  authorId: 'juniper',
  published: '2026-11-25T12:00:00Z',
  ...extra,
});

describe('applyDMMessage', () => {
  it('a message from someone else: new preview, one more unread, moved to the top', () => {
    const list = [dm('a'), dm('b', { unread: 1 })];
    const out = applyDMMessage(list, msg('m1', 'b'), { mine: false, onScreen: false });
    expect(out.map((c) => c.id)).toEqual(['b', 'a']);
    expect(out[0].lastMessage?.id).toBe('m1');
    expect(out[0].unread).toBe(2);
  });

  it('the DM on screen reads it; my own message is never unread', () => {
    const list = [dm('a', { unread: 3 })];
    expect(applyDMMessage(list, msg('m1', 'a'), { mine: false, onScreen: true })[0].unread).toBe(0);
    expect(applyDMMessage(list, msg('m1', 'a'), { mine: true, onScreen: false })[0].unread).toBe(3);
  });

  it('ignores thread replies, other channels, and a message already applied', () => {
    const list = [dm('a', { lastMessage: msg('m1', 'a') })];
    const how = { mine: false, onScreen: false };
    expect(applyDMMessage(list, msg('r', 'a', { inReplyTo: 'm1' }), how)).toBe(list);
    expect(applyDMMessage(list, msg('x', 'elsewhere'), how)).toBe(list);
    expect(applyDMMessage(list, msg('m1', 'a'), how)).toBe(list);
  });
});
