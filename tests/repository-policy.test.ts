import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface CommentRecord {
  readonly line: number;
  readonly text: string;
}

interface AuthorMetadata {
  readonly packageAuthor: string;
  readonly manifestAuthor: string;
  readonly licenseText: string;
  readonly historyAuthors: readonly string[];
}

interface PolicyModule {
  analyzeComment(value: string): string[];
  collectComments(filePath: string, source: string): CommentRecord[];
  findRestrictedTerms(value: string): string[];
  validateAuthorMetadata(metadata: AuthorMetadata): string[];
}

const ROOT = process.cwd();
const POLICY_PATH = join(ROOT, 'scripts', 'repository-policy.mjs');

async function loadPolicy(): Promise<PolicyModule> {
  return (await import(pathToFileURL(POLICY_PATH).href)) as PolicyModule;
}

test('the content rule recognizes restricted references without storing literal references', async () => {
  const policy = await loadPolicy();
  const restricted = String.fromCharCode(111, 112, 101, 110, 97, 105);

  assert.equal(policy.findRestrictedTerms(restricted).length, 1);
  assert.deepEqual(policy.findRestrictedTerms('browser extension capture'), []);
  assert.deepEqual(policy.findRestrictedTerms(readFileSync(POLICY_PATH, 'utf8')), []);
});

test('comment extraction ignores strings and keeps source line numbers', async () => {
  const policy = await loadPolicy();
  const source = [
    "const text = '// Este comentario no es comentario de código.';",
    '// Keep the request alive until storage settles.',
    'const ready = true;',
  ].join('\n');

  assert.deepEqual(policy.collectComments('fixture.ts', source), [
    { line: 2, text: '// Keep the request alive until storage settles.' },
  ]);
});

test('comment extraction advances through regular expressions and template literals', async () => {
  const policy = await loadPolicy();
  const source = [
    'const pattern = /#(?!!)/;',
    '// Describe the current regular expression.',
    "const scheme = 'https';",
    'const color = `${scheme}://example.test/#2b`;',
    "const rendered = `${/}/.test('}')}`;",
    '// Describe the current template literal.',
  ].join('\n');

  assert.deepEqual(policy.collectComments('fixture.ts', source), [
    { line: 2, text: '// Describe the current regular expression.' },
    { line: 6, text: '// Describe the current template literal.' },
  ]);
});

test('comment rules accept direct English and reject non-English or obsolete explanations', async () => {
  const policy = await loadPolicy();

  assert.deepEqual(policy.analyzeComment('// Keep the request alive until storage settles.'), []);
  assert.deepEqual(policy.analyzeComment('<!-- Keep the page metadata concise. -->'), []);
  assert.deepEqual(policy.analyzeComment('<!-- Keep the page metadata concise. --!>'), []);
  assert.deepEqual(policy.analyzeComment('// Match "Resolución mínima" when the input omits accents.'), []);
  assert.ok(policy.analyzeComment('// Este comentario explica porque guarda el archivo.').length > 0);
  assert.ok(policy.analyzeComment('// This used to retry the request.').length > 0);
  assert.ok(policy.analyzeComment('// const retry = true;').length > 0);
  assert.ok(policy.analyzeComment('// TODO: simplify this branch.').length > 0);
});

test('author rules require Hydza in project metadata and reachable history', async () => {
  const policy = await loadPolicy();
  const valid: AuthorMetadata = {
    packageAuthor: 'Hydza',
    manifestAuthor: 'Hydza',
    licenseText: 'Copyright (c) 2026 Hydza',
    historyAuthors: ['Hydza'],
  };

  assert.deepEqual(policy.validateAuthorMetadata(valid), []);
  assert.ok(
    policy.validateAuthorMetadata({
      ...valid,
      manifestAuthor: 'Another author',
      historyAuthors: ['Hydza', 'Another author'],
    }).length >= 2,
  );
  assert.ok(
    policy.validateAuthorMetadata({
      ...valid,
      licenseText: `${valid.licenseText}\nCopyright (c) 2026 Another author`,
    }).length > 0,
  );
});
