# Translation

Babelr's translation pipeline doesn't just convert words — it preserves tone, register, humor, and intent. A casual joke stays casual. A formal announcement stays formal. Sarcasm reads as sarcasm.

## How It Works

The three-stage pipeline runs as a single LLM call:

1. **Classify** — detect the register (casual, formal, sarcastic, technical) and intent (statement, question, joke, correction)
2. **Translate** — with register and intent as explicit constraints
3. **Idiom check** — flag untranslatable expressions with explanations and target-language equivalents

## Translation Backends

| Backend | Where It Runs | Setup |
|---------|--------------|-------|
| **Anthropic Claude** | Server proxy → Anthropic API | Paste your API key in Settings |
| **OpenAI GPT** | Server proxy → OpenAI API | Paste your API key in Settings |
| **Ollama** (self-hosted) | Browser → your Ollama instance | Point at your Ollama URL |
| **Transformers.js** (local) | Browser-local (WASM) | Nothing — works out of the box |

The three LLM backends share the same prompt and produce the same structured response. Transformers.js is translation-only (no tone metadata) but requires zero setup.

## What Translates

Everything:

- Chat messages and thread replies
- Wiki page content (chunk-by-chunk, with per-chunk confidence indicators)
- Calendar event titles and descriptions
- File descriptions
- File and wiki comments
- Embed content (a Spanish wiki page embedded in an English chat message translates for the English reader)
- Table of contents entries

## Metadata

Every translated message shows a confidence badge. Hover to see:

- **Register** — what tone the system detected (casual, formal, etc.)
- **Intent** — what the message is doing (statement, joke, question)
- **Confidence** — how certain the system is about the translation
- **Idiom glosses** — flagged expressions with explanations

## Settings

Open **Settings** to configure:

- **Preferred language** — what language content translates into for you
- **Translation provider** — which backend to use
- **API key** — for cloud providers (Anthropic, OpenAI)
- **Ollama URL** — for self-hosted translation
