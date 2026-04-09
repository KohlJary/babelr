# Babelr Manual Testing Checklist

**Project:** Babelr — federated chat with tone-preserving LLM translation
**Last updated:** 2026-04-09

Automated tests cover: unit logic for auth, channel, DM, and server route handlers, federation JSON-LD serialization, HTTP signature signing/verification, and key generation. This checklist targets the seams those tests cannot reach: browser behavior, WebSocket liveness, translation pipeline output quality, E2E crypto across two browser sessions, UI state transitions, and real deployment plumbing.

---

## Prerequisites

- PostgreSQL running and accessible
- Server running: `npm run dev:server` (port 3000) or Docker (`docker compose up`)
- Client running: `npm run dev:client` (port 5173) or served via Docker
- Two separate browsers or browser profiles available (Browser A and Browser B)
- Optional for cloud translation tests: a valid Anthropic API key
- Optional for federation tests: a second Babelr instance or Mastodon

---

## 1. Authentication (16 tests)

- [ ] Registration form shown on first visit
- [ ] Username < 3 chars rejected
- [ ] Username with spaces/special chars rejected
- [ ] Password < 12 chars rejected
- [ ] Invalid email rejected
- [ ] Successful registration lands in chat view
- [ ] Session cookie `babelr_sid` present with HttpOnly flag
- [ ] Duplicate username returns 409
- [ ] Duplicate email returns 409
- [ ] First registered user on fresh DB becomes instance admin
- [ ] First user auto-joined to default server as owner
- [ ] Logout clears cookie and returns to auth form
- [ ] Refresh after logout doesn't restore session
- [ ] Login with correct credentials works
- [ ] Login with wrong password shows "Invalid credentials"
- [ ] Hard refresh while logged in preserves session

## 2. Servers (13 tests)

- [ ] Default "Babelr" server and #general channel seeded on first boot
- [ ] Create server modal opens from "+" button
- [ ] Empty server name rejected
- [ ] New server appears in sidebar immediately
- [ ] #general channel auto-created in new server
- [ ] Creator has "owner" role
- [ ] Discover list shows servers with member counts and join status
- [ ] Join button adds user as member
- [ ] Joining already-joined server is idempotent
- [ ] Member can leave a server
- [ ] Owner cannot leave ("Server owner cannot leave")
- [ ] Invite link creation works (with optional maxUses/expiry)
- [ ] Invite link join works and respects limits

## 3. Channels (9 tests)

- [ ] Create channel with name only (uncategorized)
- [ ] Create channel with category groups under collapsible header
- [ ] Create private channel — visible only to invited members
- [ ] Non-invited member cannot see private channel
- [ ] Non-invited member gets 403 on private channel messages
- [ ] Invite user to private channel makes it visible
- [ ] Glossary editor opens and saves terms
- [ ] Glossary persists across reload
- [ ] Empty glossary clears all entries

## 4. Messaging (18 tests)

- [ ] Enter key sends message
- [ ] Shift+Enter inserts newline
- [ ] Message appears in real-time via WebSocket
- [ ] Second user receives message without refresh
- [ ] Edit own message shows "(edited)" badge
- [ ] Cannot edit another user's message (403)
- [ ] Delete own message removes it (tombstone)
- [ ] Admin/moderator can delete any member's message
- [ ] Regular member cannot delete others' messages
- [ ] `**bold**` renders bold
- [ ] `` `inline code` `` renders monospace
- [ ] Code blocks render with styling
- [ ] `> blockquote` renders as blockquote
- [ ] Links render as clickable anchors
- [ ] `<script>` tags are sanitized (not executed)
- [ ] File upload under 10MB succeeds
- [ ] File upload over 10MB returns 400
- [ ] Initial load shows 50 messages, "load more" fetches older

## 5. Real-Time (9 tests)

- [ ] WebSocket connects on login, header shows "connected"
- [ ] Reconnects automatically after network loss
- [ ] Unauthenticated WS closed with 4001
- [ ] Typing indicator shows "(User) is typing" in other browser
- [ ] Typing indicator disappears after ~3 seconds
- [ ] Typing clears when message is sent
- [ ] Two simultaneous typers show "X and Y are typing"
- [ ] Sender doesn't see own typing indicator
- [ ] Presence dots update (online/away/offline)

## 6. Reactions (7 tests)

- [ ] Emoji picker opens on "+" button
- [ ] Selecting emoji adds reaction with count
- [ ] Own reaction highlighted
- [ ] Second user same emoji increments count
- [ ] Clicking own reaction removes it (toggle)
- [ ] Reactions broadcast in real-time
- [ ] Duplicate reaction prevented server-side

## 7. Mentions (5 tests)

- [ ] Typing "@" shows autocomplete dropdown
- [ ] Selecting username inserts @username
- [ ] Mentions stored in message properties
- [ ] GET /mentions returns messages mentioning current user
- [ ] Non-matching @ text shows no suggestions

## 8. Threads (7 tests)

- [ ] Thread panel opens showing parent message
- [ ] Empty thread shows "No replies yet"
- [ ] Reply appears in thread panel
- [ ] Reply stores inReplyTo pointing to parent
- [ ] Replies also appear in main channel
- [ ] Closing thread returns to channel view
- [ ] Multiple users can reply simultaneously

## 9. Search (6 tests)

- [ ] Empty query shows validation / no API call
- [ ] Existing word returns ranked results
- [ ] Results show author, timestamp, content
- [ ] Channel-scoped search works
- [ ] Non-existing word shows "No results"
- [ ] Multi-word search returns messages with all terms

## 10. Unread Badges (4 tests)

- [ ] Opening a channel clears unread count
- [ ] New message in non-active channel shows badge
- [ ] Opening badged channel clears it
- [ ] Unread count persists across logout/login

## 11. Notification Mute (4 tests)

- [ ] Muting a channel stores preference
- [ ] Muted channel doesn't show unread badge
- [ ] Unmuting restores badge behavior
- [ ] Mute preference persists

## 12. Direct Messages (11 tests)

- [ ] New DM modal shows other users
- [ ] Starting DM opens conversation
- [ ] Starting same DM again returns existing (idempotent)
- [ ] Cannot DM yourself (400)
- [ ] DM messages deliver in real-time
- [ ] Non-participant gets 403
- [ ] DM list sorted by most recent
- [ ] ECDH keypair generated on first login (check IndexedDB)
- [ ] Public key stored on server
- [ ] DM content stored as ciphertext on server (not plaintext)
- [ ] Lock icon shows in DM header

## 13. Translation (22 tests)

- [ ] Settings panel opens from gear icon
- [ ] Cloud/Local provider tabs work
- [ ] Language selector shows 17 languages
- [ ] Enable/disable toggle works
- [ ] Settings persist in localStorage
- [ ] Cloud: foreign messages translated to target language
- [ ] Translation indicator toggle (original/translated)
- [ ] Metadata badge: confidence dot, register, intent
- [ ] Same-language messages skipped
- [ ] Idiom annotations appear with hover explanation
- [ ] Invalid API key shows error (not crash)
- [ ] Tone: casual message stays casual
- [ ] Tone: formal message stays formal
- [ ] Tone: sarcastic message stays sarcastic
- [ ] Tone: joke intent detected
- [ ] Glossary terms respected in translation
- [ ] Local: first use downloads model (~50MB)
- [ ] Local: cached model loads instantly on subsequent use
- [ ] Local: no network request to Anthropic
- [ ] Local: no metadata badge (expected)
- [ ] Local: unsupported pair handled gracefully
- [ ] Translation cache keyed per message+language

## 14. Security (11 tests)

- [ ] Cookie: HttpOnly, Secure (production), SameSite=Strict
- [ ] Rate limit: >100 req/min returns 429
- [ ] CORS: production rejects other origins
- [ ] CORS: development allows all origins
- [ ] Member cannot set roles (403)
- [ ] Admin can kick member but not owner
- [ ] Owner can promote/demote roles
- [ ] Admin/moderator can delete member messages
- [ ] Markdown XSS: script tags stripped
- [ ] Production errors return "Internal server error" (no stack trace)
- [ ] Private channel non-member gets 403

## 15. Admin/Moderation (6 tests)

- [ ] Owner sees role dropdowns in member list
- [ ] Members don't see role dropdowns
- [ ] Changing role saves immediately
- [ ] Kick button visible for admin+
- [ ] Kick removes user from server
- [ ] Owner cannot be kicked

## 16. Federation (10 tests)

- [ ] WebFinger returns JRD for known user
- [ ] WebFinger 404 for unknown user
- [ ] Actor profile returns AP JSON-LD with publicKey
- [ ] Group actor profile works
- [ ] Outbox returns OrderedCollection with activities
- [ ] Delivery queue populated on message send
- [ ] Follow from remote actor accepted (with valid signature)
- [ ] Invalid signature returns 401
- [ ] Delete activity tombstones local copy
- [ ] Undo Follow removes from followers

## 17. Deployment (10 tests)

- [ ] Docker image builds successfully
- [ ] Container starts with migration output in logs
- [ ] Health check returns 200 OK
- [ ] Root URL serves React app
- [ ] Deep path serves index.html (SPA fallback)
- [ ] API paths return JSON (not index.html)
- [ ] /.well-known paths return JSON
- [ ] Missing DATABASE_URL fails with clear error
- [ ] Missing SESSION_SECRET fails with clear error
- [ ] Fresh DB: all tables created, default server seeded

---

**Total: 168 manual test cases**
