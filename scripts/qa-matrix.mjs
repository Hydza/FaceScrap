#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = join(ROOT, 'scripts', 'sidepanel-visual-qa.mjs');
const runs = [
  { browser: 'cft', language: 'en', theme: 'light' },
  { browser: 'cft', language: 'en', theme: 'dark' },
  { browser: 'cft', language: 'es', theme: 'light' },
  { browser: 'cft', language: 'es', theme: 'dark' },
];

for (const run of runs) {
  const label = `${run.browser}/${run.language}/${run.theme}`;
  process.stdout.write(`Running browser QA ${label}\n`);
  const result = spawnSync(
    process.execPath,
    [HARNESS, `--browser=${run.browser}`, `--lang=${run.language}`, `--theme=${run.theme}`],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Browser QA ${label} exited with ${result.status ?? 'no status'}`);
}

process.stdout.write(`Browser QA matrix passed (${runs.length} runs)\n`);
