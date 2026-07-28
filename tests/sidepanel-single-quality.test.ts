// Geometry of the Now Playing resolution picker. The CSS is the artifact here —
// these are numeric bounds on it, which nothing else can check without a browser.
//
// Four tests that mirrored sidepanel.ts's source lines (which ternary sets the
// count, which classList.toggle runs, how the render hold is computed) were
// dropped: they broke on refactors of correct code and could not observe a wrong
// count. The states they described are captured for real by `npm run qa:sidepanel`,
// which drives the built panel over CDP in both languages.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

const triggerRule = css.match(/\.picker-trigger\s*\{([^}]*)\}/)?.[1];
// Matched by content: .picker-list also appears in the grouped rule that hides every
// scrollbar, and matching that one would read a block with no geometry in it at all.
const listRule = css.match(/\.picker-list\s*\{([^}]*position:[^}]*)\}/)?.[1];
const compactHeightCss = css.slice(
  css.indexOf('@media (max-height: 650px)'),
  css.indexOf('@media (prefers-reduced-motion: reduce)'),
);

test('drops the picker chevron when there is only one option to pick', () => {
  // A caret on a control that cannot open is a promise the panel does not keep.
  assert.match(css, /\.picker-trigger:disabled \.picker-caret\s*\{[^}]*display:\s*none/s);
});

test('keeps the resolution trigger one flat field height whatever the option count', () => {
  assert.ok(triggerRule, 'missing .picker-trigger rule');
  const height = Number(triggerRule.match(/height:\s*(\d+)px;/)?.[1]);
  assert.ok(Number.isFinite(height), 'missing pixel height for .picker-trigger');
  // The design fixes this at 38px — the field/row height the whole panel shares. Guard
  // both ends: the original bug was an oversized control, and anything under 30 stops
  // being a comfortable target.
  assert.ok(
    height >= 30 && height <= 44,
    `expected .picker-trigger height within the 30–44px field range, received ${height}px`,
  );
  assert.match(triggerRule, /width:\s*100%/, 'the trigger is level with the button below it');
  // Its three columns carry the label, the dimensions and the size estimate. A fixed
  // right padding reserving room for a native chevron would squeeze all three.
  assert.doesNotMatch(triggerRule, /padding-right:/);
  assert.doesNotMatch(triggerRule, /width:\s*min\(100%,\s*\d+px\)/);
});

test('floats the open list over the media instead of resizing the frame', () => {
  assert.ok(listRule, 'missing .picker-list rule');
  // Anchored to the trigger's top edge and taken out of flow: the media above must not
  // lose height the moment the list opens, or the whole view jumps under the cursor.
  assert.match(listRule, /position:\s*absolute/);
  assert.match(listRule, /bottom:\s*calc\(100% \+ 6px\)/);
  assert.match(listRule, /z-index:\s*30/);
  // A long ladder has to scroll rather than grow past the panel's top edge.
  assert.match(listRule, /max-height:\s*\d+px/);
});

test('pauses the edge light instead of blinking it once for reduced motion', () => {
  // The spin is the panel's only continuous animation. The global reduced-motion rule
  // clamps every animation to one 0.01ms iteration, which for a rotation means it
  // freezes at a random angle — so this one is stopped outright.
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.picker-edge::before\s*\{[^}]*animation:\s*none/s);
});

test('keeps the numeric multi-option count visible in short panels', () => {
  assert.ok(compactHeightCss.startsWith('@media (max-height: 650px)'), 'missing short-panel rules');
  assert.doesNotMatch(
    compactHeightCss,
    /\.quality-head\s*\{[^}]*display:\s*none;/s,
    'short panels must not hide the multi-option count',
  );
  assert.doesNotMatch(
    compactHeightCss,
    /\.quality\s*\{[^}]*display:\s*none;/s,
    'short panels must not hide the resolution control itself',
  );
});
