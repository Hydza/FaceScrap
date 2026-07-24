import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const source = await readFile(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

test('thumbnail load recalculates only its own media container', () => {
  assert.match(source, /function applyMediaFit\(image: HTMLImageElement, container: HTMLElement\)/);
  assert.match(source, /schedulePlayPositions\(container\)/);
  assert.match(source, /addEventListener\('load', \(\) => applyMediaFit\(img, thumb\)\)/);
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
