// Check numeric CSS bounds for the Now Playing resolution picker.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

const triggerRule = css.match(/\.picker-trigger\s*\{([^}]*)\}/)?.[1];
// Select the picker rule that contains its geometry declarations.
const listRule = css.match(/\.picker-list\s*\{([^}]*position:[^}]*)\}/)?.[1];
const compactHeightCss = css.slice(
  css.indexOf('@media (max-height: 650px)'),
  css.indexOf('@media (prefers-reduced-motion: reduce)'),
);

test('drops the picker chevron when there is only one option to pick', () => {
  // Hide the caret when the control cannot open.
  assert.match(css, /\.picker-trigger:disabled \.picker-caret\s*\{[^}]*display:\s*none/s);
});

test('keeps the resolution trigger one flat field height whatever the option count', () => {
  assert.ok(triggerRule, 'missing .picker-trigger rule');
  const height = Number(triggerRule.match(/height:\s*(\d+)px;/)?.[1]);
  assert.ok(Number.isFinite(height), 'missing pixel height for .picker-trigger');
  // Keep the shared field height within the 30–44 px target range.
  assert.ok(
    height >= 30 && height <= 44,
    `expected .picker-trigger height within the 30–44px field range, received ${height}px`,
  );
  assert.match(triggerRule, /width:\s*100%/, 'the trigger is level with the button below it');
  // Leave room for label, dimensions, and size without native-chevron padding.
  assert.doesNotMatch(triggerRule, /padding-right:/);
  assert.doesNotMatch(triggerRule, /width:\s*min\(100%,\s*\d+px\)/);
});

test('floats the open list over the media instead of resizing the frame', () => {
  assert.ok(listRule, 'missing .picker-list rule');
  // Position the list out of flow so opening it does not resize the media.
  assert.match(listRule, /position:\s*absolute/);
  assert.match(listRule, /bottom:\s*calc\(100% \+ 6px\)/);
  assert.match(listRule, /z-index:\s*30/);
  // Scroll long option lists within the panel bounds.
  assert.match(listRule, /max-height:\s*\d+px/);
});

test('pauses the edge light instead of blinking it once for reduced motion', () => {
  // Disable the continuous spinner under reduced motion.
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
