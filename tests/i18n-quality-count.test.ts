import assert from 'node:assert/strict';
import test from 'node:test';

import { fmt, setLang, type Lang } from '../src/shared/i18n';

test('the resolution note keeps its count and its ceiling in both languages', () => {
  // Both independently rendered clauses must preserve their localized placeholders.
  try {
    for (const lang of ['en', 'es'] satisfies Lang[]) {
      setLang(lang);
      assert.match(fmt('resAvailable', { n: 4 }), /(^|\s)4(\s|$)/);
      assert.ok(fmt('resUpTo', { dims: '2560×1440' }).includes('2560×1440'));
    }
  } finally {
    setLang('en');
  }
});

test('fmt inserts a value containing "$" patterns literally instead of reinterpreting them', () => {
  // Replacement values must preserve literal "$&" and "$$" sequences.
  try {
    setLang('en');
    assert.equal(fmt('nowSave', { kind: '$&' }), 'Save $&');
    assert.equal(fmt('nowSave', { kind: '$$' }), 'Save $$');
  } finally {
    setLang('en');
  }
});
