// Regression tests for the UI/design audit pass. One test per fix, all of them
// static assertions over the source: these are CSS/HTML/token invariants and
// copy contracts, which the DOM-less unit suite can pin without a browser.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');
const html = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
const panel = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
const i18n = readFileSync(join(process.cwd(), 'src', 'shared', 'i18n.ts'), 'utf8');

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'i'))?.[1];
  assert.ok(value, `missing ${selector} block`);
  return value;
}

function token(selector: string, name: string): string {
  const value = block(selector).match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(value, `missing --${name} in ${selector}`);
  return value;
}

// Every surface used to style its scrollbar differently: .grid and .now painted a
// visible 10px thumb while .settings-body hid its own, so the bar appeared on two
// tabs out of four. Scrollbars are now invisible everywhere.
test('hides the scrollbar on every container that scrolls, with one rule', () => {
  const scrollers = [...css.matchAll(/^(\.[\w-]+)[^{]*\{[^}]*overflow:[^;]*auto[^;]*;/gms)].map((m) => m[1]!);
  assert.deepEqual(new Set(scrollers), new Set(['.grid', '.now', '.settings-body']), 'scrolling containers changed');

  for (const selector of scrollers) {
    assert.match(
      css,
      new RegExp(`\\${selector}::-webkit-scrollbar[^{]*\\{[^}]*width:\\s*0`, 's'),
      `${selector} must zero its ::-webkit-scrollbar width`,
    );
  }
  // ::-webkit-scrollbar is what actually works on the supported Chrome 116+
  // floor; scrollbar-width only lands in 121, so it may accompany but not replace.
  assert.match(css, /scrollbar-width:\s*none/);
  assert.doesNotMatch(css, /--scroll-thumb/, 'the thumb tokens are dead once nothing paints a thumb');
});

// #now-qselect:disabled forced --media-text (pinned #ffffff for overlay chips)
// while its background is --field (#ffffff in the light theme), so a video with a
// single quality rendered the resolution as white-on-white.
test('paints the disabled resolution select with a theme-aware colour', () => {
  const disabled = block('#now-qselect:disabled');
  assert.doesNotMatch(disabled, /--media-text/, 'must not reuse the fixed-white media token off the media');
  assert.match(disabled, /color:\s*var\(--text\)/);
  assert.match(disabled, /-webkit-text-fill-color:\s*var\(--text\)/);

  for (const selector of [':root', ':root[data-theme="light"]']) {
    assert.ok(
      contrast(token(selector, 'text'), token(selector, 'field')) >= 4.5,
      `${selector} text/field`,
    );
  }
});

// play.svg already centres its own triangle (box at x 9-17 of a 24 viewBox) and
// both call sites centre the file again, so the extra margin only pushed Now
// Playing's play glyph off-centre relative to the grid thumbnails'.
test('centres the play glyph identically in Now Playing and the grid', () => {
  assert.doesNotMatch(block('.preview-play::before'), /margin/, 'no nudge margin on an already-centred mask');
  assert.match(block('.card-thumb.is-video::after'), /background-position:\s*center/);
});

// Both corner controls share the 26px box from the .pick,.card-dl block. .pick
// used to shrink itself to 22px, which rode 2px higher than .card-dl at the same
// `top` and also missed the 24px WCAG 2.5.8 target minimum.
test('gives the card corner controls one shared box and a 24px-plus target', () => {
  const shared = block('.pick,\n.card-dl');
  const size = shared.match(/width:\s*(\d+)px/)?.[1];
  assert.ok(size && Number(size) >= 24, `shared corner control must be >= 24px, got ${size}`);
  assert.match(shared, new RegExp(`height:\\s*${size}px`), 'corner controls must be square');
  assert.doesNotMatch(block('.pick'), /width:|height:/, '.pick must not re-shrink below the shared box');

  // .link-btn reaches 24px through padding around an 18px line box.
  const link = block('.link-btn');
  const pad = Number(link.match(/padding:\s*(\d+)px/)?.[1]);
  const line = Number(link.match(/line-height:\s*(\d+)px/)?.[1]);
  assert.ok(pad * 2 + line >= 24, `.link-btn target is ${pad * 2 + line}px, needs 24`);
});

// Images carry no duration, so the middle metric is hidden — but hiding a cell
// does not drop its grid column, leaving an empty third and an off-centre divider.
test('matches the metrics column count to the visible cells on images', () => {
  assert.match(css, /\.metrics\.is-two-up\s*\{\s*grid-template-columns:\s*repeat\(2,\s*1fr\)/);
  assert.match(html, /id="metrics"/, 'the metrics card needs an id for the toggle');
  assert.match(panel, /classList\.toggle\('is-two-up',\s*isImage\)/);
  const durationLine = panel.indexOf("byId('m-duration-metric').hidden = isImage");
  const toggleLine = panel.indexOf("classList.toggle('is-two-up'");
  assert.ok(durationLine >= 0 && toggleLine > durationLine, 'the toggle must ride with the hidden flag');
});

// A container that gets replaced wholesale is the wrong live region: every render
// re-read the whole grid, including the two renders one download triggers.
test('announces the grid through the count, not by re-reading every card', () => {
  assert.match(html, /<main id="list" class="grid"><\/main>/, '#list must not be a live region');
  assert.match(html, /id="grid-count"[^>]*role="status"/);
  assert.match(panel, /count\.textContent = tn\('foundCountOne', 'foundCount'/);
});

// Contrast pairs the existing theme-contrast test does not cover.
test('keeps the audited secondary-text pairs at WCAG AA', () => {
  for (const selector of [':root', ':root[data-theme="light"]']) {
    const canvas = token(selector, 'canvas');
    const surface = token(selector, 'surface');
    const faint = token(selector, 'faint');
    assert.ok(contrast(faint, canvas) >= 4.5, `${selector} faint/canvas is ${contrast(faint, canvas).toFixed(2)}`);
    assert.ok(contrast(faint, surface) >= 4.5, `${selector} faint/surface`);
    // --accent-soft is the text-weight accent (.set-label headings sit on canvas,
    // NOT inside .set-card, so canvas is the binding case).
    const accentSoft = token(selector, 'accent-soft');
    assert.ok(
      contrast(accentSoft, canvas) >= 4.5,
      `${selector} accent-soft/canvas is ${contrast(accentSoft, canvas).toFixed(2)}`,
    );
  }
  // The version line must not re-dim --faint back below the threshold.
  assert.doesNotMatch(block('.settings-version'), /opacity/);
});

// --control-line is a non-text boundary: AA wants 3:1. The dark theme states it
// as an rgba over --surface, so it has to be composited before measuring.
test('keeps the dark form-control border at the 3:1 non-text minimum', () => {
  const alpha = Number(block(':root').match(/--control-line:\s*rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/)?.[1]);
  assert.ok(Number.isFinite(alpha), 'dark --control-line must stay an rgba over the surface');
  const surface = token(':root', 'surface');
  const composited =
    '#' +
    surface
      .slice(1)
      .match(/../g)!
      .map((channel) => Math.round(255 * alpha + Number.parseInt(channel, 16) * (1 - alpha)))
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('');
  assert.ok(
    contrast(composited, surface) >= 3,
    `dark control border is ${contrast(composited, surface).toFixed(2)}:1`,
  );
});

// Download failures surface as a card `title` tooltip, so they are panel copy and
// must come from i18n rather than English literals.
test('localises every download failure reason and the startup failure', () => {
  const keys = [
    'errNoAudioTrack',
    'errMergeTimedOut',
    'errMergeFailed',
    'errDownloadFailed',
    'errInvalidTab',
    'fatalStartup',
    'fatalStartupVersion',
  ];
  for (const key of keys) {
    assert.match(i18n, new RegExp(`\\| '${key}'`), `${key} missing from MsgKey`);
    assert.equal(
      [...i18n.matchAll(new RegExp(`^\\s+${key}:`, 'gm'))].length,
      2,
      `${key} needs exactly one en and one es entry`,
    );
    assert.match(panel, new RegExp(`(t|fmt)\\('${key}'`), `${key} is declared but never used`);
  }
  for (const literal of ['No audio track.', 'Merge failed.', 'Download failed.', 'Invalid tab.', 'The merge timed out.']) {
    assert.doesNotMatch(panel, new RegExp(`'${literal.replace('.', '\\.')}'`), `${literal} is still hardcoded`);
  }
  assert.doesNotMatch(panel, /FaceScrap couldn't start/, 'the fatal message must come from i18n');
});

// nowLive shipped in both dictionaries and was never read.
test('carries no unused message keys', () => {
  const declared = [...i18n.matchAll(/^\s+\| '(\w+)'/gm)].map((m) => m[1]!);
  assert.ok(declared.length > 100, 'MsgKey parse looks wrong');
  const sources = panel + html + readFileSync(join(process.cwd(), 'src', 'shared', 'settings.ts'), 'utf8');
  const unused = declared.filter((key) => !sources.includes(`'${key}'`) && !sources.includes(`"${key}"`));
  assert.deepEqual(unused, [], `unused message keys: ${unused.join(', ')}`);
});

// The Spanish autosave note read as a lowercase fragment next to a full English
// sentence.
test('writes the settings autosave note as a full sentence in both languages', () => {
  const notes = [...i18n.matchAll(/^\s+settingsAutosave: '([^']+)'/gm)].map((m) => m[1]!);
  assert.equal(notes.length, 2);
  for (const note of notes) {
    assert.match(note, /^\p{Lu}/u, `"${note}" must start with a capital`);
    assert.ok(note.split(' ').length >= 3, `"${note}" reads as a fragment`);
  }
});
