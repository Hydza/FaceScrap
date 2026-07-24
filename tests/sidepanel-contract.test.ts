import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const HTML_PATH = join(ROOT, 'src', 'sidepanel', 'sidepanel.html');
const CONTROLLER_PATH = join(ROOT, 'src', 'sidepanel', 'sidepanel.ts');

const html = readFileSync(HTML_PATH, 'utf8');
const controller = readFileSync(CONTROLLER_PATH, 'utf8');

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

test('names the quality and settings controls and exposes language selection state', () => {
  const labelledControls = [
    'now-qselect',
    'set-template',
    'set-subfolder',
    'set-quality',
    'set-direct',
    'set-followlang',
    'set-theme',
    'set-order',
    'set-videosonly',
    'set-minres',
    'set-maxitems',
    'set-confirmclear',
    'set-diag',
  ];
  for (const id of labelledControls) {
    const tag = html.match(new RegExp(`<(?:input|select)\\b[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `missing #${id}`);
    const labelId = attributes(tag!).get('aria-labelledby');
    assert.ok(labelId, `#${id} must have aria-labelledby`);
    assert.match(html, new RegExp(`\\bid="${labelId}"`), `missing label #${labelId}`);
  }

  const langMatch = html.match(/<div\b[^>]*id="lang"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(langMatch, 'missing #lang');
  const langButtons = elementTags(langMatch[1]!, 'button');
  assert.deepEqual(langButtons.map((tag) => attributes(tag).get('aria-pressed')), ['true', 'false']);
});

test('delegates navigation by semantic data attributes instead of visual classes', () => {
  assert.match(controller, /closest<HTMLButtonElement>\('\[data-view\]'\)/);
  assert.match(controller, /closest<HTMLButtonElement>\('\[data-filter\]'\)/);
  assert.match(controller, /closest<HTMLButtonElement>\('\[data-lang\]'\)/);
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

  const checkboxes = ['set-subfolder', 'set-direct', 'set-followlang', 'set-confirmclear', 'set-videosonly', 'set-diag'];
  for (const id of checkboxes) assert.match(html, new RegExp(`<input\\b[^>]*id="${id}"[^>]*type="checkbox"`));

  const optionValues = (id: string): string[] => {
    const match = html.match(new RegExp(`<select\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`));
    assert.ok(match, `missing #${id}`);
    return [...match[1]!.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map((item) => item[1]!);
  };
  assert.deepEqual(optionValues('set-quality'), ['highest', 'lowest', 'ask']);
  assert.deepEqual(optionValues('set-theme'), ['auto', 'light', 'dark']);
  assert.deepEqual(optionValues('set-order'), ['newest', 'oldest']);
  assert.deepEqual(optionValues('set-minres'), ['0', '360', '480', '720', '1080']);
});

test('exposes an accessible bilingual theme preference control in Panel settings', () => {
  const tag = html.match(/<select\b[^>]*id="set-theme"[^>]*>/)?.[0];
  assert.ok(tag, 'missing #set-theme');
  const attrs = attributes(tag);
  assert.equal(attrs.get('aria-labelledby'), 'label-set-theme');
  assert.equal(attrs.get('aria-describedby'), 'hint-set-theme');
  assert.match(html, /id="label-set-theme"[^>]*data-i18n="settingsTheme"/);
  assert.match(html, /id="hint-set-theme"[^>]*data-i18n="settingsThemeHint"/);
  assert.match(html, /value="auto"[^>]*data-i18n="themeAuto"/);
  assert.match(html, /value="light"[^>]*data-i18n="themeLight"/);
  assert.match(html, /value="dark"[^>]*data-i18n="themeDark"/);
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

test('keeps preference and effective theme state separate and reactive', () => {
  assert.match(controller, /resolveEffectiveTheme/);
  assert.match(controller, /document\.documentElement\.dataset\.theme\s*=/);
  assert.match(controller, /getFacebookTheme\(trackedTab\)/);
  assert.match(controller, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(controller, /systemThemeQuery\.addEventListener\('change'/);
  assert.match(controller, /systemThemeQuery\.addListener\(handleSystemThemeChange\)/);
  assert.match(controller, /chrome\.storage\.local\.onChanged\.addListener/);
  assert.match(controller, /chrome\.storage\.session\.onChanged\.addListener/);
  assert.match(controller, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(controller, /chrome\.tabs\.getCurrent\(\)/);
  assert.match(controller, /if \(info\.tabId === ownPanelTabId\) return/);
  assert.match(controller, /chrome\.runtime\.getURL\('sidepanel\/sidepanel\.html'\)/);
  assert.match(controller, /activatedTab\?\.url === ownPanelUrl \|\| activatedTab\?\.pendingUrl === ownPanelUrl/);
  assert.match(controller, /document\.documentElement\.dataset\.trackedTab/);
  assert.match(controller, /const revision = \+\+themeUpdateRevision/);
  assert.match(controller, /revision !== themeUpdateRevision \|\| trackedTab !== tabId/);
});

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

test('sanitizes the max saved items draft on input', () => {
  assert.match(controller, /const maxItemsInput = byId<HTMLInputElement>\('set-maxitems'\)/);
  assert.match(controller, /maxItemsInput\.addEventListener\('input'/);
  assert.match(controller, /sanitizeMaxItemsInput/);
});

test('parses the max saved items value before committing a change', () => {
  assert.match(controller, /maxItemsInput\.addEventListener\('change'/);
  assert.match(controller, /parseMaxItemsInput/);
});

test('reverts an invalid max saved items commit without saving it', () => {
  assert.match(
    controller,
    /if \(maxItems === undefined\) \{\s*maxItemsInput\.value = String\(settings\.maxItems\);\s*return;\s*\}/,
  );
});

test('saves a valid max saved items commit only when the value changed', () => {
  assert.match(controller, /if \(maxItems !== settings\.maxItems\) void applySetting\(\{ maxItems \}\)/);
});

test('commits max saved items from the keyboard by blurring on Enter', () => {
  assert.match(
    controller,
    /maxItemsInput\.addEventListener\('keydown',[\s\S]*?if \(e\.key !== 'Enter'\) return;[\s\S]*?maxItemsInput\.blur\(\)/,
  );
});

test('keeps the build-time 32px logo source in the brand', () => {
  const brand = html.match(/<span\b[^>]*class="brand-logo"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(brand, 'missing .brand-logo');
  assert.match(brand[1]!, /<svg\b[^>]*viewBox="0 0 32 32"/);
});
