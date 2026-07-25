// Regression checks for the sidepanel-lane code-review fixes (findings ALT5,
// C3, C4, D1, S3, S5, EF2, R4). sidepanel.ts requires a live document/chrome
// runtime it never gets under node:test, so — like every other
// tests/sidepanel-*.test.ts — these assert on the controller's source text
// rather than executing it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const controller = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

// ALT5 — every image download used to be named .jpg regardless of its real
// container (png/webp/gif/avif all classify as kind 'image').
test('derives every download extension from the shared fileExtensionFor helper, not a kind-only guess', () => {
  assert.doesNotMatch(controller, /function extFor\(/, 'the hardcoded kind->extension guess must be gone');
  assert.match(
    controller,
    /import \{[\s\S]*?\bfileExtensionFor\b[\s\S]*?\} from '\.\.\/shared\/media';/,
    'fileExtensionFor must be imported from the shared model',
  );
  assert.match(controller, /const name = `\$\{base\}\.\$\{fileExtensionFor\(item\)\}`;/);
  assert.match(controller, /const ext = fileExtensionFor\(target\)\.toUpperCase\(\);/);
  assert.match(controller, /byId\('m-format'\)\.textContent = fileExtensionFor\(target\)\.toUpperCase\(\);/);
});

// C3 — capabilities were only ever read once at init(), so a worker that
// republished `caps` after a cold start left offscreenAvailable (and the
// degraded banner) stuck on the startup default forever.
test('re-reads caps and the degraded banner when the worker republishes them, not just at init', () => {
  const initStart = controller.indexOf('async function init(): Promise<void> {');
  assert.ok(initStart >= 0, 'missing init()');
  // setupFacebookThemeStorageListener registers its OWN, unrelated
  // storage.session listener well before init() — search past init()'s start
  // so this finds the listener registered inside init(), not that one.
  const listenerStart = controller.indexOf(
    'chrome.storage.session.onChanged.addListener((changes) => {',
    initStart,
  );
  assert.ok(listenerStart > initStart, 'missing the main storage.session listener registered in init()');
  const gateIndex = controller.indexOf('if (tabId === undefined) return;', listenerStart);
  assert.ok(gateIndex > listenerStart, 'missing the tab-scoped gate inside the listener');

  const capsIndex = controller.indexOf("if ('caps' in changes)", listenerStart);
  assert.ok(
    capsIndex > listenerStart && capsIndex < gateIndex,
    'the caps re-read must run before the tab gate, or it would be skipped whenever no tab is tracked',
  );
  const capsBlock = controller.slice(capsIndex, gateIndex);
  assert.match(capsBlock, /void getCaps\(\)\.then\(\(caps\) => \{/);
  assert.match(capsBlock, /offscreenAvailable = caps\?\.offscreen \?\? true;/);
  assert.match(capsBlock, /byId\('degraded'\)\.hidden = offscreenAvailable;/);
  assert.match(capsBlock, /void render\(\);/);

  // The old tab-scoped OR list also matched 'caps' and called render() with
  // the STALE flag; the dedicated block above already renders once the fresh
  // value lands, so the tab-scoped list must not double up on it.
  const tabGateEnd = controller.indexOf('});', gateIndex);
  const tabGateBlock = controller.slice(gateIndex, tabGateEnd);
  assert.doesNotMatch(tabGateBlock, /'caps' in changes/);
});

// C4 — settling a download for a backgrounded tab used to only repaint the
// bulk tray, leaving the VIEWED tab's per-card Download buttons disabled
// forever (offscreenBusyHere() flipped false, but nothing repainted them).
test('always repaints the viewed tab after a card download settles, even for a backgrounded tab', () => {
  const start = controller.indexOf('async function downloadCard(');
  const end = controller.indexOf('\n// ── Card model', start);
  assert.ok(start >= 0 && end > start, 'missing downloadCard');
  const body = controller.slice(start, end);

  assert.doesNotMatch(body, /if \(tid === tabId\)/, 'the repaint must no longer branch on the download\'s own tab');
  assert.doesNotMatch(body, /paintTray\(\)/, 'a bare paintTray() can no longer stand in for a full repaint here');
  assert.match(
    body,
    /\n  await render\(\);\n\}/,
    'downloadCard must unconditionally render() as its last step',
  );
});

// C5 — the panel used to arm its DASH_UI_HARD_CAP_MS wait via a plain
// withHeartbeat(chrome.runtime.sendMessage(...), ...) call, at SEND time.
// service-worker.ts serializes every DASH job on one dashChain, so a request
// queued behind another long-running one could exhaust that whole budget
// while still queued — reported "The merge timed out." on a card the worker
// then finished anyway and wrote a Saved receipt for. The fix rebases the
// hard cap off a worker broadcast (FACESCRAP_DASH_JOB_STARTED) sent the
// instant a request leaves dashChain, matched by dashDownloadKey so a panel
// can never rebase off some OTHER window's job. sidepanel.ts cannot run under
// node:test (see this file's header), so this asserts on its source text; the
// worker-side broadcast ordering itself is exercised behaviourally in
// tests/prot-dash-job-started.test.ts.
test('rebases the DASH hard cap off a job-started signal instead of arming it once at send time', () => {
  // The old bug shape: withHeartbeat's hard timer is armed exactly once, at
  // sendMessage time, and is never exposed for a caller to reset — reverting
  // to it (or to any construct that doesn't expose a rebase hook) reopens C5.
  assert.doesNotMatch(
    controller,
    /from '\.\.\/shared\/async'/,
    'withHeartbeat (async.ts) has no rebase hook; the DASH wait must not go back to using it directly',
  );
  assert.match(
    controller,
    /import \{[\s\S]*?\bwithRearmableHardCap\b[\s\S]*?\} from '\.\.\/shared\/messages';/,
    'withRearmableHardCap must be imported from messages.ts',
  );
  assert.match(
    controller,
    /import \{ dashDownloadKey \} from '\.\.\/shared\/download-settlement';/,
    'dashDownloadKey must be imported so this wait can compute the SAME key service-worker.ts broadcasts',
  );

  const start = controller.indexOf('async function startDashDownload(');
  const end = controller.indexOf('\n/** Direct download of', start);
  assert.ok(start >= 0 && end > start, 'missing startDashDownload');
  const body = controller.slice(start, end);

  // The key must be computed from the SAME fields sent in the message, BEFORE
  // the send — not derived from the (later, worker-only) response.
  const keyIndex = body.indexOf('const key = dashDownloadKey(');
  const sendIndex = body.indexOf('chrome.runtime.sendMessage({');
  assert.ok(keyIndex >= 0, 'startDashDownload must compute a dashDownloadKey for this request');
  assert.ok(keyIndex < sendIndex, 'the key must be computed before the request is sent');
  assert.match(body, /withRearmableHardCap\(/, 'the send must be guarded by withRearmableHardCap, not withHeartbeat');
  assert.doesNotMatch(body, /withHeartbeat\(/, 'withHeartbeat must not reappear in startDashDownload');

  // The rebase hook must actually be wired to this specific request's key,
  // not just constructed and discarded.
  assert.match(body, /pendingDashJobKey = key;/, 'the pending job key must be recorded for this wait');
  assert.match(
    body,
    /armDashJobHardCap = guarded\.armStarted;/,
    'guarded.armStarted must be wired up so a job-started signal can rebase this wait',
  );
  // And unwound in the finally, alongside muxBeat — a stale key/rebase hook
  // left behind after this wait settles could let a LATER, unrelated job's
  // start signal reach back into an already-finished download.
  const finallyIndex = body.indexOf('} finally {', sendIndex);
  const settleBlockEnd = body.indexOf('if (!r?.ok)', finallyIndex);
  assert.ok(finallyIndex > sendIndex && settleBlockEnd > finallyIndex, 'missing the settle finally block');
  const finallyBlock = body.slice(finallyIndex, settleBlockEnd);
  assert.match(finallyBlock, /armDashJobHardCap = null;/);
  assert.match(finallyBlock, /pendingDashJobKey = null;/);

  // The listener that turns the worker's broadcast into a rebase must match
  // on the pending job's OWN key — matching on type alone would rebase this
  // wait off any other window's queued job, reproducing the same bug this
  // fix closes (see FACESCRAP_MUX_PROGRESS's own intentionally key-less beat,
  // just above, for the contrast).
  const listenerStart = controller.indexOf("chrome.runtime.onMessage.addListener((msg) => {");
  const listenerEnd = controller.indexOf('});', listenerStart);
  assert.ok(listenerStart > 0 && listenerEnd > listenerStart, 'missing the MUX_PROGRESS/JOB_STARTED listener');
  const listenerBlock = controller.slice(listenerStart, listenerEnd);
  assert.match(
    listenerBlock,
    /m\?\.type === 'FACESCRAP_DASH_JOB_STARTED' && m\.key === pendingDashJobKey/,
    'the job-started branch must gate on the key matching THIS panel\'s pending job',
  );
  assert.match(listenerBlock, /armDashJobHardCap\?\.\(\);/);
});

// D1 — the Clear handler mutated state and then awaited an unguarded
// sendMessage; a rejection (extension context invalidated, receiving end
// gone) vanished as an unhandled rejection and the re-render never ran.
test('surfaces a rejected FACESCRAP_CLEAR_TAB send and still renders instead of dropping the rejection', () => {
  const start = controller.indexOf("byId('clear').addEventListener('click', async () => {");
  const end = controller.indexOf('chrome.storage.session.onChanged.addListener((changes) => {', start);
  assert.ok(start >= 0 && end > start, 'missing the #clear click handler');
  const handler = controller.slice(start, end);

  const tryIndex = handler.indexOf('try {');
  const sendIndex = handler.indexOf('FACESCRAP_CLEAR_TAB');
  const catchIndex = handler.indexOf('} catch (e) {');
  const logIndex = handler.indexOf("console.error('[FaceScrap]', e);");
  const sigResetIndex = handler.indexOf("lastRenderSig = '';");
  const renderIndex = handler.indexOf('await render();');

  assert.ok(tryIndex >= 0, 'the worker send must be guarded by try/catch');
  assert.ok(tryIndex < sendIndex && sendIndex < catchIndex, 'FACESCRAP_CLEAR_TAB must be sent inside the try block');
  assert.ok(catchIndex < logIndex, 'a rejected send must be logged, matching the download senders\' style');
  assert.ok(
    logIndex < sigResetIndex && sigResetIndex < renderIndex,
    'the handler must still reset the signature and render after a rejected send',
  );
});

// S3 — lastFailed (a Set<string>) was exactly redundant with failReason (a
// Map<string,string>): every producer of a failure reason stores a
// non-empty string, so presence as a failReason KEY already meant "last
// attempt failed." Two structures kept in lockstep by hand across six touch
// sites is itself a bug waiting to happen (a future edit to one without the
// other silently desyncs the tag from its tooltip). Fix: delete the Set,
// derive membership from the Map alone.
test('failReason alone drives the failed-tag UI; the redundant lastFailed Set is gone', () => {
  assert.doesNotMatch(controller, /\blastFailed\b/, 'lastFailed must be fully removed, not just unused');

  // Every former lastFailed.has(...) read site now reads failReason.has(...)
  // directly — cardMeta's tag, paintNow's Retry label, and both signatures.
  assert.ok(
    controller.includes('if (!card.stale && failReason.has(tabKey(tabId, card.id)))'),
    'cardMeta must key the Failed tag off failReason.has(...)',
  );
  assert.ok(
    controller.includes(': failReason.has(tabKey(tabId, now.id))'),
    'paintNow must key the Retry label off failReason.has(...)',
  );
  assert.ok(
    controller.includes('${failReason.has(tabKey(tid, now.id)) ? 1 : 0}'),
    'nowSig must fold failReason.has(...) in directly, not a second Set',
  );
  assert.ok(
    controller.includes('${failReason.has(tabKey(tid, c.id)) ? 1 : 0}'),
    'the grid signature must fold failReason.has(...) in directly, not a second Set',
  );

  // pruneTabState prunes exactly failReason and qualityChoice by tab prefix
  // now — a third (lastFailed) loop reappearing would defeat the fix.
  const pruneStart = controller.indexOf('function pruneTabState(tid: number): void {');
  const pruneEnd = controller.indexOf('\n}', pruneStart);
  assert.ok(pruneStart >= 0 && pruneEnd > pruneStart, 'missing pruneTabState');
  const pruneBody = controller.slice(pruneStart, pruneEnd);
  assert.equal(
    (pruneBody.match(/\.startsWith\(prefix\)/g) ?? []).length,
    2,
    'pruneTabState must prune exactly failReason and qualityChoice by tab prefix — not a third (lastFailed) loop',
  );
});

// S5 — renderCard and paintNow each hand-built the same bg/img thumbnail
// pair and had quietly DIVERGED: renderCard alone had lazy-loading and an
// icon fallback on error; paintNow alone had the live resolution readout
// wired into load plus an img.complete re-check for an already-cached image.
// Fix: one shared builder, with each call site's own behaviour passed in as
// options — neither side's behaviour may be dropped by the merge.
test('renderCard and paintNow share one thumbnail-pair builder instead of two diverged copies', () => {
  assert.ok(controller.includes('function buildThumbPair('), 'missing the shared buildThumbPair builder');
  assert.ok(
    controller.includes(
      'options: { lazy?: boolean; onLoad?: (img: HTMLImageElement) => void; onError?: () => void } = {},',
    ),
    'buildThumbPair must accept lazy/onLoad/onError as options',
  );
  assert.ok(
    controller.includes('): { bg: HTMLImageElement; img: HTMLImageElement } {'),
    'buildThumbPair must return both the bg and sharp img elements',
  );

  // Exactly one place builds the bg/img pair now — previously renderCard and
  // paintNow each had their own `bg.className = 'thumb-bg'` construction.
  const thumbBgAssignments = controller.match(/bg\.className = 'thumb-bg';/g) ?? [];
  assert.equal(thumbBgAssignments.length, 1, 'bg construction must live in exactly one place (buildThumbPair)');

  // renderCard: lazy loading + the icon fallback on error must survive.
  assert.ok(
    controller.includes("const { bg, img } = buildThumbPair(card.thumbUrl, thumb, { lazy: true, onError: showIcon });"),
    'renderCard must keep passing lazy:true and the icon fallback into the shared builder',
  );

  // paintNow: the resolution readout wired into load, plus the img.complete
  // re-check for an already-cached image, must both survive.
  assert.ok(
    controller.includes(
      "const { bg, img } = buildThumbPair(now.thumbUrl, preview, { onLoad: paintImageResolution });",
    ),
    "paintNow must keep wiring paintImageResolution into the shared builder's onLoad",
  );
  assert.ok(
    controller.includes('preview.prepend(bg, img);\n    if (img.complete) paintImageResolution(img);'),
    'paintNow must keep re-checking img.complete for an already-cached image',
  );

  // The builder itself must still apply BOTH per-call-site behaviours it is
  // handed: lazy loading is conditional (only renderCard asks for it), and
  // onLoad/onError run after the shared applyMediaFit/removal work.
  assert.ok(
    controller.includes("if (options.lazy) bg.loading = 'lazy';"),
    'the builder must only set lazy loading when asked',
  );
  assert.ok(
    controller.includes('applyMediaFit(img, container);\n    options.onLoad?.(img);'),
    'the builder must run applyMediaFit before the per-call-site onLoad hook',
  );
  assert.ok(
    controller.includes('img.remove();\n    bg.remove();\n    options.onError?.();'),
    'the builder must remove both images before the per-call-site onError hook',
  );
});

// EF2 — the 500ms Now Playing tick called render(), and doRender() built the
// ENTIRE card model (groups, per-video representation scoring, cardsById,
// buildNowState) before ever checking whether anything visible had changed.
// Fix: a cheap signature computed straight from the raw inputs (items,
// playing, settings, ...) bails BEFORE that rebuild when nothing moved.
test('doRender bails on a cheap signature before the expensive card-model rebuild', () => {
  assert.match(controller, /let lastCheapSig = '';/, 'missing the cheap-signature cache alongside lastRenderSig');

  const groupingIndex = controller.indexOf('// Group videos by asset (one card per video)');
  assert.ok(groupingIndex > 0, 'missing the card-model build this fix must run BEFORE');

  const cheapGateIndex = controller.indexOf('if (cheapSig === lastCheapSig) {');
  assert.ok(cheapGateIndex > 0, 'missing the cheap early-out gate');
  assert.ok(cheapGateIndex < groupingIndex, 'the cheap gate must bail before the card-model build, not after it');

  // The cheap gate must actually return before doing any of that work.
  const cheapGateEnd = controller.indexOf('\n  }', cheapGateIndex);
  assert.ok(
    cheapGateEnd > cheapGateIndex && cheapGateEnd < groupingIndex,
    'the cheap gate block must close before grouping starts',
  );
  const cheapGateBody = controller.slice(cheapGateIndex, cheapGateEnd);
  assert.match(cheapGateBody, /return;/, 'the cheap gate must return, not merely note the match');

  // Committing the cheap signature must happen at the exact same place the
  // real signature commits — otherwise a later tick could compare against a
  // stale cheapSig that no longer corresponds to what was actually painted.
  assert.match(
    controller,
    /lastRenderSig = sig;\s*\n\s*lastCheapSig = cheapSig;/,
    'lastCheapSig must commit alongside lastRenderSig',
  );

  // Every place lastRenderSig is force-reset to '' must reset lastCheapSig
  // too, or a forced rebuild (tab switch, Clear, Select all, a bulk run
  // finishing) could be silently skipped by the cheap gate comparing against
  // a cheapSig that was never invalidated.
  const renderSigResets = (controller.match(/lastRenderSig = '';/g) ?? []).length;
  const cheapSigResets = (controller.match(/lastCheapSig = '';/g) ?? []).length;
  assert.ok(renderSigResets >= 4, 'expected at least the 4 known forced-rebuild sites');
  assert.equal(
    cheapSigResets,
    renderSigResets,
    'lastCheapSig must be reset everywhere lastRenderSig is, or the two can fall out of step',
  );
});

// R4 (panel half) — setupSystemTheme subscribed to matchMedia but never
// unsubscribed: content.ts's mirrored theme listener tears down through its
// own page-lifecycle hook, but nothing here ever called removeEventListener/
// removeListener, so the query (and the closure it captured) outlived the
// panel for as long as its JS realm did.
test('setupSystemTheme unsubscribes its matchMedia listener on pagehide', () => {
  const start = controller.indexOf('function setupSystemTheme(): void {');
  const end = controller.indexOf('\nfunction setupFacebookThemeStorageListener', start);
  assert.ok(start >= 0 && end > start, 'missing setupSystemTheme');
  const body = controller.slice(start, end);

  assert.match(
    body,
    /const handleSystemThemeChange = \(\): void => \{/,
    'missing the change handler to unsubscribe later',
  );
  assert.match(body, /systemThemeQuery\.addEventListener\('change', handleSystemThemeChange\);/);

  const pagehideIndex = body.indexOf("window.addEventListener('pagehide',");
  assert.ok(pagehideIndex > 0, 'setupSystemTheme must register a pagehide teardown for its own listener');
  const teardown = body.slice(pagehideIndex);

  assert.match(
    teardown,
    /systemThemeQuery\?\.removeEventListener === 'function'/,
    'the teardown must feature-detect removeEventListener, mirroring the addEventListener branch above',
  );
  assert.match(
    teardown,
    /systemThemeQuery\.removeEventListener\('change', handleSystemThemeChange\);/,
    'the teardown must actually remove the SAME handler that was added',
  );
  assert.match(
    teardown,
    /systemThemeQuery\?\.removeListener === 'function'/,
    'the teardown must also cover the legacy addListener fallback',
  );
  assert.match(teardown, /systemThemeQuery\.removeListener\(handleSystemThemeChange\);/);
});
