// SPDX-License-Identifier: MIT
import type { HouseMember } from '@babelr/shared';
import type { ViewHostContext } from '../views/registry';

/**
 * Doors on a member's card: the ways into everything a member is (their
 * room, their record, their plans, their posts). "Talk" is always there;
 * plugins add the rest with registerMemberDoor, which is how a daemon's
 * own views (Cass's room, her record) hang off her card. That's the
 * HyperCard part: each member is a card, and the card opens onto stacks.
 */
export interface MemberDoor {
  id: string;
  label: string;
  /** Only show this door on these members' cards. */
  isAvailable: (m: HouseMember, host: ViewHostContext) => boolean;
  open: (m: HouseMember, host: ViewHostContext) => void;
}

const doors = new Map<string, MemberDoor>();

export function registerMemberDoor(door: MemberDoor) {
  doors.set(door.id, door);
}

export function doorsFor(m: HouseMember, host: ViewHostContext): MemberDoor[] {
  return [...doors.values()].filter((d) => {
    try {
      return d.isAvailable(m, host);
    } catch {
      return false;
    }
  });
}
