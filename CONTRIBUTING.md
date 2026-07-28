# Working on FaceScrap

The invariants live in [ARCHITECTURE.md](ARCHITECTURE.md) — read that first. This file is only
the mechanics: what to run, and the conventions the tree already follows.

## Commands

```bash
npm run typecheck   # tsc --noEmit over src/ and tests/
npm test            # bundles tests/*.test.ts with esbuild → node --test
npm run check       # typecheck + test
npm run build       # icons + bundle → dist/
npm run verify      # check + build + qa:sidepanel — the full gate
npm run qa:sidepanel -- --lang en|es --theme light|dark|auto
```

`qa:sidepanel` drives the real built extension over CDP. It launches Edge or Brave from an
absolute Windows path (`scripts/sidepanel-visual-qa.mjs`), needs `dist/` already built, and writes
its evidence to `artifacts/qa/`. It fails outside Windows or without one of those browsers
installed; that is the environment, not a regression.

It is also the only thing in this repo that exercises DOM-heavy behaviour, so a change to the
side panel is not verified until it has run.

## Which gate for which change

| Touched | Run |
| --- | --- |
| `src/shared/`, `src/background/` | `npm run check` |
| `src/sidepanel/` (CSS, HTML, TS) | `npm run verify`, then look at `artifacts/qa/` |
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

`artifacts/qa/` holds a screenshot per surface, per language, per theme, plus `evidence.json` with
the measured geometry behind each check. Read the JSON, not only the exit code: a check that
silently stopped asserting anything still reports a pass.
