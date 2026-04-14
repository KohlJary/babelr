// SPDX-License-Identifier: Hippocratic-3.0
import type { TranslationResult } from '@babelr/shared';
import { translatePreservingEmbeds } from '@babelr/shared';
import type { TranslationProvider, TranslationProgressCallback } from './types';
import { getModelId, FRANC_TO_OPUS, FRANC_TO_ISO1, OPUS_CODES } from './opus-models';

// Module-level pipeline cache — persists across provider re-instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedPipeline: { modelId: string; pipe: any } = {
  modelId: '',
  pipe: null,
};

async function loadPipeline(modelId: string) {
  if (cachedPipeline.modelId === modelId && cachedPipeline.pipe) {
    return cachedPipeline.pipe;
  }

  const { pipeline } = await import('@huggingface/transformers');
  const pipe = await pipeline('translation', modelId, {
    dtype: 'fp32',
  });

  cachedPipeline = { modelId, pipe };
  return pipe;
}

async function detectLanguage(text: string): Promise<{ opusCode: string; iso1: string }> {
  const { francAll } = await import('franc-min');
  const results = francAll(text);
  const detected = results[0]?.[0] ?? 'und';

  if (detected === 'und') {
    return { opusCode: 'en', iso1: 'en' };
  }

  return {
    opusCode: FRANC_TO_OPUS[detected] ?? 'en',
    iso1: FRANC_TO_ISO1[detected] ?? 'en',
  };
}

export class TransformersJsProvider implements TranslationProvider {
  name = 'transformers-js';

  isConfigured(): boolean {
    return true;
  }

  async translate(
    messages: { id: string; content: string }[],
    targetLanguage: string,
    sourceLanguage?: string,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    const tgtOpus = OPUS_CODES[targetLanguage] ?? targetLanguage;
    const results: TranslationResult[] = [];

    for (const msg of messages) {
      // Detect source language if not provided
      let srcOpus: string;
      let srcIso1: string;

      if (sourceLanguage) {
        srcOpus = OPUS_CODES[sourceLanguage] ?? sourceLanguage;
        srcIso1 = sourceLanguage;
      } else {
        const detected = await detectLanguage(msg.content);
        srcOpus = detected.opusCode;
        srcIso1 = detected.iso1;
      }

      // Skip if same language
      if (srcIso1 === targetLanguage || srcOpus === tgtOpus) {
        const result: TranslationResult = {
          id: msg.id,
          translatedContent: msg.content,
          detectedLanguage: srcIso1,
          skipped: true,
        };
        results.push(result);
        onProgress?.(result);
        continue;
      }

      // Check if model exists for this pair
      const modelId = getModelId(srcIso1, targetLanguage);
      if (!modelId) {
        // No model available — return original
        const result: TranslationResult = {
          id: msg.id,
          translatedContent: msg.content,
          detectedLanguage: srcIso1,
          skipped: true,
        };
        results.push(result);
        onProgress?.(result);
        continue;
      }

      try {
        const pipe = await loadPipeline(modelId);
        // NMT models can't be instructed to preserve placeholder tokens.
        // Split the content on [[kind:slug]] embed boundaries, translate
        // only the text segments, and splice the original embeds back.
        const translated = await translatePreservingEmbeds(msg.content, async (text) => {
          const output = await (pipe as CallableFunction)(text);
          return Array.isArray(output)
            ? (output[0] as { translation_text: string }).translation_text
            : (output as { translation_text: string }).translation_text;
        });

        const result: TranslationResult = {
          id: msg.id,
          translatedContent: translated,
          detectedLanguage: srcIso1,
          skipped: false,
          // No metadata — local models don't produce tone analysis
        };
        results.push(result);
        onProgress?.(result);
      } catch (err) {
        console.error(`Local translation failed for ${modelId}:`, err);
        const result: TranslationResult = {
          id: msg.id,
          translatedContent: msg.content,
          detectedLanguage: srcIso1,
          skipped: true,
        };
        results.push(result);
        onProgress?.(result);
      }
    }

    return results;
  }
}
