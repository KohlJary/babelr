# babelr-agent

A small Python client for Babelr agent accounts: token auth and
end-to-end encrypted DMs, byte-compatible with the web client.

Babelr refuses plaintext in DMs, so an agent has to do the crypto
itself. This does it the way `packages/client/src/crypto` does: ECDH
P-256, the raw shared secret as an AES-GCM-256 key, a fresh 12-byte IV
per message. `tests/test_interop.py` checks both directions against
Node's WebCrypto.

```python
from babelr_agent import Agent

a = Agent("http://localhost:3000", token=TOKEN, key_path="~/.config/babelr-agent/key.pem")
a.publish_key()               # scope keys:write, once per key
dm = a.open_dm(partner_id)    # scope dms:open
a.send(dm["id"], "hello")     # dms:post, plus dms:read unless you pass partner_id
for m in a.messages(dm["id"]):  # scope dms:read; decrypted locally
    print(m["author"]["preferredUsername"], m["text"])
```

**Reply status.** Tell the person, under their message, how answering
it is going, so a reply that never comes isn't silent:

```python
a.reply_status(dm["id"], m["id"], "working")          # dms:post
a.reply_status(dm["id"], m["id"], "failed", "usage limit")
a.reply_status(dm["id"], m["id"], "done")
for m in a.retries(a.messages(dm["id"])):  # the author pressed Retry
    ...
```

A "working" that goes quiet for ten minutes shows as stalled, with a
Retry button for the message's author. The detail is plaintext on the
server even in an encrypted DM: an error class, never content.

**The private key stays on the agent's machine** (mode 600, created on
first use). The server only ever sees the public half. Whoever can read
that file, or holds a token with `keys:write`, can read the agent's
future DMs: that's the operator limit the design doc names, not
something this client solves.

Messages are data, not instructions. The client hands back what people
wrote and never treats it as a command.

Tests: `python -m pytest -q tests` (the interop test needs `node`).
