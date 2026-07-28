import assert from 'node:assert/strict';
import test from 'node:test';

import { fmt, setLang, type Lang } from '../src/shared/i18n';

test('the resolution note keeps its count and its ceiling in both languages', () => {
  // The note is assembled from two independent halves so the "up to" clause can be
  // dropped when the representation declared no dimensions. Both halves have to carry
  // their placeholder through in each language, or the panel prints "{n} available".
  try {
    for (const lang of ['en', 'es'] satisfies Lang[]) {
      setLang(lang);
      assert.match(fmt('resAvailableOne', { n: 1 }), /(^|\s)1(\s|$)/);
      assert.match(fmt('resAvailable', { n: 4 }), /(^|\s)4(\s|$)/);
      assert.ok(fmt('resUpTo', { dims: '2560×1440' }).includes('2560×1440'));
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
    assert.equal(fmt('nowSave', { kind: '$&' }), 'Save $&');
    assert.equal(fmt('nowSave', { kind: '$$' }), 'Save $$');
  } finally {
    setLang('en');
  }
});
