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

  // Every __MSG_key__ the manifest actually references, found rather than hand-listed. These keys
  // are Chrome's own i18n and never appear in the MsgKey union, so the panel's dead-key scan
  // cannot see them: a misspelt one renders as a raw __MSG_..__ in the browser UI with nothing to
  // catch it. The "commands" description is the newest of them.
  const referenced = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]!);
  assert.ok(referenced.includes('commandDownloadPlaying'), 'the keyboard command needs a localized description');

  for (const locale of ['en', 'es']) {
    const path = join(ROOT, 'src', '_locales', locale, 'messages.json');
    assert.equal(existsSync(path), true, `missing ${locale} manifest locale`);
    const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { message?: string }>;
    for (const key of referenced) {
      assert.ok(messages[key]?.message?.trim(), `missing ${locale}.${key}`);
    }
    // And nothing unread left behind: this catalog is small and hand-maintained.
    for (const key of Object.keys(messages)) {
      assert.ok(referenced.includes(key), `${locale}.${key} is in the catalog but the manifest never asks for it`);
    }
  }
});

test('copies and watches manifest locale catalogs in the loadable build', () => {
  assert.match(buildScript, /cp\(join\(ROOT, 'src\/_locales'\), join\(OUT, '_locales'\), \{ recursive: true \}\)/);
  assert.match(buildScript, /'src\/_locales'/);
});
