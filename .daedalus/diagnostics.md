# Diagnostic Logging Registry

Central registry of every diagnostic `console.*` call site in the Babelr client,
along with the channel it should eventually be migrated to and a note about
what the log tells you and when it was useful.

The long-term plan: migrate every raw `console.log`/`console.warn` listed here
to the channel-based `debug(channel, ...)` helpers in `packages/client/src/debug.ts`.
Once migration is complete, the default production console will be quiet, and
anyone reporting a bug can turn on verbose logging for a single subsystem via:

```js
// In devtools:
babelrDebug.enable('voice')
babelrDebug.enable('*')       // everything
babelrDebug.disable('voice')
babelrDebug.list()            // show active channels
```

Or directly:

```js
localStorage.setItem('babelr:debug', 'voice,ws')
```

## Channels

Reserved channel names. Add new entries here before using them so channels
stay discoverable.

| Channel | Subsystem | Notes |
|---------|-----------|-------|
| `voice` | WebRTC voice channels | Peer connection state, ICE, track arrival, mic levels, RTP stats |
| `ws` | WebSocket messages | Raw ws send/receive, reconnects (future) |
| `i18n` | UI translation | Dict load, missing keys, fallback paths (future) |
| `federation` | ActivityPub delivery | Outbound signing, inbox verification, delivery failures (future — currently via server log only) |
| `e2e` | E2E encryption for DMs | Key exchange, encrypt/decrypt paths (future) |

## Active diagnostic call sites

Each entry documents a raw `console.*` call that exists in the codebase today
and has not yet been migrated to `debug()`. The "channel" column is the one
it will move to.

### `packages/client/src/hooks/useVoice.ts`

| Line | Level | Channel | What | Why it was added |
|------|-------|---------|------|------------------|
| ~380 | log | voice | `voice: local mic acquired` — logs track label/enabled/readyState | Prove getUserMedia gave us a live mic |
| ~395 | warn | voice | `voice: failed to start local mic meter` | AudioContext failure on exotic browsers |
| ~430 | log | voice | `voice: local mic level avg=X peak=Y` — runs every 2s | Diagnose silent-mic case (2026-04-11 Kohl's condenser died) |
| ~110 | log | voice | `voice: ontrack` — includes track enabled/muted/readyState and stream tracks | Prove remote track arrived at ontrack handler |
| ~130 | warn | voice | `voice: audio.play() rejected` | Distinguish autoplay policy block from "no track" |
| ~140 | log | voice | `voice: audio element state` — volume/muted/paused/currentTime at T+1.5s | Prove the element is actually playing vs stuck |
| ~155 | log | voice | `voice: inbound-rtp audio` — bytesReceived/packetsReceived/audioLevel at T+2.5s | Prove RTP media is actually flowing; audioLevel=0 with bytes>0 = DTX silence |
| ~165 | log | voice | `voice: outbound-rtp audio` | Compare send vs receive bytes |
| ~172 | log | voice | `voice: media-source audio (our mic)` — audioLevel, totalAudioEnergy | Ground truth for "is Chrome seeing mic input before WebRTC touches it" (Chrome only, undefined in Firefox) |
| ~185 | warn | voice | `voice: getStats failed` | Non-fatal; some browsers rate-limit getStats |
| ~260 | error | voice | `offer failed` | Unexpected createOffer/setLocalDescription error |
| ~295 | error | voice | `answer failed` | Unexpected setRemoteDescription/createAnswer error |
| ~310 | error | voice | `setRemoteDescription answer failed` | Unexpected setRemoteDescription error |
| ~323 | error | voice | `addIceCandidate failed` | ICE candidate rejection |

### `packages/server/src/federation/*.ts`, `packages/server/src/plugins/seed.ts`, etc.

Server-side logs go through Fastify's structured logger (`fastify.log.info` /
`.error` / `.warn`) and are already level-controlled via the log level set in
the server config. They are NOT part of this client-side diagnostic system.

Nothing to migrate on the server side — if we want finer-grained gating there,
we'd use Pino's child loggers with per-subsystem levels, which is a separate
exercise.

## Migration checklist

When migrating a site from raw `console.*` to `debug()`:

1. Add a row to the table above (or move it from "active" to "migrated")
2. Replace `console.log('voice: foo', ...)` with `debug('voice', 'foo', ...)`
3. Replace `console.warn('voice: ...', ...)` with `debugWarn('voice', ...)`
4. For expensive-to-compute diagnostic data, wrap in `if (debugEnabled('voice')) { ... }`
   so the cost is only paid when the channel is on
5. Verify the log still appears when `babelrDebug.enable('voice')` is set

## Triggering diagnostics from a user

If someone reports a voice bug:

```
Paste this into the devtools console, then reproduce the issue:

  babelrDebug.enable('voice')

Then send me the console output.
```

Once the channels are all migrated, this becomes a reliable triage workflow.
Until then, the `voice` channel logs are always-on (they predate the system),
so the instructions for triage are simply "send me the console output."
