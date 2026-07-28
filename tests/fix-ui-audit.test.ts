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

/** The stylesheet with every `@media` block removed, so a responsive override is
 *  not mistaken for a base value. Brace-counted rather than regexed: media blocks
 *  nest rules, which a non-greedy match would cut in the middle of. */
function withoutMediaQueries(source: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const start = source.indexOf('@media', at);
    if (start < 0) return out + source.slice(at);
    out += source.slice(at, start);
    let depth = 0;
    let cursor = source.indexOf('{', start);
    if (cursor < 0) return out;
    for (; cursor < source.length; cursor++) {
      if (source[cursor] === '{') depth++;
      else if (source[cursor] === '}' && --depth === 0) break;
    }
    at = cursor + 1;
  }
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
  // Every context that renders user-visible copy, not just the panel: the
  // in-page download overlay reads its own keys straight from i18n.ts.
  const sources = [panel, html]
    .concat(
      ['src/shared/settings.ts', 'src/content/download-overlay.ts'].map((rel) =>
        readFileSync(join(process.cwd(), ...rel.split('/')), 'utf8'),
      ),
    )
    .join('\n');
  const unused = declared.filter((key) => !sources.includes(`'${key}'`) && !sources.includes(`"${key}"`));
  assert.deepEqual(unused, [], `unused message keys: ${unused.join(', ')}`);
});

// The stylesheet was written in two layers — a base section and a redesign section
// that overrode it — leaving 45 declarations permanently dead. They rendered
// correctly (identical selector, so the later one wins) and read wrong: .now
// declared its padding twice, 4px apart, and reading the first block is how a stale
// 12px went unnoticed through a whole design audit. Flattened, and now pinned.
//
// Grouped blocks (`a, b { }`) are excluded on purpose: a declaration there can be
// dead for one selector and load-bearing for the other.
test('declares each property once per selector, outside media queries', () => {
  const base = withoutMediaQueries(css);
  const blocks = new Map<string, Array<Map<string, string>>>();
  for (const match of base.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g)) {
    const selector = match[2]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!selector || selector.includes(',')) continue;
    const declarations = new Map<string, string>();
    for (const line of match[3]!.split(';')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const property = line.slice(0, colon).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (property && !property.startsWith('/')) declarations.set(property, line.slice(colon + 1).trim());
    }
    blocks.set(selector, [...(blocks.get(selector) ?? []), declarations]);
  }

  const collisions: string[] = [];
  for (const [selector, list] of blocks) {
    if (list.length < 2) continue;
    const seen = new Map<string, string>();
    for (const declarations of list) {
      for (const [property, value] of declarations) {
        const previous = seen.get(property);
        if (previous != null && previous !== value) {
          collisions.push(`${selector} { ${property} } declared ${previous} then ${value}`);
        }
        seen.set(property, value);
      }
    }
  }
  assert.deepEqual(collisions, [], `dead declarations:\n${collisions.join('\n')}`);
});

// The audit that removed --scroll-thumb named that token by hand and left three
// more behind (--accent-wash, --media-overlay, --media-line; the last survived
// because --media-overlay-soft IS used and the two read alike). Check the property
// mechanically instead, so the next one cannot hide.
test('defines no custom property that nothing reads', () => {
  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]!));
  const read = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!));
  const unused = [...defined].filter((name) => !read.has(name)).sort();
  assert.deepEqual(unused, [], `unused custom properties: ${unused.join(', ')}`);
});

// Now Playing sat tight against the app header and its count hung off the right
// edge, so it read as a different screen from Library and Saved. Four measured
// differences, all of them between VIEWS — nothing but a cross-view comparison can
// see them, which is why they are pinned here rather than left to a screenshot.
test('opens Now Playing on the same grid as the other views', () => {
  // 1. Same distance below the header. Now Playing had no top padding at all.
  const topPad = css.match(/\.view-grid,\n\.view-now \{ padding-top: (\d+)px; \}/);
  assert.ok(topPad, 'the two content views must share one padding-top rule');
  assert.equal(topPad[1], '12');

  // 2. Same horizontal inset as .grid and .settings-body, so the heading and the
  //    media card line up with grid cards and settings rows. Read the CASCADE
  //    winner, not the first block: .now is declared twice, and reading the wrong
  //    one is how a stale 12px sat there unnoticed. Responsive overrides are
  //    stripped first — they retune every view together and are not the baseline.
  const base = withoutMediaQueries(css);
  const inset = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declared = [...base.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
      .map((m) => m[1]!.match(/padding:\s*0(?:px)?\s+(\d+)px/)?.[1])
      .filter((value): value is string => value != null);
    assert.ok(declared.length > 0, `${selector} must declare a horizontal padding`);
    return declared[declared.length - 1]!;
  };
  assert.equal(inset('.now'), '16');
  assert.equal(inset('.grid'), '16');
  assert.equal(inset('.settings-body'), '16');
  // The head must not add its own inset on top of that.
  assert.doesNotMatch(block('.now-head'), /padding/, '.now-head must inherit .now’s inset');

  // 3. The count sits beside the heading, as in .grid-title-line, not shoved to the
  //    far edge by space-between.
  assert.doesNotMatch(block('.now-head'), /justify-content/);
  assert.match(block('.now-head'), /align-items:\s*baseline/);
  assert.match(block('.grid-title-line'), /align-items:\s*baseline/);

  // 4. And it is styled as the same kind of label as the grid's count.
  const pieces = block('.now-pieces');
  const count = block('.grid-count');
  for (const property of ['color', 'font-size', 'line-height', 'font-weight']) {
    const from = (rule: string): string | undefined =>
      rule.match(new RegExp(`${property}:\\s*([^;]+)`))?.[1]?.trim();
    assert.equal(from(pieces), from(count), `${property} must match .grid-count`);
  }
});

// The Reset button sat flush against the counters box — measured 0px between them
// in Chromium 148, where the UA wraps everything after <summary> in a
// ::details-content box, so .set-row.col's column `gap` lands between the summary
// and that box and never between its children.
test('spaces the diagnostics counters from Reset without relying on the details gap', () => {
  assert.match(css, /\.diagnostics details\.set-row\.col \{[^}]*gap:\s*0/);
  assert.match(block('.diagnostics #diag-counters'), /margin-top:\s*8px/);
  const reset = block('.diagnostics #diag-reset');
  // Equal margins are the point, not one of them: with the UA box the gap is
  // skipped, and on the Chrome 116 floor the children ARE flex siblings. Margins
  // give 8px in both worlds; keeping the gap as well would give 16px in one.
  assert.match(reset, /margin-top:\s*8px/);
  // In the flex-sibling case align-items: stretch would blow the button to full
  // width, so the two versions would not even agree on its shape.
  assert.match(reset, /align-self:\s*flex-start/);
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
