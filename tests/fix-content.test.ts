// Regression checks for the content-lane code-review fixes (findings C1, B2,
// D2, B3, S6, EF3, ALT6). content.ts / content-recovery.ts require a live
// document/chrome content-script environment they never get under node:test —
// content.ts alone wires up MutationObserver, AbortController-scoped DOM
// listeners, a 300ms poller and several chrome.runtime round trips as an
// unconditional side effect of module evaluation, with no exports to import
// instead — so, like tests/fix-sidepanel.test.ts, most of these assert on the
// source text rather than executing it. graphql-media.ts (ALT6's other call
// site) carries no such constraint, so its checks below also exercise the
// real function alongside a source check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { graphqlImageCandidate } from '../src/shared/graphql-media';
import { MIN_MEDIA_DIMENSION_PX } from '../src/shared/media';

const ROOT = process.cwd();
const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');
const recovery = readFileSync(join(ROOT, 'src', 'content', 'content-recovery.ts'), 'utf8');
const graphqlMedia = readFileSync(join(ROOT, 'src', 'shared', 'graphql-media.ts'), 'utf8');

/** Slice `source` between two literal (non-regex) markers, failing loudly if either is missing. */
function section(source: string, startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = source.indexOf(startMarker, fromIndex);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker after "${startMarker}": ${endMarker}`);
  return source.slice(start, end);
}

// FINDING C1 — a still-prerendering document's very first MEDIA_FOUND was
// answered retryable:false (the worker only accepted an ACTIVE
// documentLifecycle), and deliverMedia tore the whole detector down on ANY
// retryable:false ack — permanently killing capture before the user had even
// activated the tab, with no recovery path.
test('tracks document.prerendering and only tears down a MEDIA_FOUND rejection once prerendering is over', () => {
  assert.ok(
    content.includes(
      "let isPrerendering =\n  (document as typeof document & { readonly prerendering?: boolean }).prerendering === true;",
    ),
    'isPrerendering must be read from document.prerendering at content-script startup',
  );

  const deliverMedia = section(
    content,
    'async function deliverMedia(items: readonly MediaItem[]): Promise<boolean> {',
    '\nasync function pumpMedia',
  );
  assert.ok(
    deliverMedia.includes('if (response?.retryable === false && !isPrerendering) teardown();'),
    'a rejection while still prerendering must not run the kill switch',
  );
  // The kill switch must stay reachable outside the prerendering window — the
  // fix must not neuter it into never firing at all.
  assert.doesNotMatch(
    deliverMedia,
    /if \(response\?\.retryable === false\) teardown\(\);/,
    'the unconditional (pre-fix) teardown call must be gone',
  );
});

test('re-arms on prerenderingchange: clears the queued backoff, pumps immediately, and reasserts theme/now-playing', () => {
  const rearm = section(
    content,
    "if (isPrerendering) {\n  document.addEventListener(\n    'prerenderingchange',",
    '\n}\n}',
  );
  assert.ok(rearm.includes('isPrerendering = false;'));
  assert.ok(
    rearm.includes('if (mediaRetryTimer !== undefined) {\n        clearTimeout(mediaRetryTimer);\n        mediaRetryTimer = undefined;\n      }'),
    'must cancel whatever backoff interval a prerendering-window rejection already armed',
  );
  assert.ok(rearm.includes('mediaRetryFailures = 0;'));
  assert.ok(rearm.includes('void pumpMedia();'), 'must retry the queued batch immediately rather than waiting out the backoff');
  assert.ok(rearm.includes('reassertPlaying();'));
  assert.ok(rearm.includes('scheduleFacebookTheme();'));
  assert.ok(
    rearm.includes("{ once: true, signal: listeners.signal }"),
    'must fire at most once and be torn down with every other listener',
  );
});

// FINDING D2 — createVideoMarkFactory(crypto.randomUUID()) called the API a
// second time with no guard, even though documentToken (defined right above
// it) already feature-detects the very same API and falls back to
// crypto.getRandomValues. On a runtime without crypto.randomUUID this threw
// at module evaluation, before any now-playing listener below it registered.
test('mints the video-mark epoch from the already-guarded documentToken, not a second unguarded randomUUID() call', () => {
  assert.ok(content.includes('const markVideoLoad = createVideoMarkFactory(documentToken);'));
  assert.doesNotMatch(
    content,
    /createVideoMarkFactory\(crypto\.randomUUID\(\)\)/,
    'must not call the unguarded API a second time',
  );
});

// FINDING B2 — the hook-injected latch was set before the <script> element
// was even created, with no onerror and no rollback, so a page-hook.js fetch
// failure (e.g. an extension update invalidating the old chrome-extension://
// URL between navigation and injection) permanently marked the document
// hooked with no fetch/XHR wrappers ever installed.
test('latches __facescrapHookInjected only on a confirmed page-hook.js load, and cleans up on error too', () => {
  const ensurePageHook = section(content, 'function ensurePageHook(): void {', '\nensurePageHook();');

  const createElementIndex = ensurePageHook.indexOf("document.createElement('script')");
  const onloadIndex = ensurePageHook.indexOf('s.onload = () => {');
  const onerrorIndex = ensurePageHook.indexOf('s.onerror = () => s.remove();');
  const latchIndex = ensurePageHook.indexOf('contentBootstrap.__facescrapHookInjected = true;');
  assert.ok(createElementIndex >= 0, 'missing the script element creation');
  assert.ok(
    onloadIndex > createElementIndex,
    'onload must be wired after the element is created (nothing to attach it to before that)',
  );
  assert.ok(latchIndex > onloadIndex, 'the latch must be set inside onload, not before the fetch is even attempted');
  assert.ok(onerrorIndex > onloadIndex, 'a failed load must be handled too');
  assert.ok(
    ensurePageHook.includes('s.onload = () => {\n      contentBootstrap.__facescrapHookInjected = true;\n      s.remove();\n    };'),
    'the latch and cleanup must both happen only once the load is confirmed',
  );
});

// FINDING B2 (recovery half) — content-recovery.ts unconditionally told
// content.ts to skip page-hook reinjection, on the assumption the old
// MAIN-world hook survives every update. That assumption only holds when the
// hook actually installed; a document whose earlier hook attempt failed (see
// above) has no surviving hook to preserve and was left permanently hookless
// until a hard navigation.
test('content-recovery only preserves an existing hook when __facescrapHookInjected proves it installed', () => {
  assert.ok(
    recovery.includes(
      'if (recoveryBootstrap.__facescrapHookInjected === true || domHookAlive) {\n  recoveryBootstrap.__facescrapSkipPageHook = true;\n}',
    ),
    'must gate the skip on real evidence the hook installed',
  );
  // Exactly one assignment (the gated one above) — the old unconditional
  // assignment must not still exist alongside it.
  assert.equal((recovery.match(/__facescrapSkipPageHook = true/g) ?? []).length, 1);
});

// REPAIR (B1 follow-on) — __facescrapHookInjected alone can stay false for a
// genuinely alive, declaratively-installed hook (see
// tests/repair-b1-hook-liveness.test.ts): it is set only by a cross-realm
// message that content-recovery.ts's own listener-less context cannot even
// participate in, and by content.ts's listener, which the reviewer showed can
// register too late to catch page-hook.ts's one-shot query. Trusting the flag
// alone here would reinject and double-wrap a still-live declarative hook.
test('content-recovery ALSO trusts the DOM marker page-hook.ts stamps, not only the flag', () => {
  assert.ok(
    recovery.includes("const HOOK_ALIVE_ATTR = 'data-facescrap-hook';"),
    'must read the same DOM attribute name page-hook.ts writes',
  );
  const domReadIndex = recovery.indexOf(
    'domHookAlive = document.documentElement.hasAttribute(HOOK_ALIVE_ATTR);',
  );
  const flagIndex = recovery.indexOf('recoveryBootstrap.__facescrapHookInjected === true || domHookAlive');
  assert.ok(domReadIndex >= 0, 'must read the DOM marker into domHookAlive');
  assert.ok(flagIndex >= 0, 'the skip condition must OR the flag with domHookAlive, not replace or ignore the flag');
  assert.ok(domReadIndex < flagIndex, 'the DOM marker must be read before the combined condition uses it');
});

// FINDING B3 (call-site half; the DiagReason itself was registered by the
// foundations phase — see tests/fix-diag-ingress.test.ts) — a rejected
// mediaIngressBudget.tryTake() dropped the whole already-sanitized incoming
// batch with no diagBump, so the discard left no trace anywhere.
test('an ingress-budget rejection is counted via diagBump before the batch is silently dropped', () => {
  assert.ok(
    content.includes('if (!mediaIngressBudget.tryTake(items.length, bytes, performance.now())) {'),
    'the ingress-budget rejection must still gate the relay',
  );
  assert.ok(
    content.includes("diagBump('mediaIngressRejected');\n        return;\n      }"),
    'the rejected batch must bump the mediaIngressRejected diagnostic immediately before returning without relaying',
  );
  assert.doesNotMatch(
    content,
    /mediaIngressBudget\.tryTake\(items\.length, bytes, performance\.now\(\)\)\)\s*return;/,
    'the old unconditional one-line rejection (no diagBump) must be gone',
  );
});

// FINDING S6 — scheduleFacebookTheme hand-rolled its own pending-frame latch
// and rAF-or-setTimeout fallback, duplicating exactly what createFrameCoalescer
// (already used for imageLoadPlayingDetection in this same file) provides.
test('the old themeFrame/themeFrameUsesAnimation state is fully removed, not left dangling', () => {
  assert.doesNotMatch(
    content,
    /\bthemeFrame\b/,
    'bare themeFrame state must be gone (themeFrameDetection is a different identifier)',
  );
  assert.doesNotMatch(content, /\bthemeFrameUsesAnimation\b/);
});

test('scheduleFacebookTheme delegates to a createFrameCoalescer instance instead of scheduling rAF/setTimeout itself', () => {
  assert.ok(
    content.includes('const themeFrameDetection = createFrameCoalescer('),
    'the theme path must reuse createFrameCoalescer, like imageLoadPlayingDetection',
  );
  const scheduler = section(
    content,
    'function scheduleFacebookTheme(): void {',
    '\n\nfunction observeFacebookThemeRoots',
  );
  assert.ok(scheduler.includes('themeFrameDetection.request();'));
  assert.doesNotMatch(
    scheduler,
    /requestAnimationFrame|setTimeout/,
    'scheduleFacebookTheme itself must no longer schedule a frame/timeout directly',
  );
});

test('teardown cancels the theme coalescer the same way it cancels imageLoadPlayingDetection', () => {
  const teardownBody = section(
    content,
    'function teardown(): void {',
    '\nfunction send(message: RuntimeMessage): void {',
  );
  assert.ok(teardownBody.includes('themeFrameDetection.cancel();'));
  assert.ok(teardownBody.includes('imageLoadPlayingDetection.cancel();'));
});

// FINDING EF3 — the MutationObserver-triggered throttledScan() coalesced to
// one full scanDom() per 1200ms that unconditionally relayed EVERY currently
// qualifying DOM item, every pass, forever. AckedBatch's key dedupe only
// covers items still pending — an already-acked item is simply re-added as if
// new — so this repeatedly re-sent (and re-triggered a worker-side mergeMedia
// for) mostly-unchanged items on every busy page.
test('scanDom relays through a dedupe filter instead of re-sending every still-visible item every pass', () => {
  const scanDomBody = section(content, 'function scanDom(): void {', '\n\n// A slow or responsive image');
  assert.ok(
    scanDomBody.includes('relay(dedupeDomCapture(out));'),
    'scanDom must filter through dedupeDomCapture before relaying',
  );
  assert.doesNotMatch(scanDomBody, /\brelay\(out\);/, 'the raw un-deduped relay call must be gone');
});

test('the dedupe cache keys on observable state, not merely item id, so a real change still gets relayed', () => {
  const signatureFn = section(
    content,
    'function domCaptureSignature(item: MediaItem): string {',
    '\n/** Keep only the DOM-scan items whose id is new',
  );
  for (const field of ['item.url', 'item.width', 'item.height', 'item.thumbUrl']) {
    assert.ok(
      signatureFn.includes(field),
      `domCaptureSignature must fold in ${field}, or a state change on an already-seen id would be swallowed`,
    );
  }
  // The distinguishing property from a naive "seen id" Set: the suppress
  // condition must compare the tracked SIGNATURE, not merely check id
  // presence — a presence-only check is exactly the regression the finding
  // calls out (it would swallow a video whose src just resolved, or an image
  // whose dimensions just resolved, since the id was already "seen").
  assert.ok(
    content.includes('if (domCaptureSignatures.get(item.id) === signature) continue;'),
  );
});

// FINDING ALT6 — the shared "real content vs. avatar/thumbnail" pixel floor
// was re-spelled as a literal 200 at three call sites (content.ts's scanDom
// image gate, its <img> load-listener gate, and graphql-media.ts's candidate
// gate) instead of importing MIN_MEDIA_DIMENSION_PX, so the three could
// silently drift apart.
test('content.ts imports and uses the shared MIN_MEDIA_DIMENSION_PX floor at both its DOM image gates', () => {
  assert.match(
    content,
    /import\s*\{[^}]*\bMIN_MEDIA_DIMENSION_PX\b[^}]*\}\s*from\s*['"]\.\.\/shared\/media['"]/,
  );

  const domImageGate = section(
    content,
    "document.querySelectorAll('img').forEach((img) => {",
    '\n  });\n\n  diagBump',
  );
  assert.ok(domImageGate.includes('img.naturalWidth >= MIN_MEDIA_DIMENSION_PX'));
  assert.ok(domImageGate.includes('img.naturalHeight >= MIN_MEDIA_DIMENSION_PX'));
  assert.doesNotMatch(domImageGate, /\b200\b/, 'no re-spelled literal must remain in the scanDom image gate');

  const loadListener = section(content, 'const img = event.target;', '\n    const item = makeItem(src,');
  assert.ok(loadListener.includes('img.naturalWidth < MIN_MEDIA_DIMENSION_PX'));
  assert.ok(loadListener.includes('img.naturalHeight < MIN_MEDIA_DIMENSION_PX'));
  assert.doesNotMatch(loadListener, /\b200\b/, 'no re-spelled literal must remain in the load-listener gate');
});

test('graphql-media.ts imports and uses the same shared floor, not its own re-spelled literal', () => {
  assert.match(
    graphqlMedia,
    /import\s*\{[^}]*\bMIN_MEDIA_DIMENSION_PX\b[^}]*\}\s*from\s*['"]\.\/media['"]/,
  );
  assert.ok(graphqlMedia.includes('width < MIN_MEDIA_DIMENSION_PX'));
  assert.ok(graphqlMedia.includes('height < MIN_MEDIA_DIMENSION_PX'));
});

test('graphqlImageCandidate floor behaviour tracks MIN_MEDIA_DIMENSION_PX exactly, at the real boundary', () => {
  const IMAGE = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/x.jpg';
  assert.equal(
    graphqlImageCandidate({ uri: IMAGE, width: MIN_MEDIA_DIMENSION_PX - 1, height: 500 }, false),
    undefined,
    'one pixel below the shared floor must still be rejected',
  );
  assert.deepEqual(
    graphqlImageCandidate({ uri: IMAGE, width: MIN_MEDIA_DIMENSION_PX, height: 500 }, false),
    { url: IMAGE, width: MIN_MEDIA_DIMENSION_PX, height: 500 },
    'exactly at the shared floor must still be accepted',
  );
});
