import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const source = await readFile(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

test('thumbnail load recalculates only its own media container', () => {
  assert.match(source, /function applyMediaFit\(image: HTMLImageElement, container: HTMLElement\)/);
  assert.match(source, /schedulePlayPositions\(container\)/);
  // renderCard's and paintNow's own `addEventListener('load', () =>
  // applyMediaFit(img, thumb))` calls were consolidated into the shared
  // buildThumbPair builder (finding S5 — see tests/fix-sidepanel.test.ts).
  // buildThumbPair takes its OWN `container` parameter per call (renderCard
  // passes its own `thumb`, paintNow its own `preview`), so each thumbnail's
  // load handler still recalculates against only its own container, not a
  // shared one — that per-call parameter is what this test still needs to prove.
  assert.match(
    source,
    /img\.addEventListener\('load', \(\) => \{\s*applyMediaFit\(img, container\);\s*options\.onLoad\?\.\(img\);\s*\}\);/,
  );
});

test('a global play-position pass measures every target before applying DOM writes', () => {
  assert.match(source, /const measurements = targets\.map\(measureMediaPlay\);/);
  assert.match(source, /measurements\.forEach\(applyMediaPlay\);/);
});

test('closing Settings cancels and guards its deferred focus', () => {
  assert.match(source, /let settingsFocusFrame: number \| undefined;/);
  assert.match(source, /window\.cancelAnimationFrame\(settingsFocusFrame\)/);
  assert.match(source, /if \(!sheet\.hidden\) byId<HTMLInputElement>\('set-template'\)\.focus\(\)/);
});
