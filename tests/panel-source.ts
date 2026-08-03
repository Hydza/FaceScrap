// Concatenate all side-panel TypeScript so source-contract tests ignore module boundaries.

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
