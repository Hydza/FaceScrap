# FaceScrap design QA

## Design target

- Direction: `#2b` — dark immersive mode.
- Surfaces: Now, Library, Saved, and Settings.
- QA viewport: 340 × 780 CSS px at device scale factor 1.
- The design reference is supplied locally when a comparison is needed; its
  machine-specific path is intentionally not stored in the repository.

## Reproducible verification

Run the checks against the current working tree instead of relying on counts or
results copied into this document:

```text
npm run verify
npm run qa:sidepanel -- --reference "<local-reference.html>"
```

Generate the built side-panel captures in a specific supported language:

```powershell
npm run qa:sidepanel -- --lang en
npm run qa:sidepanel -- --lang es
```

The first command is the complete automated gate. The second command is
optional: it captures the supplied reference beside the implementation and
records each comparison as `capturedForManualReview`.

The generated browser evidence is written under `dist/qa/`. It is temporary,
machine-specific output and is excluded from version control. The harness
captures the four implementation surfaces and records runtime, protocol,
interceptor, console, layout, navigation, focus, and control-state checks.

## Automatic versus manual QA

Automatic checks can establish that:

- TypeScript compilation, the current test suite, and the extension build
  complete successfully.
- The side panel loads in the browser without captured runtime errors.
- Expected surfaces, navigation states, controls, and selected layout metrics
  are present in the deterministic fixture scenario.
- Play placement is geometrically valid for portrait, landscape, and square
  video cards before and after a viewport resize.
- Captures and evidence files are produced at the expected dimensions.

Manual review is still required to establish that:

- The implementation is visually faithful to the supplied design reference.
- Typography, spacing, radii, density, media cropping, and Play-button placement
  look correct across portrait, landscape, and square content.
- Side-by-side comparison images are acceptable. Their generation alone is not
  a visual-diff assertion and must not be reported as an automatic pass.
- Controls remain coherent at intermediate panel widths and with real content.

## Evidence handling

- Do not commit `dist/qa/` or `artifacts/`; evidence may contain absolute local
  paths, temporary browser profile data, and extension IDs.
- Regenerate evidence from the same commit being evaluated so it cannot become
  stale relative to the implementation.
- Record a final approval only in the review that performed the current manual
  inspection. This document intentionally makes no standing approval claim.
