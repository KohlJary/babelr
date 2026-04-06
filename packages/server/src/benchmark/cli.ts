#!/usr/bin/env node
// SPDX-License-Identifier: Hippocratic-3.0
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { TEST_SUITES, getSuite, getAllCases, type TestCase } from './test-cases.ts';
import { runTranslation, MODEL_MAP } from './runner.ts';
import { printReport, saveJson } from './reporter.ts';

const { values } = parseArgs({
  options: {
    models: { type: 'string', short: 'm', default: 'sonnet' },
    target: { type: 'string', short: 't', default: 'es' },
    suite: { type: 'string', short: 's' },
    list: { type: 'boolean', short: 'l', default: false },
    output: { type: 'string', short: 'o', default: join(process.cwd(), '../../benchmark-results') },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`
Babelr Translation Benchmark

Usage:
  npx tsx src/benchmark/cli.ts [options]

Options:
  -m, --models <list>   Comma-separated model names (default: sonnet)
                         Available: ${Object.keys(MODEL_MAP).join(', ')}
  -t, --target <lang>   Target language ISO code (default: es)
  -s, --suite <name>    Run specific test suite (default: all)
  -l, --list            List available test suites
  -o, --output <dir>    Output directory for JSON reports
  -h, --help            Show this help

Examples:
  npx tsx src/benchmark/cli.ts -m sonnet,opus -t es
  npx tsx src/benchmark/cli.ts -m sonnet,haiku -t fr -s idioms
  npx tsx src/benchmark/cli.ts -m sonnet -t ja -s japanese
`);
  process.exit(0);
}

if (values.list) {
  console.log('\nAvailable test suites:\n');
  for (const suite of TEST_SUITES) {
    console.log(`  ${suite.name.padEnd(12)} ${suite.description} (${suite.cases.length} cases)`);
  }
  console.log(`\n  ${'all'.padEnd(12)} Run all suites (${getAllCases().length} cases)`);
  process.exit(0);
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  const modelNames = values.models!.split(',').map((s) => s.trim());
  const targetLang = values.target!;

  let cases: TestCase[];
  if (values.suite) {
    const suite = getSuite(values.suite);
    if (!suite) {
      console.error(`Unknown suite: ${values.suite}`);
      console.error(`Available: ${TEST_SUITES.map((s) => s.name).join(', ')}`);
      process.exit(1);
    }
    cases = suite.cases;
    console.log(`\nRunning suite: ${suite.name} — ${suite.description}`);
  } else {
    cases = getAllCases();
    console.log(`\nRunning all suites (${cases.length} test cases)`);
  }

  console.log(`Target language: ${targetLang}`);
  console.log(`Models: ${modelNames.join(', ')}`);
  console.log('');

  const runs = [];
  for (const model of modelNames) {
    process.stdout.write(`Running ${model}...`);
    const result = await runTranslation(apiKey, model, cases, targetLang);
    console.log(` done (${result.durationMs}ms)`);
    runs.push(result);
  }

  printReport(cases, runs);
  saveJson(cases, runs, values.output!);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
