// SPDX-License-Identifier: Hippocratic-3.0

// Map ISO 639-1 UI codes to OPUS model language codes
export const OPUS_CODES: Record<string, string> = {
  en: 'en',
  es: 'es',
  fr: 'fr',
  de: 'de',
  pt: 'pt',
  it: 'it',
  nl: 'nl',
  pl: 'pl',
  ru: 'ru',
  uk: 'uk',
  ja: 'jap',
  ko: 'ko',
  zh: 'zh',
  ar: 'ar',
  hi: 'hi',
  tr: 'tr',
  vi: 'vi',
};

// Map franc ISO 639-3 codes to OPUS codes
export const FRANC_TO_OPUS: Record<string, string> = {
  eng: 'en',
  spa: 'es',
  fra: 'fr',
  deu: 'de',
  por: 'pt',
  ita: 'it',
  nld: 'nl',
  pol: 'pl',
  rus: 'ru',
  ukr: 'uk',
  jpn: 'jap',
  kor: 'ko',
  cmn: 'zh',
  zho: 'zh',
  ara: 'ar',
  hin: 'hi',
  tur: 'tr',
  vie: 'vi',
};

// Map franc codes to ISO 639-1 for TranslationResult.detectedLanguage
export const FRANC_TO_ISO1: Record<string, string> = {
  eng: 'en',
  spa: 'es',
  fra: 'fr',
  deu: 'de',
  por: 'pt',
  ita: 'it',
  nld: 'nl',
  pol: 'pl',
  rus: 'ru',
  ukr: 'uk',
  jpn: 'ja',
  kor: 'ko',
  cmn: 'zh',
  zho: 'zh',
  ara: 'ar',
  hin: 'hi',
  tur: 'tr',
  vie: 'vi',
};

// Known available OPUS model pairs on HuggingFace (Xenova namespace)
// Format: "src-tgt"
const KNOWN_PAIRS = new Set([
  'en-es', 'es-en', 'en-fr', 'fr-en', 'en-de', 'de-en',
  'en-pt', 'pt-en', 'en-it', 'it-en', 'en-nl', 'nl-en',
  'en-pl', 'pl-en', 'en-ru', 'ru-en', 'en-uk', 'uk-en',
  'en-jap', 'jap-en', 'en-ko', 'ko-en', 'en-zh', 'zh-en',
  'en-ar', 'ar-en', 'en-hi', 'hi-en', 'en-tr', 'tr-en',
  'en-vi', 'vi-en', 'en-mul', 'mul-en',
  'es-fr', 'fr-es', 'de-fr', 'fr-de',
]);

export function getModelId(srcCode: string, tgtCode: string): string | null {
  const src = OPUS_CODES[srcCode] ?? srcCode;
  const tgt = OPUS_CODES[tgtCode] ?? tgtCode;

  if (src === tgt) return null;

  // Check direct pair
  if (KNOWN_PAIRS.has(`${src}-${tgt}`)) {
    return `Xenova/opus-mt-${src}-${tgt}`;
  }

  // Try via English as pivot (src→en, then en→tgt)
  // Return null for now — pivoting is a future enhancement
  return null;
}
