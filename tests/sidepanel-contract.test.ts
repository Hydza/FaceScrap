import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { panelSource } from './panel-source';

const ROOT = process.cwd();
const HTML_PATH = join(ROOT, 'src', 'sidepanel', 'sidepanel.html');
// The panel may be split into modules; read the whole directory (see panel-source.ts).

const html = readFileSync(HTML_PATH, 'utf8');
const controller = panelSource();

function attributes(tag: string): Map<string, string> {
  return new Map(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1]!, match[2]!]),
  );
}

function elementTags(source: string, name: string): string[] {
  return [...source.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((match) => match[0]);
}

test('declares every static sidepanel id required by the controller exactly once', () => {
  const required = new Set<string>();
  for (const match of controller.matchAll(/\bbyId(?:<[^>]+>)?\(\s*'([^']+)'/g)) required.add(match[1]!);
  for (const match of controller.matchAll(/\bgetElementById\(\s*'([^']+)'/g)) required.add(match[1]!);

  const declared = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!);
  const counts = new Map<string, number>();
  for (const id of declared) counts.set(id, (counts.get(id) ?? 0) + 1);

  const missing = [...required].filter((id) => !counts.has(id));
  const duplicates = [...counts].filter(([, count]) => count !== 1).map(([id]) => id);
  assert.deepEqual(missing, []);
  assert.deepEqual(duplicates, []);
});

test('keeps the 2b route controls in one bottom navigation', () => {
  const navMatch = html.match(/<nav\b[^>]*id="views"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(navMatch, 'missing #views navigation');

  const buttons = elementTags(navMatch[1]!, 'button');
  const routeButtons = buttons.filter((tag) => attributes(tag).has('data-view'));
  const routes = routeButtons.map((tag) => attributes(tag).get('data-view'));
  assert.deepEqual(routes, ['now', 'library', 'saved']);

  for (const tag of routeButtons) {
    const attrs = attributes(tag);
    assert.equal(attrs.get('type'), 'button');
    assert.ok(attrs.has('aria-pressed'));
  }
  assert.equal(routeButtons.filter((tag) => attributes(tag).get('aria-pressed') === 'true').length, 1);

  const settings = buttons.find((tag) => attributes(tag).get('id') === 'settings-open');
  assert.ok(settings, '#settings-open must live in the bottom navigation');
  assert.equal(attributes(settings!).get('aria-expanded'), 'false');
  assert.equal(attributes(settings!).get('aria-controls'), 'settings');
  assert.equal(attributes(settings!).get('aria-pressed'), 'false');

  assert.ok(
    html.indexOf('id="views"') > html.indexOf('id="settings"'),
    '#views must follow the content and settings view in document order',
  );
});

test('names every settings control, whatever kind of control it is', () => {
  // The claim has not changed — every control carries an accessible name pointing at a
  // label that exists. What changed is the KINDS: the dropdowns became segmented button
  // groups, so half of these are now a <div role="group"> rather than an <input>/<select>,
  // and a group needs the name just as much.
  const labelledInputs = [
    'now-qselect',
    'set-template',
    'set-subfolder',
    'set-direct',
    'set-videosonly',
    'set-maxitems',
    'set-confirmclear',
    'set-diag',
    'set-keysenabled',
  ];
  for (const id of labelledInputs) {
    const tag = html.match(new RegExp(`<(?:input|select)\\b[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `missing #${id}`);
    const labelId = attributes(tag!).get('aria-labelledby');
    assert.ok(labelId, `#${id} must have aria-labelledby`);
    assert.match(html, new RegExp(`\\bid="${labelId}"`), `missing label #${labelId}`);
  }

  for (const name of ['quality', 'theme', 'order', 'cols', 'backdrop', 'corners', 'minres']) {
    const tag = html.match(new RegExp(`<div\\b[^>]*data-seg="${name}"[^>]*>`))?.[0];
    assert.ok(tag, `missing segmented control ${name}`);
    const attrs = attributes(tag!);
    assert.equal(attrs.get('role'), 'group', `${name} must be a labelled group`);
    const labelId = attrs.get('aria-labelledby');
    assert.ok(labelId, `${name} must have aria-labelledby`);
    assert.match(html, new RegExp(`\\bid="${labelId}"`), `missing label #${labelId}`);
  }
  // The accent row has no text of its own at all, so its group name is the only one there is.
  const accent = html.match(/<div\b[^>]*id="set-accent"[^>]*>/)?.[0];
  assert.ok(accent, 'missing #set-accent');
  assert.match(html, new RegExp(`\\bid="${attributes(accent!).get('aria-labelledby')}"`));

  // Auto/EN/ES is one control over two stored facts, and exactly one of the three is lit.
  const langMatch = html.match(/<div\b[^>]*id="lang"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(langMatch, 'missing #lang');
  const langChoices = elementTags(langMatch[1]!, 'button');
  assert.deepEqual(langChoices.map((tag) => attributes(tag).get('data-lang')), ['auto', 'en', 'es']);
  assert.equal(langChoices.filter((tag) => attributes(tag).get('aria-pressed') === 'true').length, 1);
});

test('keeps filter and settings values compatible with the runtime contracts', () => {
  const filterMatch = html.match(/<nav\b[^>]*id="filters"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(filterMatch, 'missing #filters navigation');
  const filterButtons = elementTags(filterMatch[1]!, 'button');
  assert.deepEqual(
    filterButtons.map((tag) => attributes(tag).get('data-filter')),
    ['all', 'video', 'image'],
  );
  assert.equal(filterButtons.filter((tag) => attributes(tag).get('aria-pressed') === 'true').length, 1);

  const checkboxes = ['set-subfolder', 'set-direct', 'set-confirmclear', 'set-videosonly', 'set-diag', 'set-keysenabled'];
  for (const id of checkboxes) assert.match(html, new RegExp(`<input\\b[^>]*id="${id}"[^>]*type="checkbox"`));

  // Same claim as when these were <option value>s: what the markup offers has to be what
  // normalizeSettings accepts, or a lit button writes a value the schema throws away.
  const segValues = (name: string): string[] => {
    const match = html.match(new RegExp(`<div\\b[^>]*data-seg="${name}"[^>]*>([\\s\\S]*?)<\\/div>`));
    assert.ok(match, `missing segmented control ${name}`);
    return [...match[1]!.matchAll(/<button\b[^>]*data-value="([^"]+)"/g)].map((item) => item[1]!);
  };
  assert.deepEqual(segValues('quality'), ['highest', 'lowest', 'ask']);
  assert.deepEqual(segValues('theme'), ['auto', 'light', 'dark']);
  assert.deepEqual(segValues('order'), ['newest', 'oldest']);
  assert.deepEqual(segValues('backdrop'), ['solid', 'frosted', 'glass']);
  assert.deepEqual(segValues('corners'), ['sharp', 'soft', 'round']);
  // 480 was dropped when this became four buttons on one line; the four that remain are the
  // steps worth a tap, and normalizeSettings still coerces anything else to the default.
  assert.deepEqual(segValues('minres'), ['0', '360', '720', '1080']);
  // Exactly one button pressed per group, so nothing opens claiming two values at once.
  for (const name of ['quality', 'theme', 'order', 'cols', 'backdrop', 'corners', 'minres']) {
    const match = html.match(new RegExp(`<div\\b[^>]*data-seg="${name}"[^>]*>([\\s\\S]*?)<\\/div>`))![1]!;
    const pressed = [...match.matchAll(/aria-pressed="true"/g)];
    assert.equal(pressed.length, 1, `${name} must open with exactly one value pressed`);
  }
});

test('exposes an accessible bilingual theme preference control', () => {
  // "Auto" needs its hint announced, not merely printed beside it: what automatic MEANS here
  // (Facebook first, then the device) is not guessable from the word. That is the one thing
  // this test is really holding, and it survived the control becoming a button group.
  const tag = html.match(/<div\b[^>]*data-seg="theme"[^>]*>/)?.[0];
  assert.ok(tag, 'missing the theme control');
  const attrs = attributes(tag);
  assert.equal(attrs.get('aria-labelledby'), 'label-set-theme');
  assert.equal(attrs.get('aria-describedby'), 'hint-set-theme');
  assert.match(html, /id="label-set-theme"[^>]*data-i18n="settingsTheme"/);
  assert.match(html, /id="hint-set-theme"[^>]*data-i18n="settingsThemeHint"/);
  assert.match(html, /data-value="auto"[^>]*data-i18n="themeAuto"/);
  assert.match(html, /data-value="light"[^>]*data-i18n="themeLight"/);
  assert.match(html, /data-value="dark"[^>]*data-i18n="themeDark"/);
});

test('localizes theme labels and the automatic-theme hint in English and Spanish', () => {
  const i18n = readFileSync(join(ROOT, 'src', 'shared', 'i18n.ts'), 'utf8');
  for (const key of ['settingsTheme', 'settingsThemeHint', 'themeAuto', 'themeLight', 'themeDark']) {
    assert.match(i18n, new RegExp(`\\| '${key}'`), `missing MsgKey ${key}`);
  }
  assert.match(i18n, /settingsTheme:\s*'Theme'/);
  assert.match(i18n, /settingsThemeHint:\s*'Follows Facebook, then your device'/);
  assert.match(i18n, /themeAuto:\s*'Auto'/);
  assert.match(i18n, /themeLight:\s*'Light'/);
  assert.match(i18n, /themeDark:\s*'Dark'/);
  assert.match(i18n, /settingsTheme:\s*'Tema'/);
  assert.match(i18n, /settingsThemeHint:\s*'Sigue Facebook y luego tu dispositivo'/);
  assert.match(i18n, /themeAuto:\s*'Automático'/);
  assert.match(i18n, /themeLight:\s*'Claro'/);
  assert.match(i18n, /themeDark:\s*'Oscuro'/);
});

// Dropped: a sixteen-regex mirror of sidepanel.ts's theme wiring, down to
// `const revision = ++themeUpdateRevision`. resolveEffectiveTheme's precedence is
// tested for real in theme.test.ts, and the stored side in
// facebook-theme-storage.test.ts.

test('exposes max saved items as a bounded-length digits-only text input', () => {
  const tag = html.match(/<input\b[^>]*id="set-maxitems"[^>]*>/)?.[0];
  assert.ok(tag, 'missing editable #set-maxitems input');

  const attrs = attributes(tag);
  assert.equal(attrs.get('type'), 'text');
  assert.equal(attrs.get('inputmode'), 'numeric');
  assert.equal(attrs.get('pattern'), '[0-9]*');
  assert.equal(attrs.get('maxlength'), '16');
  assert.equal(attrs.get('aria-labelledby'), 'label-set-maxitems');
});

// Five tests regex-matching the retention field's wiring in TS source used to sit here. They
// asserted the shape of the code, not its behaviour, and outside the CSS/HTML/manifest/i18n
// exception — a rename or an equivalent rewrite failed them, and a broken field could not.
// What they were reaching for is already covered properly: sanitizeMaxItemsInput and
// parseMaxItemsInput are pure and behaviour-tested in settings.test.ts, and the markup contract
// (type, inputmode, pattern, maxlength, label) is asserted above, where the source IS the artifact.

// This used to only assert that SOME inline 32x32 <svg> sat in the brand, which
// is exactly how the header's private copy of the glyph drifted away from the
// logo.svg the toolbar icons are built from — two different logos, both "valid".
// The property worth pinning is single-sourcing, not the presence of a tag.
test('the header brand mark and the icon generator read the exact same logo.svg — no duplicated glyph', () => {
  const brand = html.match(/<span\b[^>]*class="brand-logo"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(brand, 'missing .brand-logo');
  assert.match(
    brand[1]!,
    /<img\b[^>]*src="icons\/logo\.svg"/,
    'the header must render icons/logo.svg, not a private copy of the mark',
  );
  assert.doesNotMatch(
    brand[1]!,
    /<svg\b/,
    'the header must not reintroduce an inline glyph — logo.svg is the only source of the brand mark',
  );

  const generator = readFileSync(join(ROOT, 'scripts', 'generate-icons.mjs'), 'utf8');
  assert.match(
    generator,
    /join\(ROOT,\s*'src',\s*'sidepanel',\s*'icons',\s*'logo\.svg'\)/,
    "generate-icons.mjs must read src/sidepanel/icons/logo.svg — the exact file the header's <img src=\"icons/logo.svg\"> resolves to from src/sidepanel/sidepanel.html",
  );
});
