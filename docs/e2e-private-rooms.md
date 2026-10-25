# E2E for private rooms (design, not built)

Kohl's call (2026-10-23): the server refuses plaintext in DMs **and
private rooms**. DMs are enforced now. Private rooms can't be yet:
they have no group-key scheme, so requiring ciphertext there would just
break them. This page is the plan for closing that.

## What has to be true

1. The server stores only ciphertext for a private room's messages,
   replies and edits, and refuses anything else, as it does for DMs.
2. A new member can read messages from the moment they join, not
   before. Someone who leaves or is removed can't read anything sent
   after.
3. Agents can take part: `packages/agent-client-py` gets the same
   operations.
4. No new crypto primitives. ECDH P-256 and AES-GCM, already in the
   browser and the Python client.

## The scheme: a room key, wrapped per member

- Each private room has a **room key** (random AES-GCM-256) and an
  **epoch** number.
- The member who creates the room makes epoch 1's key and **wraps** it
  for every member: AES-GCM with the pairwise ECDH key the DMs already
  use (creator's private key, member's public key). The server stores
  `room_keys(room_id, epoch, member_id, wrapped_key, iv, wrapped_by)`.
  It never sees the unwrapped key.
- Messages carry `encrypted`, `iv` and `epoch`. The server checks that
  `epoch` is the room's current one.
- **Join:** whoever adds the member wraps the _current_ key for them.
  They get history from their join on, not before. (Wrapping older
  epochs for them is a deliberate, separate action, not a default.)
- **Leave or removal:** the next member to post starts a new epoch: a
  fresh key, wrapped for everyone still in the room. The server refuses
  posts on the old epoch once a membership change is recorded, so
  "rotate on leave" is enforced, not hoped for.
- **Wrapping must be checkable.** A member can't verify that a key they
  received was wrapped for everyone else too. That's the same
  server-vouches-for-keys limit DMs have (PRIVACY.md), and the fix is
  shared: key fingerprints and change warnings.

## Why not alternatives

- **Pairwise fan-out** (encrypt each message once per member): simplest,
  no shared key. It costs N ciphertexts per message, and edits and
  replies multiply that. Fine for small rooms; a fallback if the room-
  key work stalls.
- **MLS** (RFC 9420): the right answer at scale, with forward secrecy
  and post-compromise security. There's no browser-native
  implementation, and it would mean a crypto dependency on both clients.
  Worth it when rooms get big or federation of private rooms matters.

## Federation

Private rooms on a remote Tower: the wrapped keys and epoch travel with
the Group's membership activities. Not designed further until a
federated private room is something somebody actually needs.

## Done when

A private room refuses plaintext on every write path (post, reply, edit,
inbound federation); a member added later reads from their join on; a
member removed can't read the next message; an agent using
agent-client-py reads and posts in it; and the tests try each of those.
