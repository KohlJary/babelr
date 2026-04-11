# Federation Testing

Babelr's federation layer is ActivityPub-shaped, uses HTTP Signatures for
authentication, and fans activities out through a retrying delivery queue.
Because the flow touches so many surfaces — actor lookup, signature
verification, inbox routing, outbound delivery, and the per-surface
receive handlers — the only reliable way to validate it is to run two
real instances against each other and walk through each federating path
by hand.

This guide sets up a fully-local two-instance rig on a single machine
and walks through every scenario that federates today, plus the ones
that *should* federate so you can spot regressions or missing wiring.

## One-time setup

### 1. Hostname aliases

ActivityPub requires distinct resolvable hostnames for each instance.
`localhost:3000` and `localhost:3001` both resolve to `127.0.0.1`, which
breaks HTTP signature verification (the `Host` header is part of the
signing string) and actor-URI fetches.

Add two aliases to `/etc/hosts`:

```
127.0.0.1 babelr-a.local
127.0.0.1 babelr-b.local
```

This requires sudo, but only once per machine.

### 2. Two databases

Use the same Postgres role as your existing dev database (the default
`.env` uses `babelr:babelr`):

```
PGPASSWORD=babelr createdb -h localhost -U babelr babelr_a
PGPASSWORD=babelr createdb -h localhost -U babelr babelr_b
```

If your `.env` uses different credentials, substitute them in both the
createdb commands and the `DATABASE_URL` env vars that follow.

### 3. Run migrations against both

```
DATABASE_URL=postgresql://babelr:babelr@localhost:5432/babelr_a \
  npm run db:migrate -w packages/server

DATABASE_URL=postgresql://babelr:babelr@localhost:5432/babelr_b \
  npm run db:migrate -w packages/server
```

If you ever want to reset one instance's state during testing, drop and
recreate just that database, then re-run its migrations:

```
PGPASSWORD=babelr dropdb -h localhost -U babelr babelr_a
PGPASSWORD=babelr createdb -h localhost -U babelr babelr_a
DATABASE_URL=postgresql://babelr:babelr@localhost:5432/babelr_a \
  npm run db:migrate -w packages/server
```

### 4. Keep your existing `.env`

You do not need to edit `.env`. The dev script sets `DATABASE_URL`,
`PORT`, `BABELR_DOMAIN`, and `SESSION_SECRET` inline for each instance,
which override the values from `.env` via Node's `--env-file` semantics.

## Running the rig

```
./scripts/dev-two-instance.sh
```

This spins up four processes in the foreground with color-prefixed logs:

| Process  | URL                              | Role                      |
|----------|----------------------------------|---------------------------|
| server-a | `http://babelr-a.local:3000`     | Instance A backend        |
| server-b | `http://babelr-b.local:3001`     | Instance B backend        |
| client-a | `http://babelr-a.local:1111`     | Instance A web client     |
| client-b | `http://babelr-b.local:1112`     | Instance B web client     |

`Ctrl-C` stops all four cleanly. Each line in the combined output is
tagged with the instance name so you can tell who's saying what.

### Why two vite clients?

The web client's WebSocket connects to its page origin, not to an
overridable URL. Running two vite dev servers — one per instance, each
with its own proxy target set via `VITE_PROXY_TARGET` — keeps the
HTTP + WebSocket path cleanly isolated per instance without touching
client code.

### Browser setup

Use two separate browser profiles (or one normal + one incognito) so
the session cookies don't collide. Register a different user on each:

- On `http://babelr-a.local:1111` → register `alice`
- On `http://babelr-b.local:1112` → register `bob`

## What federates today

Everything in the checklist below is wired up and delivering via the
`delivery_queue` table. If a scenario fails, check the server logs for
the instance that *sent* the activity (look for
`Delivery failed`, `Signature verification failed`, or the activity's
queue row with `state = 'failed'`).

### 1. Actor discovery (WebFinger)

**What it does:** One instance resolves `user@host` into an actor URI
via the `/.well-known/webfinger` endpoint before any activity can be
addressed to them.

**Test:**
- [ ] From bob on B, open the "Add friend" dialog and enter
      `alice@babelr-a.local:3000`.
- [ ] The client should resolve the handle and show alice's avatar /
      display name in the preview.
- [ ] Check server-b logs — you should see a WebFinger fetch against
      `http://babelr-a.local:3000/.well-known/webfinger?...`
- [ ] **Regression probe:** delete alice's cached actor row from B
      (`DELETE FROM actors WHERE uri LIKE 'http://babelr-a.local%'`)
      and re-resolve. It should refetch cleanly without stale-cache
      artifacts.

### 2. Friend requests (Follow / Accept / Undo)

**What it does:** A `Follow` activity is delivered Person→Person and
creates a `pending_in` row on the receiver. An `Accept` flips both
sides to `accepted`. An `Undo(Follow)` removes the friendship.

**Test:**
- [ ] Bob sends friend request to `alice@babelr-a.local:3000`.
- [ ] On server-b logs: outbound `Follow` activity enqueued.
- [ ] On server-a logs: inbound `Follow` received at
      `/users/alice/inbox`, signature verified, friendship row created
      with state `pending_in`.
- [ ] Alice's client receives a `friend:request` WS event and shows
      the request in her pending list in real time.
- [ ] Alice clicks Accept.
- [ ] `Accept(Follow)` is delivered to B; bob's client receives
      `friend:accepted` and the friendship flips to `accepted` on
      both sides.
- [ ] **Reciprocal follow:** from a fresh pair of users, both send
      simultaneous friend requests to each other. The second request
      should short-circuit into an immediate `accepted` state on both
      ends (this is the `pending_out → accepted` fast path in
      `handleFollow`).
- [ ] **Unfriend:** either side removes the friendship. The `Undo` is
      delivered and the other side's row disappears.

### 3. Cross-instance DMs

**What it does:** A DM Create activity is delivered targeted to a
single remote recipient (not the followers collection). The recipient's
instance synthesizes a local DM collection if one doesn't already exist
and delivers a `message:new` / `conversation:new` WS event.

**Test:**
- [ ] After the friendship from step 2 is accepted, alice opens bob's
      profile and clicks "Send message".
- [ ] Alice sends a plaintext message.
- [ ] Server-a enqueues `Create(Note)` targeted to bob's actor URI.
- [ ] Server-b logs: inbound Create processed, new DM collection
      created, `message:new` + `conversation:new` broadcast.
- [ ] Bob's sidebar shows a new DM conversation without a reload.
      Message appears in the thread.
- [ ] Bob replies. Alice should receive the reply in real time.
- [ ] **E2E encryption:** verify that the `babelrEncrypted`,
      `babelrIv`, and `babelrEcdhKey` fields round-trip through the
      Create activity and both sides can decrypt. The server never
      sees plaintext.
- [ ] **Read receipts:** open alice's DM with bob as alice, scroll a
      message into view, verify bob sees the "Seen by alice"
      indicator. This uses a `Read` activity type delivered through
      the same queue.
- [ ] **New-conversation path:** delete the DM collection on bob's
      side (`DELETE FROM objects WHERE id = '...'`) and re-send from
      alice. The `findOrCreateDM` path should create a fresh
      collection and fire `conversation:new` on bob's sidebar.

### 4. Server joins (Group Follow / Undo)

**What it does:** A remote user "joins" a server on another instance
by sending a `Follow` activity to the Group actor's inbox. The Group
auto-accepts (unlike Person→Person) and adds the remote actor to the
`followers` collection.

**Test:**
- [ ] On instance A, alice creates a server called "Test Server" with
      a `#general` channel.
- [ ] On instance B, bob looks up the server by handle
      (`test-server@babelr-a.local:3000` — note the Group handle
      format may require a direct URI paste; check the sidebar's
      "Join by URL" flow if the UI gates it).
- [ ] Bob's Follow is delivered to server-a, auto-accepted, and
      bob's actor appears in Test Server's followers collection.
- [ ] Test Server shows up in bob's sidebar on instance B.
- [ ] **Leave:** bob leaves Test Server. `Undo(Follow)` is delivered,
      bob is removed from the followers collection on A.

### 5. Channel message federation

**What it does:** When alice posts in `#general` on Test Server, a
`Create(Note)` activity is delivered to every remote follower (i.e.
bob) via `broadcastToGroupFollowers`.

**Test:**
- [ ] Alice posts `hello from A` in `#general`.
- [ ] Server-a enqueues Create to bob's inbox on instance B.
- [ ] Bob sees `hello from A` render in `#general` in real time.
      Channel name and author are correct; translation pipeline kicks
      in if bob's preferred language differs.
- [ ] Bob replies `hello from B`.
- [ ] Server-b enqueues Create — but wait, bob isn't the Group owner,
      so this one rides on bob's own outbox. Verify that when bob
      posts in a federated server, the message lands on A as well
      (via `broadcastCreate` from bob's own actor fanout).
- [ ] **Message edit:** alice edits her message. An `Update(Note)`
      activity is delivered. Bob's client should re-render with the
      new content and an "edited" marker.
- [ ] **Message delete:** alice deletes her message. A `Delete`
      activity is delivered. Bob's client tombstones the message.
- [ ] **Private channels:** make a channel private on A, invite bob
      from A only. Verify bob sees messages in the private channel
      only after the invite takes effect, and doesn't see them
      before.

### 6. Reactions

**What it does:** Reactions are delivered as... hmm, check the code.
If reactions don't federate yet, this is a known gap — mark it as a
failure case for the regression tracker.

**Test:**
- [ ] Alice adds a 👍 reaction to one of bob's messages on A.
- [ ] Does bob see the reaction count update on B?
- [ ] Alice removes the reaction. Does B see the count decrement?
- [ ] **Expected to fail today** if reactions aren't wired into the
      delivery path. File an issue if so.

### 7. Threaded replies

**What it does:** Replies to a message form a thread. Each reply is
a Note whose `inReplyTo` points at the parent. Federation should
deliver replies the same way top-level posts are delivered.

**Test:**
- [ ] Alice posts a message; bob opens it in a thread and replies.
- [ ] Alice sees the reply appear in the thread view on A.
- [ ] Reply count on the parent message increments on both sides.
- [ ] **Expected to fail today** if thread replies aren't wired. Check
      `sendReply` / `sendThreadReply` in `channels.ts` for a delivery
      call — if there isn't one, reactions and replies are both in
      the same boat.

### 8. Friends list sync

**What it does:** After the initial friendship, subsequent profile
changes (display name, avatar, bio) on one side should propagate to
the other via `Update(Actor)` activities.

**Test:**
- [ ] Alice changes her display name from "Alice" to "Alicia".
- [ ] On B, bob's friends list should update within a few seconds
      (delivery queue fires every 5s).
- [ ] **Expected to fail today** if actor updates aren't in the
      delivery path. This is a known-missing piece worth a roadmap
      item.

### 9. Server metadata sync

**What it does:** If the Test Server's name, icon, or description
changes on A, remote followers on B should see the update.

**Test:**
- [ ] Alice edits Test Server's display name from "Test Server" to
      "Test Server v2".
- [ ] Does bob see the updated name in his sidebar on B?
- [ ] **Expected to fail today** — server metadata updates are not
      known to federate. Another regression-tracker candidate.

### 10. Event federation

**What it does:** Calendar events are owned by either a user or a
server. In theory a server event should fan out to remote followers
the same way a channel message does.

**Test:**
- [ ] Alice creates an event on Test Server.
- [ ] Does the event appear in bob's calendar view on B?
- [ ] Can bob RSVP from B?
- [ ] Does alice see bob's RSVP on A?
- [ ] **Expected to fail today** — event delivery is not currently
      wired. Confirm and file.

### 11. Wiki page federation

**What it does:** Wiki pages are ActivityPub `Article` objects in
theory. In practice, they almost certainly don't federate yet.

**Test:**
- [ ] Alice creates a wiki page on Test Server.
- [ ] Does it show up on bob's wiki panel on B?
- [ ] Alice edits the page. Does B see the update?
- [ ] Alice renames the page. Does B see the rename?
- [ ] **Expected to fail today.** File as a roadmap item if it
      matters for launch.

### 12. Message embeds across instances

**What it does:** A `[[msg:slug]]` embed on one instance references
a message that may live on the remote instance. The current lookup
path hits `/messages/by-slug/:slug` on the *local* server. A
cross-instance embed should either resolve via federation or
gracefully fall back to a "locked" preview.

**Test:**
- [ ] Alice posts a message on A. Its slug is visible via the copy
      button on the message.
- [ ] Bob pastes `[[msg:that-slug]]` into a message on B.
- [ ] Does the embed render bob's side with alice's content? Or does
      it show "locked"?
- [ ] **Known limitation:** embeds only resolve locally today. This
      is expected behavior until a cross-instance lookup is added.

### 13. Delivery queue resilience

**What it does:** Failed deliveries retry with exponential backoff
(30s → 60s → 120s → 240s). After the final attempt, the row is
marked `failed`.

**Test:**
- [ ] Stop instance B while instance A has unsent activities to
      deliver (send alice a message for bob, then kill server-b
      within the same second).
- [ ] Check A's `delivery_queue` table — rows should be in `pending`
      state with a `next_attempt_at` in the near future.
- [ ] Bring B back up and wait for the retry window.
- [ ] Queue rows should flip to `delivered` and bob's client should
      receive the backlog.
- [ ] **Worst case:** leave B down long enough for all four retries
      to fail. The row should move to `failed` and not retry
      indefinitely.

### 14. HTTP signature edge cases

**What it does:** Every inbox POST is authenticated by an HTTP
Signature covering `(request-target)`, `host`, `date`, and `digest`.
Any tampering breaks verification.

**Test:**
- [ ] **Clock skew:** manually adjust system clock on A forward by
      10 minutes, send an activity. B should reject it with a
      signature failure (if it has a date-window check) or accept it
      (if it doesn't — note this as a hardening target).
- [ ] **Key rotation:** rotate alice's actor key on A by clearing
      the cached key and re-issuing. Subsequent deliveries to B
      should refetch the new key via the `keyId` URI before
      verifying.
- [ ] **Unknown key:** manually send an inbox POST from a random
      unauthorized client. B should 401 with "Signature verification
      failed".

### 15. Rate limiting

**What it does:** Inbox endpoints are rate-limited to 30 req/min
per IP to prevent a malicious remote from flooding the queue.

**Test:**
- [ ] Spam 50 inbox POSTs to B from a script within 60 seconds. The
      first 30 should be processed; the rest should 429.
- [ ] Verify legitimate federation traffic from A is not affected
      when A is well under the limit.

## Known gaps worth tracking

These are features that *should* federate but currently don't, based
on the audit. Each is a candidate roadmap item if it matters for
enterprise adoption:

- Message reactions don't deliver across instances
- Threaded replies may not deliver (check `sendReply` call sites)
- Actor profile updates (display name, avatar, bio) don't deliver
- Server metadata updates (name, icon, description) don't deliver
- Event Create / Update / Delete / RSVP don't deliver
- Wiki page Create / Update / Delete don't deliver
- `[[msg:slug]]` and `[[event:slug]]` embeds don't resolve cross-instance
- Voice/video calls are P2P WebRTC and don't involve federation signaling
- File uploads: the attachment URL points at the origin instance, so a
  remote viewer fetches it directly; verify this works when B is behind
  a firewall that A can't reach

## Tips for debugging

**See what's queued:**

```sql
SELECT id, activity_type, target_inbox, state, attempts, next_attempt_at, last_error
  FROM delivery_queue
  ORDER BY created_at DESC
  LIMIT 20;
```

**Tail signature verification failures:**

```
./scripts/dev-two-instance.sh 2>&1 | grep -i 'signature'
```

**Force-retry a failed row:**

```sql
UPDATE delivery_queue
  SET state = 'pending', next_attempt_at = NOW(), attempts = 0, last_error = NULL
  WHERE id = '...';
```

**Clear cached remote actors on one instance:**

```sql
DELETE FROM actors WHERE local = false;
```

Useful if you've rotated keys or reset the other instance and want
a clean handshake on the next activity.

## Shipping order

If you're stabilizing federation toward a public instance, the
sensible order to drive this list to green is:

1. Sections 1–5 need to pass cleanly. Those are the currently-wired
   paths and any regression is an emergency.
2. Section 6 (reactions) + section 7 (thread replies) — small
   additions to the delivery path, high user-visible value.
3. Section 8 (actor updates) — the first time someone changes their
   display name and their friends don't see it, that looks broken.
4. Section 9 (server metadata) + section 10 (events) — medium lift,
   unlocks the "share a calendar across companies" story.
5. Section 11 (wiki federation) — the biggest single gap; unlocks
   the cross-company knowledge sharing story from the README.
6. Section 12 (cross-instance embed resolution) — ties the embed
   substrate into the federation story and makes `[[msg:slug]]`
   work from anywhere.

Each of the above should land with a regression pass through this
doc before shipping. Until there's an automated end-to-end rig
(roadmap candidate), the manual checklist is the safety net.
