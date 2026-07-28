// Every `export` on a type in src/ must have an importer.
//
// This started as an assertion of mine that 48 exported types were "the named
// shapes of exported signatures, so exporting them is correct". That was a style
// argument dressed as a fact, and it was wrong: with isolatedModules on, a type can
// only reach another module through an import statement, so the question is exactly
// decidable. Asked properly — strip every type export, let tsc name the ones that
// break, iterate to a fixed point — the answer was 54 needed and 81 surplus. Zero
// were dead: each of the 81 is used inside its own file.
//
// The compiler is the authority, and it already runs in `npm run typecheck`: if a
// needed export goes missing, tsc says "declares X locally, but it is not exported"
// and the gate fails. This test guards the other direction, which tsc cannot see.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const srcFiles = walk(join(ROOT, 'src'));
const consumers = [...srcFiles, ...walk(join(ROOT, 'tests'))];

/** Every name any file pulls in through an import or a re-export. Import blocks
 *  span lines here, so this reads the whole clause rather than one line. */
function importedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

const imported = new Set<string>();
for (const file of consumers) for (const name of importedNames(readFileSync(file, 'utf8'))) imported.add(name);

test('exports no type that nothing imports', () => {
  const surplus: string[] = [];
  for (const file of srcFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^export (?:interface|type) (\w+)/gm)) {
      if (!imported.has(match[1]!)) surplus.push(`${file.slice(ROOT.length + 1)}: ${match[1]}`);
    }
  }
  assert.deepEqual(
    surplus.sort(),
    [],
    `these types are exported but nothing imports them — drop the export:\n${surplus.join('\n')}`,
  );
});

// Deleted from here: a second test asserting the exported-type count is exactly 54.
// It was a tripwire with no meaning of its own — it fails on any legitimate change
// to a module's public surface and cannot fail on a wrong one, which is precisely
// the kind of test this repo agreed to stop writing. The check above already covers
// the direction that matters.
