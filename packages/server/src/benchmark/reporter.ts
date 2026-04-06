// SPDX-License-Identifier: Hippocratic-3.0
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from './runner.ts';
import type { TestCase } from './test-cases.ts';

// ANSI colors
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function colorConfidence(n: number): string {
  const pct = `${Math.round(n * 100)}%`;
  if (n > 0.8) return green(pct);
  if (n > 0.5) return yellow(pct);
  return red(pct);
}

function checkMark(match: boolean): string {
  return match ? green('✓') : red('✗');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

interface Scores {
  registerMatches: number;
  registerTotal: number;
  intentMatches: number;
  intentTotal: number;
  idiomFound: number;
  idiomExpected: number;
  avgConfidence: number;
  confidenceCount: number;
}

function computeScores(cases: TestCase[], results: RunResult): Scores {
  const scores: Scores = {
    registerMatches: 0,
    registerTotal: 0,
    intentMatches: 0,
    intentTotal: 0,
    idiomFound: 0,
    idiomExpected: 0,
    avgConfidence: 0,
    confidenceCount: 0,
  };

  for (const tc of cases) {
    const result = results.results.find((r) => r.id === tc.id);
    if (!result?.metadata) continue;

    if (tc.expectedRegister) {
      scores.registerTotal++;
      if (result.metadata.register === tc.expectedRegister) scores.registerMatches++;
    }

    if (tc.expectedIntent) {
      scores.intentTotal++;
      if (result.metadata.intent === tc.expectedIntent) scores.intentMatches++;
    }

    if (tc.expectedIdioms) {
      scores.idiomExpected += tc.expectedIdioms.length;
      const foundIdioms = result.metadata.idioms.map((i) => i.original.toLowerCase());
      for (const expected of tc.expectedIdioms) {
        if (foundIdioms.some((f) => f.includes(expected.toLowerCase()) || expected.toLowerCase().includes(f))) {
          scores.idiomFound++;
        }
      }
    }

    scores.avgConfidence += result.metadata.confidence;
    scores.confidenceCount++;
  }

  if (scores.confidenceCount > 0) {
    scores.avgConfidence /= scores.confidenceCount;
  }

  return scores;
}

export function printReport(cases: TestCase[], runs: RunResult[]) {
  console.log('\n' + bold('═══ Babelr Translation Benchmark ═══') + '\n');

  // Summary table
  console.log(bold('Model Summary'));
  console.log('─'.repeat(80));

  const header = [
    'Model'.padEnd(10),
    'Time'.padEnd(8),
    'Register'.padEnd(10),
    'Intent'.padEnd(10),
    'Idioms'.padEnd(10),
    'Confidence'.padEnd(12),
  ].join('│ ');
  console.log(dim(header));
  console.log('─'.repeat(80));

  for (const run of runs) {
    if (run.error) {
      console.log(`${bold(run.model.padEnd(10))}│ ${red(run.error)}`);
      continue;
    }

    const scores = computeScores(cases, run);
    const regPct =
      scores.registerTotal > 0
        ? `${scores.registerMatches}/${scores.registerTotal}`
        : '-';
    const intPct =
      scores.intentTotal > 0
        ? `${scores.intentMatches}/${scores.intentTotal}`
        : '-';
    const idiomPct =
      scores.idiomExpected > 0
        ? `${scores.idiomFound}/${scores.idiomExpected}`
        : '-';

    const row = [
      bold(run.model.padEnd(10)),
      `${run.durationMs}ms`.padEnd(8),
      regPct.padEnd(10),
      intPct.padEnd(10),
      idiomPct.padEnd(10),
      colorConfidence(scores.avgConfidence).padEnd(12),
    ].join('│ ');
    console.log(row);
  }

  console.log('─'.repeat(80));

  // Per-message comparison
  console.log('\n' + bold('Message-by-Message Comparison'));
  console.log('─'.repeat(80));

  for (const tc of cases) {
    console.log(`\n${cyan(`[${tc.id}]`)} ${dim(truncate(tc.content, 70))}`);
    if (tc.note) console.log(dim(`  note: ${tc.note}`));

    for (const run of runs) {
      const result = run.results.find((r) => r.id === tc.id);
      if (!result) {
        console.log(`  ${bold(run.model)}: ${red('no result')}`);
        continue;
      }

      const meta = result.metadata;
      const regCheck = tc.expectedRegister
        ? checkMark(meta?.register === tc.expectedRegister)
        : '';
      const intCheck = tc.expectedIntent
        ? checkMark(meta?.intent === tc.expectedIntent)
        : '';

      console.log(`  ${bold(run.model)}:`);
      console.log(`    ${truncate(result.translatedContent, 72)}`);

      if (meta) {
        const parts = [
          `${regCheck} ${meta.register}`,
          `${intCheck} ${meta.intent}`,
          colorConfidence(meta.confidence),
        ];
        if (meta.idioms.length > 0) {
          parts.push(`idioms: ${meta.idioms.map((i) => i.original).join(', ')}`);
        }
        console.log(`    ${dim(parts.join(' │ '))}`);
      }
    }
  }

  console.log('\n' + '─'.repeat(80));
}

export function saveJson(cases: TestCase[], runs: RunResult[], outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `benchmark-${timestamp}.json`;
  const filepath = join(outputDir, filename);

  const report = {
    timestamp: new Date().toISOString(),
    targetLanguage: runs[0]?.targetLanguage,
    models: runs.map((r) => ({ name: r.model, id: r.modelId, durationMs: r.durationMs })),
    testCases: cases.map((tc) => ({
      ...tc,
      results: Object.fromEntries(
        runs.map((run) => [
          run.model,
          run.results.find((r) => r.id === tc.id) ?? null,
        ]),
      ),
    })),
  };

  writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`\n${dim(`Results saved to ${filepath}`)}`);
}
