# FaceScrap

Chrome MV3 extension (TypeScript, esbuild). Personal use, load-unpacked only.

Read [README.md](README.md) first — it documents the architecture, the DASH/remux
flow, settings, and browser compatibility. This file only carries the rules that
file doesn't make obvious.

## Invariants — breaking these breaks the extension

**The GraphQL hook is passive. Keep it passive.** `src/content/page-hook.ts`
reads responses to requests Facebook itself made. It must never re-issue a
`doc_id` query or synthesize its own GraphQL request: Meta rotates `doc_id`
every 2–4 weeks (so it breaks) and an extension originating queries is the
signal that gets accounts actioned. Patch, observe, extract — never call.

**Remux only, never re-encode.** `src/shared/mp4-remux.ts` merges the video and
audio tracks by copying their sample bytes and writing a new sample table around
them — what ffmpeg's `-c copy -shortest` used to do here, in ~30 KB instead of a
30.7 MB wasm core. A re-encode would be slow, lossy, and would blow up RAM on long
videos. The shortest-track trim is deliberate — it stops the file ending on frozen
video or on silence.

Three properties of that file are load-bearing:

- **No sample byte passes through JS.** The output is a `Blob` of slices of the two
  input Blobs, so the media stays where the browser put it. An `arrayBuffer()` over
  a track would reintroduce the heap cost that a 500 MB reel used to pay.
- **`stsd` is copied verbatim, never parsed.** That box is the only place a codec is
  described, which is what makes AVC, HEVC, VP9, AV1, AAC, Opus and AC-3 all work
  without a line of codec-specific code.
- **Both MP4 shapes must keep working.** A DASH representation may be progressive
  (one `stbl`) or fragmented (`moof`/`trun` per fragment); the reader handles both
  and converges on one flat sample list. Facebook serves either.

**DRM is out of scope.** `<ContentProtection>` entries in the DASH manifest are
detected and discarded on purpose. Widevine cannot be decrypted by any
extension; do not add code that tries.

**Nothing ships but our own bundles.** The unpacked extension is ~820 KB, and every
byte of it is built from `src/`. It was 32.7 MB while it carried an ffmpeg core to
run one merge; do not reintroduce a vendored binary without a reason that survives
that comparison. `manifest.json` no longer grants `wasm-unsafe-eval` either — there
is no wasm to compile.

## Working here

- **Edit `src/`, never `dist/`.** `dist/` is gitignored and `rm -rf`'d at the
  start of every build.
- **No dependencies at all.** `package.json` has an empty `dependencies`, and its
  devDependencies are esbuild, TypeScript and two `@types` packages — build tooling
  that never reaches `dist/`. A test enforces this.
- Facebook internals shift. Expect selector/GraphQL-shape breakage roughly
  monthly — that's maintenance, not a regression you introduced.

## Verifying a change

In order (`npm run check` chains the first two):

```bash
npm run typecheck   # tsc --noEmit over src/ and tests/
npm test            # bundles tests/*.test.ts with esbuild, runs node --test
npm run build       # must succeed; icons + bundle → dist/
```

The unit suite covers the storage-backed now-playing logic (mark provenance,
learned bindings, buffered-revisit rescue) against the `chrome.storage` fake in
`tests/chrome-fake.ts`. It does NOT touch the capture path: the GraphQL and DOM
layers are only exercised in a real browser — load unpacked from `dist/` at
`chrome://extensions` and play a reel on a facebook.com tab with the side panel
open before calling a capture-path change verified.
