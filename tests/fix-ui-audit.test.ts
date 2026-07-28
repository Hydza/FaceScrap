// Regression tests for the UI/design audit pass. One test per fix, all of them
// static assertions over the source: these are CSS/HTML/token invariants and
// copy contracts, which the DOM-less unit suite can pin without a browser.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';

import { panelSource } from './panel-source';

/** Every .ts/.html under a directory. Used instead of a hand-listed set of paths so a new
 *  module that renders copy is covered the day it is written. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.html')) out.push(full);
  }
  return out;
}

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');
const html = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
const panel = panelSource();
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
  assert.deepEqual(
    new Set(scrollers),
    new Set(['.grid', '.settings-body', '.picker-list']),
    'scrolling containers changed',
  );

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

// The resolution control used to go DISABLED with a single representation, and forced
// --media-text (pinned white for overlay chips) over a light field — white on white.
// The trigger it became still goes inert, so it still has to read with panel tokens.
test('paints the inert resolution trigger with a theme-aware colour', () => {
  const trigger = block('.picker-trigger');
  assert.match(trigger, /color:\s*var\(--tx\)/);
  assert.doesNotMatch(trigger, /#ffffff/, 'must not pin white off the media');
  // Inert loses the caret and the pointer, never the text: the resolution is the one
  // thing this row exists to state.
  assert.match(css, /\.picker-trigger:disabled\s*\{[^}]*cursor:\s*default/s);
  assert.doesNotMatch(css, /\.picker-trigger:disabled\s*\{[^}]*opacity/s);

  for (const selector of [':root', ':root[data-theme="light"]']) {
    assert.ok(contrast(token(selector, 'tx'), token(selector, 'fld')) >= 4.5, `${selector} tx/fld`);
  }
});

// play.svg already centres its own triangle (box at x 9-17 of a 24 viewBox) and
// both call sites centre the file again, so an extra margin only pushed Now
// Playing's play glyph off-centre relative to the grid thumbnails'.
test('centres the play glyph identically in Now Playing and the grid', () => {
  assert.doesNotMatch(block('.preview-play::before'), /margin/, 'no nudge margin on an already-centred mask');
  assert.match(block('.tile-thumb.is-video::after'), /background-position:\s*center/);
});

// The handoff draws the corner controls at 22px and the text buttons at 3px of padding
// around an 11px/1.4 line box — 22px and 21.4px, both a little under the 24px WCAG 2.5.8
// target minimum. Both are shipped as drawn, so the numbers are pinned HERE rather than
// silently accepted: a regression that shrinks them further fails, and the tile itself
// remains the real target for the one gesture the grid has.
test('pins the handoff’s target sizes, and what the grid actually aims at', () => {
  assert.doesNotMatch(css, /\.pick::after/, 'no hit outset — the design draws a flat 22px dot');
  for (const selector of ['.pick', '.tile-reveal']) {
    const size = Number(block(selector).match(/width:\s*(\d+)px/)?.[1]);
    assert.equal(size, 22, `${selector} is the design's 22px circle`);
    assert.equal(Number(block(selector).match(/height:\s*(\d+)px/)?.[1]), 22, `${selector} must be square`);
  }
  const link = block('.link-btn');
  const pad = Number(link.match(/padding:\s*(\d+)px/)?.[1]);
  const size = Number(link.match(/font-size:\s*(\d+)px/)?.[1]);
  const line = Number(link.match(/line-height:\s*([\d.]+)/)?.[1]);
  assert.equal(pad, 3, 'the design draws 3px of padding on a text button');
  assert.ok(pad * 2 + size * line >= 21, `.link-btn fell to ${pad * 2 + size * line}px`);

  // What makes the 22px dot acceptable: it is an INDICATOR, not the target. The whole
  // tile toggles the selection — 159×282 at two columns — and Saved's reveal button is
  // the only control the tile body has to step around.
  assert.match(panel, /\.closest\('\.tile-reveal, \.pick'\)/);
  assert.match(css, /\.tile\s*\{[^}]*cursor:\s*pointer/s);
});

// The grid has ONE verb. Selecting raises the tray, and the tray is what downloads —
// so a per-tile download button was removed with the redesign rather than kept beside
// a dot it would compete with. The keyboard binding is unchanged and still per-tile.
test('the grid tile does one thing, and the tray does the other', () => {
  assert.doesNotMatch(css, /\.tile-dl/, 'the per-tile download button is gone');
  assert.doesNotMatch(panel, /tile-dl/);
  // Nothing lost: the cursor binding downloads the tile under it without the tray.
  assert.match(panel, /case 'downloadCard':/);
  assert.match(panel, /void downloadCard\(cursorCard\.id, cursorCard\.target\)/);
  // And the tray's own button is the mouse route.
  assert.match(html, /id="bulk-dl" class="btn-accent"/);
});

// The 3-up metrics card is gone: it spent 66px of chrome restating facts the screen
// already carried. Each fact now appears exactly once — the duration on its chip, the
// container on the overlay line, the resolution in the picker — which is the rule that
// replaced it and the one worth pinning.
test('states each media fact exactly once across the Now Playing screen', () => {
  assert.doesNotMatch(html, /id="metrics"/, 'the metrics card is gone');
  assert.doesNotMatch(css, /\.metrics\b/);
  assert.doesNotMatch(html, /id="m-(?:format|duration|resolution)"/);
  // Duration: the chip beside the kind badge, and nowhere else.
  assert.match(html, /id="now-dur" class="media-dur"/);
  // Container + aspect: the line over the scrim. A photo has no resolution ladder, so
  // its dimensions ride here too rather than in a picker it does not get.
  assert.match(html, /id="now-format" class="preview-format"/);
  assert.match(panel, /byId\('now-format'\)\.textContent = formatLine\(target, imageResolutionLabel\)/);
  // Resolution: the picker's own label, videos only.
  assert.match(html, /id="now-qlabel" class="picker-label"/);
  assert.match(panel, /quality\.hidden = now\.kind !== 'video'/);
});

// A container that gets replaced wholesale is the wrong live region: every render
// re-read the whole grid, including the two renders one download triggers.
test('announces the grid through the count, not by re-reading every tile', () => {
  assert.match(html, /<main id="list" class="grid"><\/main>/, '#list must not be a live region');
  assert.match(html, /id="grid-count"[^>]*role="status"/);
  assert.match(panel, /tn\('filesCountOne', 'filesCount', gridCards\.length\)/);
  assert.match(panel, /tn\('onThisTabOne', 'onThisTab', gridCards\.length\)/);
});

// Contrast pairs the theme-contrast test does not cover: it walks text against the
// tinted canvas and surfaces, and these are the ones drawn on a FIELD instead.
test('keeps the audited field-text pairs at WCAG AA', () => {
  for (const selector of [':root', ':root[data-theme="light"]']) {
    const field = token(selector, 'fld');
    for (const name of ['tx', 'md', 'ft']) {
      const ratio = contrast(token(selector, name), field);
      assert.ok(ratio >= 4.5, `${selector} ${name}/fld is ${ratio.toFixed(2)}`);
    }
  }
  // The version line must not re-dim --ft back below the threshold.
  assert.doesNotMatch(block('.settings-version'), /opacity/);
});

// --ring is the design's field edge, and at 10% white it is a hairline rather than a
// 3:1 boundary. That is deliberate — the field is found by its recessed FILL, not by
// its edge — so what has to hold is that every control wearing it also wears the inset
// that does the work, and that forced-colors replaces both with a system border.
test('every control drawn with the faint ring also reads as recessed', () => {
  const ringed = [...css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^{}]*border:\s*1px solid var\(--ring\)[^{}]*)\}/gm)];
  assert.ok(ringed.length >= 3, 'expected the ring on the segmented control, the search field and the icon button');
  for (const match of ringed) {
    assert.match(match[3]!, /box-shadow:\s*var\(--ei\)|background:\s*var\(--fld\)/, `${match[2]} needs the recess`);
  }
  const forced = css.match(/@media\s*\(forced-colors:\s*active\)\s*\{([^]*?)\n\}/)?.[1];
  assert.ok(forced, 'missing forced-colors block');
  assert.match(forced, /border:\s*1px solid ButtonText/);
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
  // Every file under src/, not a hand-listed subset. The list this replaced named three
  // paths and went stale the moment a fourth module started holding message keys — the
  // accent palette, whose swatches have no text and carry their label as data. A key used
  // only there read as dead, which is the opposite of what this test is for.
  const sources = sourceFiles(join(process.cwd(), 'src'))
    .filter((file) => !file.endsWith(`shared${sep}i18n.ts`))
    .map((file) => readFileSync(file, 'utf8'))
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
  // Responsive overrides are stripped first — they retune every view together and are
  // not the baseline.
  const base = withoutMediaQueries(css);
  const inset = (selector: string, pattern: RegExp): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declared = [...base.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
      .map((m) => m[1]!.match(pattern)?.[1])
      .filter((value): value is string => value != null);
    assert.ok(declared.length > 0, `${selector} must declare a horizontal padding`);
    // The CASCADE winner, not the first block: reading the wrong one is how a stale
    // value once sat there unnoticed through a whole design audit.
    return declared[declared.length - 1]!;
  };
  // 1. One horizontal inset for every view, so the heading, the media frame, the tiles
  //    and the settings rows all line up on the same two edges.
  assert.equal(inset('.now', /padding:\s*\d+px\s+(\d+)px/), '16');
  assert.equal(inset('.grid', /padding:\s*0\s+(\d+)px/), '16');
  assert.equal(inset('.settings-body', /padding:\s*0\s+(\d+)px/), '16');
  assert.equal(inset('.grid-head', /padding:\s*\d+px\s+(\d+)px/), '16');
  assert.equal(inset('.settings-head', /padding:\s*\d+px\s+(\d+)px/), '16');

  // 2. The heading rows must not add their own inset on top of that.
  assert.doesNotMatch(block('.head-line'), /padding/, '.head-line inherits .now’s inset');

  // 3. The count sits beside the heading on a shared baseline, not shoved to the far
  //    edge by space-between.
  for (const selector of ['.head-line', '.grid-head', '.settings-head']) {
    assert.doesNotMatch(block(selector), /justify-content/, `${selector} must not push the count away`);
    assert.match(block(selector), /align-items:\s*baseline/);
  }

  // 4. And it IS the same label in all three: one class, so they cannot drift.
  assert.match(html, /id="now-pieces" class="head-note"/);
  assert.match(html, /id="grid-count" class="head-note"/);
  assert.match(html, /<span class="head-note" data-i18n="settingsAutosave"/);
});

// The Reset button sat flush against the counters box — measured 0px between them
// in Chromium 148, where the UA wraps everything after <summary> in a
// ::details-content box, so .set-row.col's column `gap` lands between the summary
// and that box and never between its children.
// The buttons now sit in their own .diag-actions row (Export joined Reset), so the
// margin that does this spacing moved from #diag-reset onto that row. What is being
// pinned is unchanged: the separation comes from a margin, never from the gap.
test('spaces the diagnostics counters from the actions without relying on the details gap', () => {
  assert.match(css, /\.diagnostics details\.set-row\.col \{[^}]*gap:\s*0/);
  assert.match(block('.diagnostics #diag-counters'), /margin:\s*8px 0 0/);
  const actions = block('.diagnostics .diag-actions');
  // Equal margins are the point, not one of them: with the UA box the gap is
  // skipped, and on the Chrome 116 floor the children ARE flex siblings. Margins
  // give 8px in both worlds; keeping the gap as well would give 16px in one.
  assert.match(actions, /margin-top:\s*8px/);
  // In the flex-sibling case align-items: stretch would blow the row to full
  // width, so the two versions would not even agree on its shape.
  assert.match(actions, /align-self:\s*flex-start/);
  // The two buttons share one row rather than stacking, and wrap at 300px instead
  // of overflowing it.
  assert.match(actions, /display:\s*flex/);
  assert.match(actions, /flex-wrap:\s*wrap/);
});

// The note beside the Settings heading is a lowercase aside in the design — "saved as
// you go" — sharing a baseline with a 19px title, not a sentence. What broke before was
// the two languages disagreeing about which it was: English a full sentence, Spanish a
// fragment. So what is pinned is that they MATCH in register, not which one they pick.
test('writes the settings autosave note in the same register in both languages', () => {
  const notes = [...i18n.matchAll(/^\s+settingsAutosave: '([^']+)'/gm)].map((m) => m[1]!);
  assert.equal(notes.length, 2);
  const capitalised = notes.map((note) => /^\p{Lu}/u.test(note));
  assert.equal(capitalised[0], capitalised[1], `"${notes[0]}" and "${notes[1]}" disagree on capitalisation`);
  for (const note of notes) {
    // It shares a line with the heading, so it has to stay short enough not to wrap it.
    assert.ok(note.length <= 24, `"${note}" is too long to sit beside the heading`);
    assert.doesNotMatch(note, /[.!]$/, `"${note}" is an aside, not a sentence`);
  }
});
