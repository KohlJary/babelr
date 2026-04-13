# Channels & Messaging

Channels are where conversations happen. Each server has at least one channel (#general), and admins can create more.

## Channel Types

- **Text channels** — real-time chat with markdown, reactions, threads, and embeds
- **Voice channels** — live audio/video with screen sharing (up to 8 participants)
- **Private channels** — invite-only, visible only to members

## Messaging Features

### Markdown

Messages support markdown formatting: **bold**, *italic*, `code`, and fenced code blocks with syntax highlighting.

### Reactions

Click the emoji button on any message to add a reaction. Reactions show counts and highlight when you've reacted.

### Threads

Click "Reply" on a message to open a threaded conversation. Thread replies don't clutter the main channel — they appear in a side panel.

### Mentions

Type `@username` to mention someone. They'll get a notification badge. The Mentions panel (bell icon) shows all your mentions across channels.

## Embeds in Messages

Any `[[kind:slug]]` reference in a message renders as a live embed:

- `[[wiki:getting-started]]` — clickable wiki link
- `[[msg:abc1234xyz]]` — inline preview of another message
- `[[event:xyz9876abc]]` — calendar invite with RSVP buttons
- `[[file:doc5678efg]]` — file card with download button
- `[[img:pic1234abc]]` — inline image with lightbox

## Direct Messages

Click a user's name to start a DM. DMs are end-to-end encrypted — the server never sees the plaintext. Translation happens after local decryption.
