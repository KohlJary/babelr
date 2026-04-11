# Open issue — Voice: video re-enable doesn't display on receiver

**Status**: in progress, not resolved. Paused 2026-04-11 evening.
**Latest commit touching this**: `7c4da1b` — voice: don't renegotiate on disable, only on enable
**Branch**: `main` (all debugging has been shipped to main as we go)
**Files**: primarily `packages/client/src/hooks/useVoice.ts`

## Bug description

In a voice channel with two users where user A toggles their webcam:

1. **First enable** — user A's webcam appears correctly in user B's peer tile ✓
2. **Disable** — user A's tile reverts to avatar on both ends ✓
3. **Second enable** — user A's webcam does NOT appear on user B's peer tile ✗

On user A's side, their self-view always works correctly. The bug is
specific to what user B sees after the second toggle.

Same failure mode applies to screen share re-enable.

## User-observed last state

User (Kohl) confirmed from the receiver's devtools reconcile scan logs:
> "slotVideo is staying false after the re-enable, I see it as true when
> the video was up and running"

Meaning the receiver's React state never flips back to `hasVideo: true`
after the second enable. Either:
- `track.muted` is stuck at `true` on the receiver's track, OR
- `track.readyState` is `'ended'`, which is unrecoverable on the
  receiver side without a brand-new transceiver

## What's been tried, in order

Each attempt was shipped as its own commit so we can bisect or read
the history:

1. **`6d94834`** — Added manual renegotiation in `toggleVideo` and
   `toggleScreenShare`. Needed because `replaceTrack` alone wasn't
   activating the SDP direction after initial negotiation happened
   without any tracks attached. Fixed the first-enable case.

2. **`b154c1f`** — Skip populating the slot during `ontrack` when
   `track.muted === true`, since the receiver side creates muted
   placeholder tracks for transceivers whose remote senders are
   empty. Fixed the phantom screen-share tile.

3. **`572bffd`** — Layout fix, not routing related. Voice panel grid
   was collapsing to 1 column at narrow widths, causing screen
   tile's `grid-column: span 2` to overflow.

4. **`41a3c08`** — Split the tile grid into a webcams section and a
   separate screen-tiles section. Bypasses grid-span + aspect-ratio
   conflicts.

5. **`cbe56c8`** — Added `reconcilePeerSlots` helper that scans the
   PC's transceivers directly and syncs slot state from
   `receiver.track.readyState` and `receiver.track.muted`. Called
   it from the `voice:offer` and `voice:answer` handlers after
   `setLocalDescription`, because `onunmute` was proving
   unreliable.

6. **`4ee64ed`** — Switched routing from transceiver-identity
   matching to index-based routing (position in
   `pc.getTransceivers().filter(kind === 'video')`). Was trying to
   fix the "screen share lands in webcam slot" case.

7. **`8b1e41f`** — Layered routing: identity match first, then
   index fallback, then last-resort empty-slot-wins. Plus
   optional chaining on `t.receiver.track?.kind` because the
   filter was crashing the whole `ontrack` handler when any
   transceiver had a null receiver track.

8. **`6242a25`** — Added periodic reconcile every 500ms via the
   rAF loop (piggybacking on the speaking indicator tick). Was
   trying to catch the re-enable case where `onunmute` doesn't
   fire reliably.

9. **`d8c45f7`** — Made the periodic reconcile populate-only
   (`canClear: false`). The previous version was oscillating —
   `track.muted` polls from rAF produce transient "muted" readings
   that triggered clears, and the slot state flipped every 500ms.

10. **`5e0c7db`** — Diagnostic logging only: `voice: reconcile scan`
    every 500ms dumps receiver track state per peer, and
    `onmute`/`onunmute`/`onended` events each log when they fire.

11. **`7c4da1b`** — Removed renegotiation on DISABLE path of both
    `toggleVideo` and `toggleScreenShare`. Theory: the disable-time
    renegotiation was driving the receiver's transceiver into a
    state (probably `track.readyState === 'ended'` or a stuck
    direction) that no subsequent re-enable renegotiation could
    recover from. **Untested** — shipped just before pausing.

## Current state of useVoice.ts

- Layered routing in `ontrack`: identity → index → last-resort
- Reconcile has `canClear` param (true in explicit paths, false in
  periodic rAF path)
- Enable path: `replaceTrack(track)` then `renegotiateAllPeers()`
- Disable path: `replaceTrack(null)`, stop local tracks, NO renegotiation
- Periodic reconcile scan runs every 500ms with `canClear: false`
- Verbose logging: `voice: reconcile scan`, `voice: track onmute/onunmute/onended`, `voice: populate/clear` with reason
- Glare handling via `makingOffer` flag + polite/impolite peer by
  lexical actor id comparison

## Likely next steps

1. **Test `7c4da1b` fresh tomorrow.** It might already be fixed. The
   reasoning is sound — we were driving the receiver into a bad state
   that the re-enable couldn't undo. Just removing that trigger might
   be enough.

2. **If still broken**, the reconcile scan logs will show exactly
   what `track.readyState` and `track.muted` report on the receiver
   side during the failing re-enable window. Key questions:
   - Is `readyState === 'ended'`? If so, the track is dead and we
     need a different strategy (new transceiver on each enable, or
     use `pc.addTrack`/`removeTrack` instead of `replaceTrack`).
   - Is `muted` stuck at `true` forever? If so, there's a
     browser-specific quirk and we probably need to do something
     weirder, like force-dispatch a `playsinline` / re-attach the
     receiver's track to a fresh `MediaStream`.

3. **Alternative strategies to consider** if the current approach
   can't be made to work:
   - **Don't pre-allocate transceivers.** Use `pc.addTrack` on
     enable (creates a fresh transceiver each time) and
     `pc.removeTrack` on disable. More renegotiation but simpler
     state machine.
   - **Recreate the peer connection on toggle.** Heavy-handed but
     guaranteed to work. Closes the PC, reopens it with the new
     track set. Would drop audio briefly, which is bad UX.
   - **Perfect negotiation** fully implemented (we have a light
     version). Would handle glare better but probably doesn't
     fix this specific bug.
   - **Use a different browser to test.** Maybe Firefox doesn't
     have this problem, which would confirm it's Chrome-specific
     and we can add a Chrome workaround.

4. **Check if this happens with the receiver being in Chrome vs
   Firefox.** If Firefox works and Chrome doesn't, we know it's
   Chrome-specific.

## What NOT to do

- Don't re-introduce renegotiation on disable. That made it worse.
- Don't blindly add more reconcile loops. The current one is
  populate-only for a reason (oscillation).
- Don't delete the verbose logging until the bug is confirmed
  fixed AND a manual test walkthrough (see
  `docs/testing/voice-video-screen-walkthrough.md`) passes.

## Manual repro

1. Open Babelr in Firefox or Chromium (NOT Tauri on Linux — see
   `desktop-voice-linux-webkit-gap` roadmap item)
2. Open a second window/incognito as a second user
3. Both join the same voice channel
4. User A: click 📷 to enable webcam. Confirm user B sees it.
5. User A: click 📹 to disable webcam. Confirm user B sees the
   avatar again.
6. User A: click 📷 again.
7. **Expected**: user B sees user A's webcam again.
8. **Actual (bug)**: user B still sees the avatar.

## Context and team notes

- This bug is blocking a clean voice-channels story for launch.
- Kohl is on Arch Linux, mic hardware is dead (separate issue,
  waiting on new condenser mic). Testing video works fine.
- We've burned ~2 hours on this bug across several fix attempts
  and paused to return fresh.
- Frustration level: elevated. Pick up tomorrow with a clear head.
