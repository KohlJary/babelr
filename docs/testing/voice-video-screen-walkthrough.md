# Voice channels walkthrough — webcam + screen sharing

Manual test plan for validating the voice channels feature set end-to-end,
covering the core audio pipeline, per-participant webcam video, and per-participant
screen sharing. Written 2026-04-11, shipped in commits `428ea6a` (core), `8f78c24`
(polish: deafen/PTT/volume/speaking), `be8f375` (webcam), and `efe76a4` (screen
share).

**Who runs this:** you (Kohl) or anyone else triaging voice channel issues.
**When:** after any change touching `useVoice.ts`, `VoicePanel.tsx`, `VoiceTile.tsx`,
the WS voice handlers in `packages/server/src/routes/ws.ts`, or the voice room
management in `packages/server/src/plugins/ws.ts`.

## Prerequisites

- **Browser**: Firefox or Chromium. Not the Tauri desktop app — Arch Linux's
  webkit2gtk doesn't have WebRTC support compiled in, see roadmap item
  `desktop-voice-linux-webkit-gap` for context. This is fine, not a regression.
- **Two sessions**: two browser windows, OR one window + one incognito/private
  window, OR two different browsers. They must be logged in as two different
  users.
- **Working microphone**: most of these tests don't require audible output,
  but a few do. If your mic is dead (hi Kohl), skip the audio-output checks
  and verify via the devtools logs instead.
- **Working webcam**: tests 2–5 need any camera, built-in or USB.
- **Something to share**: tests 6+ use `getDisplayMedia`, which shows a native
  picker. A second monitor or a specific window/tab makes it easier to see
  the content on the other side.

## Common devtools signals

Keep the console open in both tabs. You'll see these log lines:

- `voice: local mic acquired [...]` — getUserMedia for audio succeeded
- `voice: local mic level avg=X peak=Y` — every 2 seconds, ground-truth for
  whether the mic is actually capturing signal
- `voice: ontrack video {from, slot, muted}` — a remote video or screen
  share track just arrived. `slot` is `'video'` or `'screen'`
- `voice: audio element state {...}` — the per-peer audio element's state
  about 1.5s after ontrack, confirms the audio sink is playing
- `voice: inbound-rtp audio {bytesReceived, packetsReceived, audioLevel}` —
  about 2.5s after ontrack, proves RTP media is flowing. `audioLevel=0` with
  growing `bytesReceived` means silence frames (DTX) which means the sender's
  mic isn't producing signal
- `voice: outbound-rtp audio {bytesSent, packetsSent}` — compare with inbound
  to pinpoint which direction is failing
- `voice: media-source audio (our mic)` — Chrome-only, the ground truth for
  what Chrome sees from the mic before WebRTC touches it

## Setup

1. Start the server: `npm run dev -w packages/server` (or whatever your
   normal workflow is).
2. Start the client: `npm run dev -w packages/client`.
3. Open Firefox/Chromium → `http://localhost:1111`.
4. Log in as user A.
5. Open a second window or incognito → same URL.
6. Log in as user B (you may need a second account; use
   `daedalus/create-user` or the register flow).
7. Join the same server on both windows, then select or create a voice
   channel. Voice channels show a 🔊 prefix in the channel sidebar. If one
   doesn't exist, create it from the `+ Create channel` button with the
   "Voice channel" toggle flipped on.
8. Click the voice channel in both windows. Grant mic permission when the
   browser prompts.

---

## Test 1 — Basic voice connectivity

**Action:** both windows join the voice channel. Don't touch any controls
yet.

**Expected:**
- Each window's `VoicePanel` shows a compact floating widget at the bottom-right
- Each window sees two tiles in the grid: the self tile and the peer tile
- Both tiles show the avatar fallback (colored circle with first letter), not
  video
- Connection status in the header reads "Connected"
- Peer tiles are fully opaque (not `.pending`)
- Speaking indicator rings are absent when no one is talking

**If your mic is working:** speak into the mic. A green ring should pulse
around your self tile. The peer tile should get a green ring on the OTHER
window while you speak.

**Devtools check:** `voice: inbound-rtp audio` shows `bytesReceived > 0` and
growing. If `audioLevel > 0`, the sender's mic is capturing signal. If it's
stuck at 0 while they speak, their mic is dead.

**Pass criteria:** both tabs connected, both tiles visible, no console errors.

---

## Test 2 — Webcam, single user on

**Action:** in window A, click the 📷 (camera) button in the VoicePanel
control row.

**Expected:**
- Browser prompts for camera permission (if first time in this session).
  Click "Allow."
- The 📷 button changes to 📹 and gains a green "active-on" background
- Window A's self tile immediately switches from avatar to showing your
  live webcam feed
- The video is mirrored (left-right flipped) — this is normal for
  self-views, matches every other video chat app

**Devtools check:** no new logs expected on the sender side. On the receiver
side (window B), watch for `voice: ontrack video {from, slot: 'video', muted}`.

**Pass criteria:** you can see yourself in your own self-tile.

---

## Test 3 — Webcam peer visibility

**Action:** switch focus to window B, look at the peer tile for user A.

**Expected:**
- User A's peer tile has transitioned from showing their avatar to showing
  their live webcam feed
- The video is NOT mirrored (peer video should look normal — it's mirrored
  only for self-views)
- The name and speaking indicator still work

**Devtools check:** in window B's console, `voice: ontrack video {from:
<userA-id>, slot: 'video'}` should have fired.

**Pass criteria:** window B sees user A's webcam.

---

## Test 4 — Webcam bidirectional

**Action:** in window B, click the 📷 button. Grant camera permission if
prompted.

**Expected:**
- Window B's self tile shows user B's mirrored webcam
- Window A's peer tile now shows user B's (un-mirrored) webcam
- Both windows now display two webcam tiles each
- All controls remain responsive

**Pass criteria:** each window sees both webcams at once.

---

## Test 5 — Webcam toggle off

**Action:** in window A, click the 📹 button to turn video off.

**Expected:**
- Window A's self tile reverts from video to avatar fallback
- Window B's peer tile for user A reverts to avatar fallback (via
  `track.onmute` on the remote side)
- The button returns to 📷 and loses its green background
- User B's webcam is unaffected and still visible in both windows
- No errors in console

**Devtools check:** window B should log a clear of the video slot — the
peer entry's `videoStream` becomes null (no explicit log for this, but
`voice: ontrack` will fire again if the remote later re-enables video).

**Pass criteria:** turning video off is symmetric — the peer tile updates
on both ends.

---

## Test 6 — Screen share, single user

**Action:** in window A, click the 🖥️ (screen) button in the VoicePanel.

**Expected:**
- Browser shows a native screen/window/tab picker. Pick any window
  that has recognizable content (a browser tab, a text editor, etc.)
- Click "Share"
- The 🖥️ button gains a green "active-on" background
- A NEW tile appears in window A's grid, alongside the existing self
  tile. The new tile has:
  - A 🖥️ prefix in the name overlay
  - A 16:9 aspect ratio (wider than webcam tiles which are 4:3)
  - Spans 2 grid columns
  - A slate-colored border (not green, since screen tiles don't show
    speaking state)
- Window A now shows a browser-level "Sharing your screen" bar somewhere
  (browser-dependent)

**Devtools check:** window B should log `voice: ontrack video {from:
<userA-id>, slot: 'screen'}`.

**Pass criteria:** window A has a new tile showing its own screen share,
window B has a new peer tile showing user A's screen.

---

## Test 7 — Screen share peer visibility

**Action:** switch to window B, look at the peer tiles.

**Expected:**
- User A now appears as TWO tiles in window B: the main tile (webcam or
  avatar) and a separate 🖥️-prefixed screen tile showing user A's
  shared window/screen content
- Both tiles are responsive (connection state, speaking indicator on the
  main tile)

**Pass criteria:** two tiles for user A in window B, one is the primary
voice tile and one is the screen share.

---

## Test 8 — Native "Stop sharing" bar

**Action:** in window A, click the browser's native "Stop sharing" button.
Where this appears varies by browser:
- **Chrome**: floating bar at the bottom of the screen
- **Firefox**: notification near the URL bar
- Might also be accessible from the screen picker's own UI if you trigger
  it from there

**Expected:**
- Window A's screen tile disappears from its own grid
- Window B's peer screen tile for user A also disappears
- The 🖥️ button in window A's VoicePanel reverts to inactive (loses
  green background)
- No errors

**Devtools check:** the `track.onended` handler we set up in
`toggleScreenShare` should fire, triggering the state flip. No explicit log
for this today but the UI state change is the confirmation.

**Pass criteria:** the browser's native stop bar and the VoicePanel state
stay in sync.

---

## Test 9 — Stop screen share from VoicePanel

**Action:** enable screen share in window A again. This time, click the
🖥️ button in the VoicePanel instead of the native bar.

**Expected:**
- Same as test 8: tile disappears on both sides, button deactivates,
  browser's native bar also disappears
- Both off-paths produce identical state transitions

**Pass criteria:** both off paths work identically.

---

## Test 10 — Webcam + screen share simultaneously

**Action:** in window A, enable webcam first, then enable screen share.

**Expected:**
- Window A's self tile shows the webcam video
- Window A has a SECOND self tile for the screen share
- Window B's peer tiles for user A show BOTH the webcam and screen share
- Both video feeds are playing simultaneously

**Pass criteria:** all four video streams (self webcam + self screen +
peer's view of both) are visible at once.

---

## Test 11 — Multi-user, all streams active

**Action:** with window A still running webcam + screen, enable webcam and
screen share in window B too.

**Expected:**
- Each window now shows FOUR tiles:
  1. Self webcam
  2. Self screen share
  3. Peer webcam
  4. Peer screen share
- Layout wraps gracefully (screen tiles span 2 columns each)
- No frame drops or stutters (within reason for a mesh topology)

**Bandwidth note:** this is the pathological case for P2P mesh. 4 video
streams × 2 peers means each client is encoding 2 and decoding 2. On most
laptops this works fine. If it doesn't, the SFU roadmap item
(`voice-channels-sfu`) is the long-term answer.

**Pass criteria:** all 4 streams render correctly and stay synced.

---

## Test 12 — Leave and rejoin

**Action:** in window A, click the "Leave" button in the VoicePanel.

**Expected:**
- Window A's VoicePanel disappears
- Window A's webcam and screen share stop (check with system tools
  if needed — e.g. the camera LED should turn off, the browser's
  "Sharing your screen" bar should disappear)
- Window B's peer tiles for user A disappear
- Window B's own self-view streams (webcam, screen) remain unaffected

**Action:** in window A, click the voice channel again to rejoin.

**Expected:**
- Clean rejoin — new self tile, new peer tile for user B (with whatever
  streams user B still has active)
- No ghost tiles, no orphan peer entries, no stale "pending" state

**Pass criteria:** leave/rejoin cycle is clean, no state leaks.

---

## Test 13 — Deafen

**Action:** in window A, click the 🔈 (deafen) button. It should switch to 🙉.

**Expected:**
- Window A stops hearing any audio from window B
- Window A's mic is also muted (deafen mutes both sides, matching Discord)
- The self tile in window A gains a 🙉 indicator
- Window B's peer tile for user A shows the 🔇 (muted) indicator since
  user A's mic is now implicitly off

**Action:** click 🙉 again to un-deafen.

**Expected:** both sides return to normal. Audio resumes.

**Pass criteria:** deafen mutes audio in both directions; un-deafen restores
both.

---

## Test 14 — Push-to-talk

**Action:** in window A, click the "PTT" button. Verify:
- Button turns green "active"
- A "Push-to-talk: hold ` to transmit" hint line appears under the controls
- User A's mic is now muted by default (the 🎤 button shows muted state)

**Action:** hold the backtick key (`` ` ``). While held:
- Mic is unmuted
- Window B should hear user A (if mics work)

Release the key — mic goes back to muted.

**Action:** click into a text input anywhere in the app and try the backtick
key there. Expected: it types a backtick, does NOT engage PTT. PTT only
works when focus is NOT in an input/textarea/contenteditable.

**Pass criteria:** PTT gates the mic correctly, backtick doesn't interfere
with text input.

---

## Test 15 — Per-peer volume

**Action:** in window A, hover over user B's tile in the voice panel. A
volume slider appears in the top-right corner.

**Action:** drag the slider to about 0.3 (30% volume).

**Expected:** user B's audio becomes noticeably quieter in window A only.
Window B's own audio output to other peers is unaffected.

**Action:** drag to 0. User B should become silent in window A.

**Action:** drag back to 1. Normal volume.

**Pass criteria:** volume slider adjusts the specific peer's playback
locally, doesn't affect anyone else.

---

## Common failure modes

### "Stuck on connecting"

- Check the console for errors on peer connection creation
- If you see "Can't find variable RTCPeerConnection", you're in the Tauri
  desktop app on Arch Linux. Use Firefox or Chromium instead. See
  `.daedalus/roadmap/index.json` → `desktop-voice-linux-webkit-gap`
- If the WS never opens, check the server is running and `/api/i18n/en`
  loads via curl

### "Video tile shows avatar but I turned camera on"

- Check `voice: ontrack video` fired on the receiver side with
  `slot: 'video'`
- If slot came back as 'screen', the transceiver ordering is somehow
  mismatched — this shouldn't happen but could indicate a wry/webkit2gtk
  edge case
- Check the sender's camera permission in the browser's per-site settings

### "No audio when speaking" (but the mic is real)

- Check `voice: local mic level avg=X peak=Y`. If it stays at 0, the mic
  isn't producing signal (OS-level issue, not Babelr)
- Check `voice: inbound-rtp audio audioLevel`. If it's 0 with packets
  flowing, the sender's mic is silent (same issue, other side)
- If `audioLevel > 0` but you still hear nothing, check the audio element's
  state log — `paused: false, currentTime: > 0` means playback is happening,
  likely a system audio routing issue

### "Screen share is black / won't start"

- The user may have cancelled the screen picker — this is silent by design,
  not an error
- In Firefox, screen sharing requires HTTPS in production (works on
  localhost for dev)
- Check that `getDisplayMedia` is actually available — very old browsers
  don't have it. Should not be an issue in 2026

### "Peer tile vanishes randomly mid-call"

- The peer's WS closed. Check their browser console for connection errors
- If it reconnects, the tile should come back via `voice:participant-joined`

---

## Regression checklist

If you're running this after a code change, also verify:

- [ ] No new console errors in either tab during any of the tests
- [ ] Typecheck passes: `npx tsc --noEmit -p packages/client`
- [ ] `npm test` passes (38 tests at the time of writing)
- [ ] Both tabs can reload and rejoin without leaving orphan peer entries
  in the server's in-memory voice room state

## Updates to this doc

If you find a bug or an unclear step, edit this file directly and commit
alongside the code change. This is a living document, not a snapshot.
