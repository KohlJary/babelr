# The Embed System

The `[[kind:slug]]` embed syntax is Babelr's universal reference system. Type it anywhere that accepts text — chat messages, wiki pages, event descriptions, file descriptions — and it renders as a live, interactive, translatable embed of the referenced content.

## Embed Kinds

| Syntax | Renders As |
|--------|-----------|
| `[[wiki:page-slug]]` | Clickable wiki link |
| `[[msg:abc1234xyz]]` | Inline message preview with author and channel |
| `[[event:abc1234xyz]]` | Calendar invite card with RSVP buttons |
| `[[file:abc1234xyz]]` | File card with icon, size, and download |
| `[[img:abc1234xyz]]` | Inline image with click-to-lightbox |

## Cross-Tower Embeds

Reference content on another Tower using the `[[server@tower:kind:slug]]` syntax:

```
[[engineering@partner.com:wiki:api-spec]]
[[ops@acme.com:event:weekly-standup]]
[[design@vendor.io:file:brand-guidelines]]
```

The embed resolves via the federation proxy, renders with a purple origin badge showing which Tower it came from, and translates into your preferred language.

## How It Works

1. The **parser** scans text for `[[...]]` refs and classifies each by prefix
2. The **component registry** maps each kind to a React component (MessageEmbed, EventEmbed, FileEmbed, ImageEmbed)
3. Each component **fetches** its data via a by-slug API endpoint with module-level caching
4. The **translation pipeline** translates the embedded content into the reader's language
5. **Interactive embeds** (event RSVP, image lightbox) handle user actions directly from the card

## Copy Reference

Every piece of slugged content has a **"Copy embed reference"** button that puts the `[[kind:slug]]` syntax on your clipboard, ready to paste anywhere.

## Embed Behavior

- Embeds are **live** — they render the current state of the referenced content
- Embeds are **cached** — the same slug referenced multiple times on a page fires one fetch
- Embeds **translate** — content renders in the reader's preferred language regardless of the source language
- Embeds inside **code blocks** are ignored — wrap in backticks to show the syntax without triggering resolution
