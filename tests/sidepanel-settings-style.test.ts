import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const css = readFileSync(join(process.cwd(), "src", "sidepanel", "sidepanel.css"), "utf8");
const html = readFileSync(join(process.cwd(), "src", "sidepanel", "sidepanel.html"), "utf8");

test("settings cards draw separators only between adjacent rows", () => {
  const rowRule = css.match(/\.set-row\s*\{([^}]*)\}/)?.[1];

  assert.ok(rowRule, "expected the base settings row rule");
  assert.doesNotMatch(rowRule, /border-(?:top|bottom)\s*:/);
  assert.match(
    css,
    /\.set-row\s*\+\s*\.set-row,[\s\S]{0,120}?\{[^}]*border-top:\s*1px\s+solid\s+var\(--ln\)\s*;?[^}]*\}/,
  );
  assert.doesNotMatch(css, /\.set-row:last-child/);
});

test("every either/or setting is the same segmented shape", () => {
  // One control shape means one set of states to style and one thing to learn. What
  // varies is only the width class: inline beside its label, or stretched under it.
  const seg = css.match(/\.seg\s*\{([^}]*)\}/)?.[1];
  assert.ok(seg, "missing the segmented control");
  assert.match(seg, /background:\s*var\(--fld\)/);
  assert.match(seg, /border:\s*1px solid var\(--ring\)/);
  assert.match(seg, /box-shadow:\s*var\(--ei\)/);

  const button = css.match(/\.seg\s*>\s*button\s*\{([^}]*)\}/)?.[1];
  assert.ok(button, "missing the segmented control's buttons");
  assert.match(button, /height:\s*24px/);
  assert.match(css, /\.seg\s*>\s*button\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--ac\)/s);
  assert.match(css, /\.seg\s*>\s*button\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--onac\)/s);

  // Every group in the markup uses it, including the two that are navs rather than
  // settings rows — the filter strip and the page tabs.
  for (const id of ["filters", "set-tabs"]) {
    assert.match(html, new RegExp(`<nav\\b[^>]*id="${id}"[^>]*class="seg `), `#${id} must be a .seg`);
  }
});

test("pre-init automatic theme follows the device without a dark flash", () => {
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*light\)\s*\{/);
  const explicit = css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1];
  const preInit = css.match(/:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/)?.[1];
  assert.ok(explicit && preInit, "missing light theme blocks");
  // The pre-boot fallback must declare every token the explicit light theme does. A
  // drift between the two reintroduces the startup flash this block exists to prevent,
  // and nothing else keeps the hand-copied values in sync — so compare them rather than
  // pinning one literal colour. The fallback carries MORE than the explicit block: with
  // no data-theme there is no [data-tint] pair either, so it also has to state the
  // default tint's four surfaces.
  const tokens = (block: string): Map<string, string> =>
    new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  const preInitTokens = tokens(preInit!);
  for (const [name, value] of tokens(explicit!)) {
    assert.equal(preInitTokens.get(name), value, `pre-init ${name} drifted from the light theme`);
  }
  for (const surface of ["--cv", "--sf", "--sf2", "--ln"]) {
    assert.ok(preInitTokens.has(surface), `pre-init must state ${surface}: no tint rule applies yet`);
  }
});

test("the fields that used to be selects read as recessed, not as bare text", () => {
  // The native select carried its own border and chevron. Every field that replaced one
  // now states them: a 1px --ring edge and the --ei inset that makes it read as a well.
  for (const selector of ["\\.search-field", "\\.seg"]) {
    const rule = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1];
    assert.ok(rule, `missing ${selector}`);
    assert.match(rule, /border:\s*1px solid var\(--ring\)/);
    assert.match(rule, /box-shadow:\s*var\(--ei\)/);
  }
  // The resolution trigger sits on the hairline instead, because it is a full-width
  // control on the canvas rather than a chip inside a card — and it lights up on hover.
  assert.match(css, /\.picker-trigger\s*\{[^}]*border:\s*1px solid var\(--ln\)/s);
  assert.match(css, /\.picker-trigger:not\(:disabled\):hover\s*\{[^}]*border-color:\s*var\(--ac\)/s);
});

test("the panel remains readable at its supported narrow width", () => {
  assert.match(css, /min-width:\s*300px/);
  assert.match(css, /@media\s*\(max-width:\s*335px\)/);
  assert.match(css, /\.set-row\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.set-copy\s*\{[^}]*min-width:\s*0/s);
});

test("reduced motion and forced colors keep interactive settings usable", () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const forcedColors = css.match(/@media\s*\(forced-colors:\s*active\)\s*\{([^]*?)\n\}/)?.[1];
  assert.ok(forcedColors, "missing forced-colors block");
  // The block must give every interactive control a system-drawn border instead
  // of relying on background colour, which forced-colors strips.
  assert.match(forcedColors, /border:\s*1px solid ButtonText/);
  // Including the pressed segment, whose ONLY state is a background fill.
  assert.match(forcedColors, /\.seg\s*>\s*button\[aria-pressed="true"\]/);
});
