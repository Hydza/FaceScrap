// The side panel's source, as one string.
//
// Several tests assert that the panel does something — reads a setting through the
// shared helper, wires a listener, localises a label — by pattern-matching its
// source. They each used to read src/sidepanel/sidepanel.ts directly, which tied
// them to that one file: moving a function into a sibling module broke the test
// without changing any behaviour, and the failure looked like a regression.
//
// Reading the whole directory keeps the assertion where it belongs ("the panel does
// X") and lets the panel be split into modules without touching them.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'src', 'sidepanel');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every .ts file under src/sidepanel/, concatenated in a stable order. */
export function panelSource(): string {
  return walk(DIR)
    .sort()
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
