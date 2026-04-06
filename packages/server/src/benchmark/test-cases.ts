// SPDX-License-Identifier: Hippocratic-3.0
import type { Register, Intent } from '@babelr/shared';

export interface TestCase {
  id: string;
  content: string;
  sourceLanguage: string;
  expectedRegister?: Register;
  expectedIntent?: Intent;
  expectedIdioms?: string[];
  note?: string;
}

export interface TestSuite {
  name: string;
  description: string;
  cases: TestCase[];
}

export const TEST_SUITES: TestSuite[] = [
  {
    name: 'register',
    description: 'Register spectrum — formal, casual, technical, affectionate',
    cases: [
      {
        id: 'reg-1',
        content:
          'Good morning. I would like to formally request an update on the project timeline at your earliest convenience.',
        sourceLanguage: 'en',
        expectedRegister: 'formal',
        expectedIntent: 'question',
      },
      {
        id: 'reg-2',
        content: 'hey! whats up, u free later?? lets grab food lol',
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'question',
      },
      {
        id: 'reg-3',
        content:
          'The latency degradation observed in the v3.2 deployment correlates with the unindexed JOIN on the sessions table, as hypothesized in RFC-447.',
        sourceLanguage: 'en',
        expectedRegister: 'technical',
        expectedIntent: 'statement',
      },
      {
        id: 'reg-4',
        content: 'i miss you so much babe, counting the hours until i see you again',
        sourceLanguage: 'en',
        expectedRegister: 'affectionate',
        expectedIntent: 'statement',
      },
    ],
  },
  {
    name: 'sarcasm',
    description: 'Sarcasm and humor — must preserve tone, not just meaning',
    cases: [
      {
        id: 'sarc-1',
        content:
          "Oh wow, another meeting that could have been an email. What a productive use of everyone's time.",
        sourceLanguage: 'en',
        expectedRegister: 'sarcastic',
        expectedIntent: 'statement',
      },
      {
        id: 'sarc-2',
        content:
          "Sure, let's just rewrite the entire backend over the weekend. What could possibly go wrong?",
        sourceLanguage: 'en',
        expectedRegister: 'sarcastic',
        expectedIntent: 'statement',
      },
      {
        id: 'sarc-3',
        content: "Why did the programmer quit his job? Because he didn't get arrays.",
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'joke',
        expectedIdioms: ['arrays'],
        note: 'Pun on arrays/a raise — extremely hard to translate',
      },
      {
        id: 'sarc-4',
        content:
          "I'm not saying it's your fault. I'm just saying no one else was in the room when it happened.",
        sourceLanguage: 'en',
        expectedRegister: 'sarcastic',
        expectedIntent: 'joke',
      },
    ],
  },
  {
    name: 'idioms',
    description: 'Idioms and cultural references — detection and annotation',
    cases: [
      {
        id: 'idiom-1',
        content: 'We really knocked it out of the park with that presentation.',
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
        expectedIdioms: ['knocked it out of the park'],
      },
      {
        id: 'idiom-2',
        content: "Let's not beat around the bush — the numbers aren't great.",
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
        expectedIdioms: ['beat around the bush'],
      },
      {
        id: 'idiom-3',
        content: "She's been burning the candle at both ends trying to meet the deadline.",
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
        expectedIdioms: ['burning the candle at both ends'],
      },
      {
        id: 'idiom-4',
        content: "It's raining cats and dogs out there, and I forgot my umbrella. Just my luck.",
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
        expectedIdioms: ['raining cats and dogs', 'just my luck'],
      },
    ],
  },
  {
    name: 'spanish',
    description: 'Spanish source — slang, formal, idioms, sarcasm',
    cases: [
      {
        id: 'es-1',
        content: 'Oye tío, ¿qué onda? ¿Nos echamos unas cañas esta tarde o qué?',
        sourceLanguage: 'es',
        expectedRegister: 'casual',
        expectedIntent: 'question',
        expectedIdioms: ['echamos unas cañas'],
      },
      {
        id: 'es-2',
        content:
          'Estimado colega, le escribo para solicitar su aprobación del presupuesto adjunto.',
        sourceLanguage: 'es',
        expectedRegister: 'formal',
        expectedIntent: 'statement',
      },
      {
        id: 'es-3',
        content: 'No me comas el coco con eso, ya está resuelto.',
        sourceLanguage: 'es',
        expectedRegister: 'casual',
        expectedIntent: 'correction',
        expectedIdioms: ['comas el coco'],
      },
      {
        id: 'es-4',
        content: 'Anda ya, ¿en serio piensas que eso va a funcionar? Venga hombre...',
        sourceLanguage: 'es',
        expectedRegister: 'sarcastic',
        expectedIntent: 'question',
      },
    ],
  },
  {
    name: 'french',
    description: 'French source — casual, idioms, ultra-formal',
    cases: [
      {
        id: 'fr-1',
        content: 'Salut ! Ça roule ? On se fait un petit resto ce soir ?',
        sourceLanguage: 'fr',
        expectedRegister: 'casual',
        expectedIntent: 'question',
      },
      {
        id: 'fr-2',
        content: "Il ne faut pas mettre la charrue avant les bœufs.",
        sourceLanguage: 'fr',
        expectedRegister: 'neutral',
        expectedIntent: 'statement',
        expectedIdioms: ['mettre la charrue avant les bœufs'],
      },
      {
        id: 'fr-3',
        content: "C'est pas la mer à boire, détends-toi.",
        sourceLanguage: 'fr',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
        expectedIdioms: ['la mer à boire'],
      },
      {
        id: 'fr-4',
        content:
          "Veuillez agréer, Madame, l'expression de mes salutations distinguées.",
        sourceLanguage: 'fr',
        expectedRegister: 'formal',
        expectedIntent: 'greeting',
      },
    ],
  },
  {
    name: 'japanese',
    description: 'Japanese source — business keigo, casual, cultural concepts',
    cases: [
      {
        id: 'ja-1',
        content: 'お疲れ様です。先日の件について、ご確認いただけますでしょうか。',
        sourceLanguage: 'ja',
        expectedRegister: 'formal',
        expectedIntent: 'question',
        expectedIdioms: ['お疲れ様'],
      },
      {
        id: 'ja-2',
        content: 'マジで？やばいじゃん！ちょっと待って、今行くから！',
        sourceLanguage: 'ja',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
      },
      {
        id: 'ja-3',
        content: '空気を読んでよ。',
        sourceLanguage: 'ja',
        expectedRegister: 'casual',
        expectedIntent: 'correction',
        expectedIdioms: ['空気を読んで'],
        note: '"Read the air" — uniquely Japanese cultural concept',
      },
    ],
  },
  {
    name: 'edge',
    description: 'Edge cases — emoji, ultra-short, minimal content',
    cases: [
      {
        id: 'edge-1',
        content: 'lmaooo 💀💀💀',
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
      },
      {
        id: 'edge-2',
        content: '👍',
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
      },
      {
        id: 'edge-3',
        content: '...',
        sourceLanguage: 'en',
        expectedRegister: 'neutral',
        expectedIntent: 'statement',
      },
      {
        id: 'edge-4',
        content: 'k',
        sourceLanguage: 'en',
        expectedRegister: 'casual',
        expectedIntent: 'statement',
      },
    ],
  },
];

export function getSuite(name: string): TestSuite | undefined {
  return TEST_SUITES.find((s) => s.name === name);
}

export function getAllCases(): TestCase[] {
  return TEST_SUITES.flatMap((s) => s.cases);
}
