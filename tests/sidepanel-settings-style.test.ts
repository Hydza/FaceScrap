import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const css = readFileSync(join(process.cwd(), "src", "sidepanel", "sidepanel.css"), "utf8");

test("settings cards draw separators only between adjacent rows", () => {
  const rowRule = css.match(/\.set-row\s*\{([^}]*)\}/)?.[1];

  assert.ok(rowRule, "expected the base settings row rule");
  assert.doesNotMatch(rowRule, /border-(?:top|bottom)\s*:/);
  assert.match(
    css,
    /\.set-row\s*\+\s*\.set-row\s*\{[^}]*border-top:\s*1px\s+solid\s+var\(--line\)\s*;?[^}]*\}/,
  );
  assert.doesNotMatch(css, /\.set-row:last-child/);
});

test("theme-aware settings controls preserve the native select contract", () => {
  assert.match(css, /html\s*\{[^}]*color-scheme:\s*(?:light\s+dark|dark\s+light)/s);
  assert.match(css, /:root\[data-theme="light"\]\s*\{/);
  assert.match(css, /\.set-row\s+\.select\s*\{/);
  assert.match(css, /@supports\s*\(appearance:\s*base-select\)/);
  assert.doesNotMatch(css, /#set-theme[^{}]*appearance:\s*none/);
});

test("pre-init automatic theme follows the device without a dark flash", () => {
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*light\)\s*\{/);
  const explicit = css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1];
  const preInit = css.match(/:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/)?.[1];
  assert.ok(explicit && preInit, 'missing light theme blocks');
  // The pre-boot fallback must declare exactly the same tokens as the explicit
  // light theme. A drift between the two reintroduces the startup flash this
  // block exists to prevent, and nothing else keeps the hand-copied values in
  // sync — so compare them rather than pinning one literal colour.
  const tokens = (block: string): Array<[string, string]> =>
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]);
  assert.deepEqual(tokens(preInit!), tokens(explicit!));
});

test("every select shares the theme-aware chevron, dark in the light theme", () => {
  const light = css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1];
  assert.ok(light, "missing explicit light theme");
  assert.match(light, /--select-chevron:[^;]*stroke='%2359636e'/);
  assert.match(css, /\.select\s*\{[^}]*background-image:\s*var\(--select-chevron\)/s);
  // The quality select sits on the panel canvas rather than over the media, so
  // it shares the theme-aware chevron instead of a fixed light one.
  assert.match(css, /#now-qselect\s*\{[^}]*background-image:\s*var\(--select-chevron\)/s);
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
});
