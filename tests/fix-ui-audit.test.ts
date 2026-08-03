// Pin CSS, HTML, token, and copy invariants that do not require a browser.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';

import { panelSource } from './panel-source';

/** Collect every .ts/.html file so new copy-rendering modules are covered automatically. */
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

// Apply one hidden-scrollbar rule to every scrolling container.
test('hides the scrollbar on every container that scrolls, with one rule', () => {
  const scrollers = [...css.matchAll(/^(\.[\w-]+)[^{]*\{[^}]*overflow:[^;]*auto[^;]*;/gms)].map((m) => m[1]!);
  assert.deepEqual(
    new Set(scrollers),
    new Set(['.grid', '.now', '.settings-body', '.picker-list']),
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

// Keep disabled resolution text readable with panel theme tokens.
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

// Do not offset the centered play glyph at either call site.
test('centres the play glyph identically in Now Playing and the grid', () => {
  assert.doesNotMatch(block('.preview-play::before'), /margin/, 'no nudge margin on an already-centred mask');
  assert.match(block('.tile-thumb.is-video::after'), /background-position:\s*center/);
});

// Enforce the intended control and tile target sizes.
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

// The grid selects items and the tray handles pointer downloads; keyboard download
// remains available per tile.
test('the grid tile does one thing, and the tray does the other', () => {
  assert.doesNotMatch(css, /\.tile-dl/, 'the per-tile download button is gone');
  assert.doesNotMatch(panel, /tile-dl/);
  // The cursor binding downloads the focused tile without the tray.
  assert.match(panel, /case 'downloadCard':/);
  assert.match(panel, /void downloadCard\(cursorCard\.id, cursorCard\.target\)/);
  // The tray button is the pointer route.
  assert.match(html, /id="bulk-dl" class="btn-accent"/);
});

// Keep each media fact in one location: duration chip, container overlay, and
// resolution picker.
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

// Keep live status outside the grid that is rerendered wholesale to avoid
// re-announcing every render.
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
  // Keep the version line above the contrast threshold.
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

test('carries no unused message keys', () => {
  const declared = [...i18n.matchAll(/^\s+\| '(\w+)'/gm)].map((m) => m[1]!);
  assert.ok(declared.length > 100, 'MsgKey parse looks wrong');
  // Scan every source file so keys used outside the panel are retained.
  const sources = sourceFiles(join(process.cwd(), 'src'))
    .filter((file) => !file.endsWith(`shared${sep}i18n.ts`))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const unused = declared.filter((key) => !sources.includes(`'${key}'`) && !sources.includes(`"${key}"`));
  assert.deepEqual(unused, [], `unused message keys: ${unused.join(', ')}`);
});

// Reject duplicate properties per selector outside media queries.
// Exclude grouped selectors because their declarations may apply unevenly.
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

// Detect unused CSS custom properties mechanically, including similarly named tokens.
test('defines no custom property that nothing reads', () => {
  const defined = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]!));
  const read = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!));
  const unused = [...defined].filter((name) => !read.has(name)).sort();
  assert.deepEqual(unused, [], `unused custom properties: ${unused.join(', ')}`);
});

// Pin shared baseline geometry across Now Playing, Library, and Saved.
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
    // Read the cascade winner rather than the first matching block.
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

// Keep the Settings aside short, lowercase, and consistent in register across locales.
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
