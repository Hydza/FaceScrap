import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'i'))?.[1];
  assert.ok(value, `missing ${selector} token block`);
  return value;
}

function token(selector: string, name: string): string {
  const value = block(selector).match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(value, `missing --${name} color token`);
  return value;
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

test('keeps normal-size text on the accent surface at WCAG AA contrast', () => {
  for (const selector of [':root', ':root[data-theme="light"]']) {
    assert.ok(contrast(token(selector, 'on-accent'), token(selector, 'accent')) >= 4.5, selector);
  }
});

test('keeps primary and supporting text at WCAG AA contrast in both themes', () => {
  for (const selector of [':root', ':root[data-theme="light"]']) {
    const canvas = token(selector, 'canvas');
    const surface = token(selector, 'surface');
    assert.ok(contrast(token(selector, 'text'), canvas) >= 4.5, `${selector} text/canvas`);
    assert.ok(contrast(token(selector, 'text'), surface) >= 4.5, `${selector} text/surface`);
    assert.ok(contrast(token(selector, 'muted'), canvas) >= 4.5, `${selector} muted/canvas`);
    assert.ok(contrast(token(selector, 'muted'), surface) >= 4.5, `${selector} muted/surface`);
  }
});

test('uses the muted light-theme color for the select chevron at sufficient contrast', () => {
  const light = block(':root[data-theme="light"]');
  assert.match(light, /--select-chevron:[^;]*stroke='%2359636e'/);
  assert.ok(contrast(token(':root[data-theme="light"]', 'muted'), token(':root[data-theme="light"]', 'surface')) >= 3);
});

test('light form controls have a visible non-text boundary', () => {
  assert.ok(
    contrast(
      token(':root[data-theme="light"]', 'control-line'),
      token(':root[data-theme="light"]', 'surface'),
    ) >= 3,
  );
  assert.match(css, /\.select,\s*\.set-input\s*\{[^}]*border:\s*1px solid var\(--control-line\)/s);
});

test('keeps media overlay tokens dark independently of the panel theme', () => {
  const root = block(':root');
  for (const name of ['media-overlay', 'media-surface', 'media-text', 'media-muted', 'media-line']) {
    assert.match(root, new RegExp(`--${name}:`), `missing --${name}`);
  }
  assert.ok(contrast(token(':root', 'media-text'), token(':root', 'media-surface')) >= 4.5);
  assert.ok(contrast(token(':root', 'media-muted'), token(':root', 'media-surface')) >= 4.5);
  assert.ok(contrast(token(':root', 'media-on-accent'), token(':root', 'media-accent')) >= 4.5);
  // The chips and the play control still sit ON the media, so they must keep the
  // dark media tokens whatever the panel theme is. (The Now Playing details block
  // stacks below the media now, and deliberately reads with the panel tokens.)
  assert.match(css, /\.preview-dur\s*\{[^}]*color:\s*var\(--media-text\)/s);
  assert.match(css, /\.preview-dur\s*\{[^}]*background:\s*var\(--media-control\)/s);
  assert.match(css, /\.preview-play\s*\{[^}]*background:\s*var\(--play-surface\)/s);
});
