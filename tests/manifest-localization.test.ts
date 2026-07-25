import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  default_locale?: string;
  name?: string;
  description?: string;
  action?: { default_title?: string };
};
const buildScript = readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8');

test('localizes public manifest metadata through English and Spanish locale catalogs', () => {
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.name, '__MSG_extensionName__');
  assert.equal(manifest.description, '__MSG_extensionDescription__');
  assert.equal(manifest.action?.default_title, '__MSG_extensionActionTitle__');

  for (const locale of ['en', 'es']) {
    const path = join(ROOT, 'src', '_locales', locale, 'messages.json');
    assert.equal(existsSync(path), true, `missing ${locale} manifest locale`);
    const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { message?: string }>;
    for (const key of ['extensionName', 'extensionDescription', 'extensionActionTitle']) {
      assert.ok(messages[key]?.message?.trim(), `missing ${locale}.${key}`);
    }
  }
});

test('copies and watches manifest locale catalogs in the loadable build', () => {
  assert.match(buildScript, /cp\(join\(ROOT, 'src\/_locales'\), join\(OUT, '_locales'\), \{ recursive: true \}\)/);
  assert.match(buildScript, /'src\/_locales'/);
});
