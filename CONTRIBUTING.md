# Working on FaceScrap

**English** · [Español](CONTRIBUTING.es.md)

The invariants live in [ARCHITECTURE.md](ARCHITECTURE.md) — read that first. This file is only
the mechanics: what to run, and the conventions the tree already follows.

## Commands

```bash
npm run lint        # Biome over TS, JS, JSON, HTML, CSS and SVG
npm run format      # apply the repository's Biome formatting rules
npm run typecheck   # tsc --noEmit over src/ and tests/
npm test            # bundles tests/*.test.ts with esbuild → node --test
npm run policy      # authors, restricted references and comment quality
npm run quality:code # dead code, duplication, cycles and dependency drift
npm run check       # lint + typecheck + policy + fresh build + test
npm run build       # icons + bundle → dist/
npm run package     # full check + deterministic release ZIP
npm run verify      # check + one Chrome for Testing side-panel run
npm run qa:matrix   # Chrome for Testing EN/ES in light/dark
npm run qa:sidepanel -- --browser cft|edge|brave --lang en|es --theme light|dark|auto
```

## Code hygiene workflow

1. Run `npm run quality:code` and trace each reported export, file or clone to its consumers.
2. Delete unreachable code, consolidate clones that share one contract, and keep intentional
   duplication only when its suppression states the current reason.
3. Keep comments in concise English and describe only current constraints or intent. Delete
   commented-out code and obsolete fix history.
4. Run `npm run policy`, then `npm run check`. Both commands must pass before review.

`qa:sidepanel` drives the real built extension over CDP. Its default `cft` target installs the
version pinned in `.cft-version` through `@puppeteer/browsers` and caches it outside the repository.
The optional Edge and Brave targets use their standard Windows paths. The command needs `dist/`
already built and writes evidence to `artifacts/qa/<browser>/<language>/<theme>/`.

It is also the only thing in this repo that exercises DOM-heavy behaviour, so a change to the
side panel is not verified until it has run.

## Which gate for which change

| Touched | Run |
| --- | --- |
| `src/shared/`, `src/background/` | `npm run check` |
| `src/sidepanel/` (CSS, HTML, TS) | `npm run verify`, then inspect the matching directory under `artifacts/qa/` |
| `src/content/`, `src/offscreen/` | `npm run check`, then load `dist/` unpacked at `chrome://extensions` — the capture path only exists in a real browser |
| `manifest.json`, `src/_locales/` | `npm run check` (there are manifest and localization tests) |

## Conventions

- One test per fix, in `tests/`, prefixed with the work that motivated it (`fix-`, `repair-`,
  `prot-`, `found-`). Keep the pattern when adding one.
- No test frameworks: `node --test` plus `assert`, and the fake in `tests/chrome-fake.ts` for
  anything that touches `chrome.*`.
- **Test behaviour, not the shape of the code.** A test that `readFileSync`s a `.ts` and greps it
  with a regex fails on a correct refactor and cannot fail on broken behaviour. 112 of those were
  deleted. The only exceptions, because there is no other way to observe them without a browser:
  - CSS, HTML, `manifest.json`, `src/_locales/`, i18n parity, ARIA attributes — there the source
    **is** the artifact.
  - Named invariants that must not be reintroduced: the polarity of the confidence bounds in the
    worker (an inverted `if` is invisible to behaviour without a full service-worker harness), and
    that a reader stays pure.

  A test that only proves a call site calls a shared helper is not worth writing: that is DRY, and
  breaking it breaks nothing for the user.
- User-visible strings live in `src/shared/i18n.ts` as a typed `MsgKey` table with both languages.
  `Record<Lang, Record<MsgKey, string>>` means the compiler refuses a key that is missing a
  translation. Never hardcode copy in TS or HTML; put a `data-i18n` attribute on the element or
  call `t()`.
- Facebook's internals shift. Expect selector and GraphQL-shape breakage roughly monthly — that is
  maintenance, not a regression you introduced.

## Verifying the side panel by eye

Each configuration under `artifacts/qa/<browser>/<language>/<theme>/` holds its screenshots plus
`evidence.json` with the measured geometry behind every check. `npm run qa:matrix` creates the
primary language/theme matrix without overwriting one configuration with another. Read the JSON,
not only the exit code: a check that silently stopped asserting anything still reports a pass.
