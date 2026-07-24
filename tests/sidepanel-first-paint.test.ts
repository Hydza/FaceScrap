import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
const css = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.css'), 'utf8');
const controller = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

test('keeps untranslated and unresolved-theme content out of paint and accessibility during boot', () => {
  assert.match(html, /<html\b[^>]*\bdata-boot="pending"/);
  assert.match(
    html,
    /<div\b[^>]*id="app"[^>]*\binert\b[^>]*\baria-hidden="true"[^>]*\baria-busy="true"/,
  );
  assert.match(
    css,
    /:root\[data-boot="pending"\]\s+body\s*\{[^}]*visibility:\s*hidden/s,
  );
  assert.match(
    css,
    /:root\[data-boot="pending"\][\s\S]*?:root\[data-boot="pending"\]\s+body\s*\{\s*background:\s*transparent;/,
  );
});

test('reveals the panel only after its effective theme and language are applied', () => {
  const init = controller.match(/async function init\(\): Promise<void> \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(init, 'missing init()');

  const applyTheme = init!.indexOf('await applyEffectiveTheme()');
  const registerThemeListener = init!.indexOf('setupFacebookThemeStorageListener()');
  const resolveLanguage = init!.indexOf('setLang(await resolveLang())');
  const localizeStaticContent = init!.indexOf('localize()');
  const reveal = init!.indexOf("finishPanelBoot('ready')");
  const initialRender = init!.lastIndexOf('await render()');

  assert.ok(registerThemeListener >= 0, 'init must register the Facebook-theme listener');
  assert.ok(registerThemeListener < applyTheme, 'theme listener must exist before the first asynchronous theme read');
  assert.ok(applyTheme >= 0, 'init must apply the effective theme');
  assert.ok(resolveLanguage > applyTheme, 'language must resolve after startup settings and theme');
  assert.ok(localizeStaticContent > resolveLanguage, 'static content must be localized before reveal');
  assert.ok(reveal > localizeStaticContent, 'the panel must reveal only after theme and language are painted');
  assert.ok(initialRender > localizeStaticContent, 'the initial view must render after localization');
  assert.ok(reveal > initialRender, 'the panel must reveal only after its initial view is ready');
});

test('closes startup and rapid-switch gaps when tracking the active tab', () => {
  assert.match(controller, /let activationRevision = 0;/);
  assert.match(
    controller,
    /const revision = \+\+activationRevision;[\s\S]*?await chrome\.tabs\.get\(info\.tabId\)[\s\S]*?if \(revision !== activationRevision\) return;/,
  );
  assert.match(
    controller,
    /chrome\.tabs\.onActivated\.addListener[\s\S]*?await chrome\.tabs\.query\(\{ active: true, windowId \}\)/,
  );
});

test('removes temporary accessibility guards on success and exposes only a fatal fallback on failure', () => {
  assert.match(
    controller,
    /function finishPanelBoot\(state: 'ready' \| 'error'\): void \{[\s\S]*?dataset\.boot = state;[\s\S]*?removeAttribute\('inert'\);[\s\S]*?removeAttribute\('aria-hidden'\);[\s\S]*?removeAttribute\('aria-busy'\);[\s\S]*?\}/,
  );

  const fatal = controller.match(/function showFatal\(e: unknown\): void \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(fatal, 'missing showFatal()');
  assert.ok(
    fatal!.indexOf("finishPanelBoot('error')") < fatal!.indexOf('el.hidden = false'),
    'the fatal surface must be revealed before its message is painted',
  );
  assert.match(
    css,
    /:root\[data-boot="error"\]\s+#app\s*>\s*:not\(#fatal\)\s*\{[^}]*display:\s*none\s*!important/s,
  );
});
