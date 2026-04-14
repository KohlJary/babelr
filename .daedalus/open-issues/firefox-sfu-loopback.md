# Firefox + SFU + localhost loopback: ICE fails

## Symptom

Two browsers on the same machine joining a voice channel via `http://localhost:1111`:

- **Chromium**: ICE completes, audio/video flows, speaking indicators work.
- **Firefox**: both send and recv transports transition to `connectionstate: failed`. Firefox logs `ICE failed, add a STUN server and see about:webrtc for more details`. `about:webrtc` shows the PeerConnection with the remote candidate present but ICE state table empty.

## What we tried (all unsuccessful in FF loopback)

- `MEDIASOUP_LISTEN_IP=127.0.0.1` (default in dev)
- Explicit `MEDIASOUP_ANNOUNCED_IP=127.0.0.1`
- UDP-only transports (`enableTcp: false`)
- `iceServers` with public STUN on the client-side transport
- Firefox `about:config` tweaks: `media.peerconnection.ice.obfuscate_host_addresses=false`, `media.peerconnection.ice.loopback=true`

Environment: Arch Linux, PipeWire audio, Firefox from distro package, mediasoup 3.19.19, mediasoup-client 3.18.7 (with its built-in Firefox120 handler).

## Hypothesis

Firefox's WebRTC stack on Linux has stricter-than-spec behavior around loopback ICE when the remote is ICE-Lite (which mediasoup's WebRtcTransport always is). Chromium accepts it; Firefox silently rejects connectivity checks before they show up in `about:webrtc`.

This is a **local-dev-only** limitation. In production, mediasoup advertises a real public IP (`MEDIASOUP_ANNOUNCED_IP`), so candidates aren't loopback/private — Firefox should accept them normally.

## Validation plan

Deferred until the branch is deployed somewhere with a real public IP (staging). Parity test matrix to run then:

- [ ] Firefox + Firefox, 2 participants, audio
- [ ] Firefox + Chrome, 2 participants, audio
- [ ] Firefox webcam enable/disable/re-enable (the original bug — should be dead under SFU)
- [ ] Firefox screen-share enable/disable
- [ ] Firefox 3+ participants

If Firefox still fails against a real public-IP SFU, the mediasoup GitHub issues have several related threads around FF-specific handler tweaks worth trying before giving up on the handler.

## Non-blocking

Chromium works end-to-end. The SFU refactor shape is validated. This issue blocks *full* closure of `voice-video-reenable-bug` (needs Firefox parity testing) but not the Chrome path.
