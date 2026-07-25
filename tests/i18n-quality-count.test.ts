import assert from 'node:assert/strict';
import test from 'node:test';

import { fmt, setLang, type Lang } from '../src/shared/i18n';

test('quality option counts render as digits only in English and Spanish', () => {
  try {
    for (const lang of ['en', 'es'] satisfies Lang[]) {
      setLang(lang);
      assert.equal(fmt('qualityOptionsOne', { n: 1 }), '1');
      assert.equal(fmt('qualityOptions', { n: 3 }), '3');
    }
  } finally {
    setLang('en');
  }
});

test('fmt inserts a value containing "$" patterns literally instead of reinterpreting them', () => {
  // A string-pattern replace() treats "$&" as "re-insert the match" (i.e. the
  // literal placeholder text) and "$$" as a literal single "$" — a value is
  // never itself a replacement pattern, so both must survive untouched.
  try {
    setLang('en');
    assert.equal(fmt('downloadKind', { label: '$&' }), 'Download $&');
    assert.equal(fmt('downloadKind', { label: '$$' }), 'Download $$');
  } finally {
    setLang('en');
  }
});
