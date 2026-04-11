# Wiki mixed-language translation test fixture

A copy-paste fixture for exercising the wiki translation pipeline end
to end. Covers English pass-through, four non-English source languages
(Spanish, French, German, Japanese), several registers, a couple of
idioms, and a fenced code block that must not be touched.

## How to run

1. Open a server wiki in Babelr.
2. Create a new page with the title **Welcome to the team**.
3. Paste the content block below into the editor and save.
4. Make sure translation is enabled in settings and `preferredLanguage`
   is set to `en`.
5. Reopen the page. The meta row should show "Translating…" briefly,
   then "Translated from es, fr, de, ja".
6. Click the toggle to compare translated vs. original output.

## Content to paste

````markdown
## Getting started

Welcome! This page is our team's collective memory — we keep onboarding notes, conventions, and running jokes here so new folks can get up to speed without pinging everyone in #general. Read through it, and don't hesitate to edit anything that looks stale.

## Cómo pedimos ayuda

Si te quedas atascado con algo, no sufras en silencio. Abre un hilo en #ayuda-general y describe lo que intentaste antes de preguntar — eso nos ahorra tiempo a todos. Aquí no mordemos, y preferimos mil veces que preguntes algo "tonto" a que pierdas tres horas buscando en Google. Nadie nació sabiendo.

## Conventions de code

Nous suivons une règle simple : le code doit être lisible avant d'être astucieux. Les noms de variables explicites valent mieux qu'un commentaire qui explique une abréviation. Les revues de code sont un dialogue, pas un examen — si quelqu'un suggère un changement, c'est pour améliorer le produit, jamais pour vous remettre en cause personnellement.

## Code-Reviews

Reviews sollten zügig erfolgen — idealerweise innerhalb eines Werktages. Blockiere niemanden länger als nötig. Wenn du einen Kommentar hinterlässt, erkläre immer das *Warum*, nicht nur das *Was*. "Das ist falsch" hilft niemandem; "Das ist falsch, weil X unter Bedingung Y fehlschlägt" gibt dem Autor etwas, worauf er aufbauen kann.

## 休憩について

休憩を取るのを忘れないでください。画面を何時間も見つめていると、コードが悪くなって、気分も悪くなります。散歩に行ったり、コーヒーを飲んだり、同僚と雑談したりしましょう。うちのチームでは、休憩を取ることは怠けることではなく、仕事の一部です。

## Example snippet

This code block should pass through untranslated — the chunker marks fenced blocks as non-prose.

```ts
function greet(name: string): string {
  return `Hello, ${name}! Welcome to the team.`;
}
```

## What to do if this page is wrong

If something above is outdated, just fix it — that's what wikis are for. No need to ask permission.
````

## What to check on the translated output

1. **English pass-through** — "Getting started" and "What to do if this
   page is wrong" should render identically to the source, flagged as
   `skipped` on their chunks.
2. **Code fence untouched** — the TypeScript block must be byte-for-byte
   the same. If any character changed, the chunker's fence detection
   regressed.
3. **Heading translation** — short non-prose-looking fragments like
   `Cómo pedimos ayuda` should resolve to sensible English ("How we
   ask for help" or similar).
4. **Register preservation**:
   - **Spanish**: warm, casual, reassuring. Should not come out
     clinical or bureaucratic.
   - **French**: formal and technical, like a style guide. Should not
     sound chatty.
   - **German**: imperative and direct. The `du` form maps to informal
     English but the content is strict — the English should retain the
     commanding tone.
   - **Japanese**: gently caring, team-mom energy. Should not come out
     bossy.
5. **Idiom flagging** — the Spanish section has two idioms the pipeline
   should pick up:
   - `no mordemos` — literally "we don't bite", idiomatic "we're
     friendly"
   - `Nadie nació sabiendo` — literally "nobody was born knowing",
     idiomatic "everyone starts somewhere"
6. **Detected languages badge** — "Translated from es, fr, de, ja".
7. **Cache behavior** — close and reopen the panel; translated output
   should appear instantly with no "Translating…" flicker. Verify in
   devtools → Application → Local Storage that keys under
   `babelr:tx:wiki:*` exist.
8. **Incremental retranslation** — edit just one paragraph (e.g. add a
   sentence to the Spanish section) and save. On reopen, devtools
   Network should show a single `/translate` call with exactly one
   item in its `messages` array. The other paragraphs pull from cache.

## Notes

- The source languages were chosen for coverage breadth: Romance
  (Spanish, French), Germanic (German), East Asian non-Latin
  (Japanese). If we later add RTL support, add an Arabic or Hebrew
  section to this fixture.
- All non-English prose was written by hand to be grammatically clean
  in its source language, so any awkwardness in the translated output
  is the translator's, not the source's.
- If you want to test sarcasm/joke handling, add a paragraph in one of
  the languages with a deliberately sarcastic tone. The current
  fixture is intentionally earnest so tone drift is easier to spot.
