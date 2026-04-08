# Babelr Translation Test Conversations

Test these by opening two browser tabs, registering as different users.
Set one user's translation language to something different from the messages being sent.

---

## Test 1: Register Spectrum (English → target)

Send these as separate messages from one user:

```
Good morning. I would like to formally request an update on the project timeline at your earliest convenience.
```

```
hey! whats up, u free later?? lets grab food lol
```

```
The latency degradation observed in the v3.2 deployment correlates with the unindexed JOIN on the sessions table, as hypothesized in RFC-447.
```

```
i miss you so much babe, counting the hours until i see you again 💕
```

**Expected:** Four distinct registers (formal, casual, technical, affectionate). Translation should preserve each tone — the formal one shouldn't become casual, the casual one shouldn't become stiff.

---

## Test 2: Sarcasm & Humor (English → target)

```
Oh wow, another meeting that could have been an email. What a productive use of everyone's time.
```

```
Sure, let's just rewrite the entire backend over the weekend. What could possibly go wrong?
```

```
Why did the programmer quit his job? Because he didn't get arrays.
```

```
I'm not saying it's your fault. I'm just saying no one else was in the room when it happened.
```

**Expected:** Sarcasm registers detected. Translations should feel sarcastic/humorous in the target language, not literal. The pun ("arrays/a raise") is a known-hard case — watch how the pipeline handles it.

---

## Test 3: Idioms & Cultural References (English → target)

```
We really knocked it out of the park with that presentation.
```

```
Let's not beat around the bush — the numbers aren't great.
```

```
She's been burning the candle at both ends trying to meet the deadline.
```

```
It's raining cats and dogs out there, and I forgot my umbrella. Just my luck.
```

**Expected:** Each message should have idiom chips showing the original expression, explanation, and target-language equivalent if one exists.

---

## Test 4: Spanish → English (set reader to English)

Send from a user writing in Spanish:

```
Oye tío, ¿qué onda? ¿Nos echamos unas cañas esta tarde o qué?
```

```
Estimado colega, le escribo para solicitar su aprobación del presupuesto adjunto.
```

```
No me comas el coco con eso, ya está resuelto.
```

```
Anda ya, ¿en serio piensas que eso va a funcionar? Venga hombre...
```

**Expected:** Casual slang ("tío", "cañas"), formal register, idiom ("comer el coco"), and dismissive sarcasm should each translate with appropriate English register.

---

## Test 5: French → English (set reader to English)

```
Salut ! Ça roule ? On se fait un petit resto ce soir ?
```

```
Il ne faut pas mettre la charrue avant les bœufs.
```

```
C'est pas la mer à boire, détends-toi.
```

```
Veuillez agréer, Madame, l'expression de mes salutations distinguées.
```

**Expected:** Casual → casual, idioms flagged ("mettre la charrue avant les bœufs" = don't put the cart before the horse), and the ultra-formal French letter closing should translate formally.

---

## Test 6: Japanese → English (set reader to English)

```
お疲れ様です。先日の件について、ご確認いただけますでしょうか。
```

```
マジで？やばいじゃん！ちょっと待って、今行くから！
```

```
空気を読んでよ。
```

**Expected:** Polite business Japanese vs. casual slang vs. cultural concept ("read the air" = read the room). The KY expression should appear as an idiom annotation.

---

## Test 7: Mixed Language Conversation

Simulate a real multilingual chat — send these from different users:

User A (English): `Has anyone tried the new coffee place on 5th?`
User B (Spanish): `Sí, está buenísimo. El café con leche es para morirse.`
User C (French): `J'y suis allé hier. Pas mal du tout, mais un peu cher quand même.`
User A (English): `Yeah I figured it'd be pricey. Worth it though?`
User B (Spanish): `Vale cada centavo, créeme. Además las medialunas están de muerte.`

**Expected:** Each reader sees the full conversation in their preferred language. Register stays casual/conversational throughout. "para morirse" and "de muerte" (Spanish idioms for "to die for") should be flagged.

---

## Test 8: Edge Cases

```
lmaooo 💀💀💀
```

```
👍
```

```
...
```

```
k
```

**Expected:** Ultra-short messages, emoji-heavy messages. Should handle gracefully — either skip or translate minimally. Confidence might be lower.

---

## What to Look For

1. **Register badge** matches the actual tone (casual ≠ formal)
2. **Intent classification** is reasonable (jokes detected as jokes)
3. **Confidence dot** — green for straightforward, yellow for nuanced
4. **Idiom chips** appear for non-literal expressions, hover shows explanation
5. **Toggle** — clicking "original: XX" shows source text, hides metadata
6. **Same-language skip** — messages in reader's language show without translation
7. **Batch speed** — loading history should translate all messages in ~one request
