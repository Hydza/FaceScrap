import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const HARNESS_PATH = join(ROOT, 'scripts', 'sidepanel-visual-qa.mjs');
const PACKAGE_PATH = join(ROOT, 'package.json');
const README_EN_PATH = join(ROOT, 'README.md');
const README_ES_PATH = join(ROOT, 'README.es.md');
const harness = readFileSync(HARNESS_PATH, 'utf8');
const readmeEn = readFileSync(README_EN_PATH, 'utf8');
const readmeEs = readFileSync(README_ES_PATH, 'utf8');
const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
  scripts?: Record<string, string>;
};

test('records reference comparisons as manual review instead of an automatic pass', () => {
  const captureComparisons = harness.match(
    /async function captureComparisons[\s\S]*?\n}\n\nfunction assertProfileIsOwned/,
  )?.[0];
  assert.ok(captureComparisons, 'missing captureComparisons implementation');
  assert.doesNotMatch(captureComparisons, /\bpassed:\s*true\b/);
  assert.match(captureComparisons, /capturedForManualReview:\s*true/);
  assert.match(harness, /referenceComparison\.status\s*=\s*'capturedForManualReview'/);
});

test('checks every Library and Saved video card across aspect ratios and a resize', () => {
  assert.match(harness, /qa-vertical/);
  assert.match(harness, /qa-horizontal/);
  assert.match(harness, /qa-square/);
  assert.match(harness, /function inspectCardPlayPositions/);
  assert.match(harness, /querySelectorAll\('#list \.card-thumb\.is-video'\)/);
  assert.match(harness, /cardPlayPositionsValid/);
  assert.match(harness, /cardPlayResizeValid/);
  assert.match(harness, /Emulation\.setDeviceMetricsOverride/);
});

test('promotes one canonical image from a stored low variant to the captured high variant', () => {
  assert.match(harness, /qa-image-variant-12345678901234567_n\.jpg/);
  assert.match(harness, /stp=dst-jpg_p590x443&oh=qa-low-signature/);
  assert.match(harness, /stp=dst-jpg_p944x1088&oh=qa-high-signature/);
  assert.match(harness, /width:\s*590,\s*height:\s*443/);
  assert.match(harness, /width:\s*944,\s*height:\s*1_088/);
  assert.match(harness, /const imageLow = \{[\s\S]*?kind:\s*'image',[\s\S]*?source:\s*'video'/);
  assert.match(harness, /low\.id !== high\.id/);
  assert.match(harness, /new URL\(low\.url\)\.pathname !== new URL\(high\.url\)\.pathname/);
  assert.match(harness, /async function captureImageNowPlaying/);
  assert.match(harness, /phase:\s*'low'/);
  assert.match(harness, /phase:\s*'high'/);
  assert.match(harness, /mediaKey/);
  assert.match(harness, /chrome\.storage\.session\.set/);
  assert.match(harness, /storedHighVariant/);
  assert.ok(
    harness.indexOf("phase: 'low'") < harness.indexOf("phase: 'high'"),
    'the harness must observe LOW before writing HIGH',
  );
});

test('delivers HIGH through a real DOM image load and the content-script listener', () => {
  assert.match(harness, /Runtime\.executionContextCreated/);
  assert.match(harness, /async function waitForExtensionContentScriptContext/);
  assert.match(harness, /candidate\.origin === expectedOrigin/);
  assert.match(harness, /candidate\.auxData\?\.type === 'isolated'/);
  assert.match(harness, /async function evaluateInExecutionContext/);
  assert.match(harness, /contextId/);
  assert.match(harness, /async function captureHighImageThroughSyntheticDom/);
  assert.match(harness, /Fetch\.fulfillRequest/);
  assert.match(harness, /urlPattern:\s*'\*:\/\/\*\.fbcdn\.net\/\*_qa_variant=high\*'/);
  assert.match(harness, /Content-Type',\s*value:\s*'image\/svg\+xml; charset=utf-8'/);
  assert.match(harness, /Cache-Control',\s*value:\s*'no-store'/);
  assert.match(harness, /document\.createElement\('img'\)/);
  assert.match(harness, /image instanceof HTMLImageElement/);
  assert.match(harness, /image\.naturalWidth === 944/);
  assert.match(harness, /image\.naturalHeight === 1088/);
  assert.match(harness, /content\.ts capture listener -> MEDIA_FOUND -> service-worker addMedia\/mergeMedia/);
  assert.match(harness, /highDomIngressObserved/);

  const domCaptureStart = harness.indexOf('async function captureHighImageThroughSyntheticDom');
  const domCaptureEnd = harness.indexOf('\nasync function paintSyntheticFacebookTheme', domCaptureStart);
  assert.ok(domCaptureStart >= 0 && domCaptureEnd > domCaptureStart);
  assert.doesNotMatch(
    harness.slice(domCaptureStart, domCaptureEnd),
    /chrome\.runtime\.sendMessage/,
    'the QA harness must let content.ts emit MEDIA_FOUND from the real image load',
  );

  const captureStart = harness.indexOf('async function captureImageNowPlaying');
  const captureEnd = harness.indexOf('\nasync function captureOpenSelect', captureStart);
  assert.ok(captureStart >= 0 && captureEnd > captureStart);
  const capture = harness.slice(captureStart, captureEnd);
  const highStart = capture.indexOf('const highIngress = await captureHighImageThroughSyntheticDom');
  const highEnd = capture.indexOf('const highMetadataBeforeImageLoad', highStart);
  assert.ok(highStart >= 0 && highEnd > highStart, 'missing HIGH ingress/storage phase');
  assert.doesNotMatch(
    capture.slice(highStart, highEnd),
    /chrome\.storage\.session\.set/,
    'HIGH must be persisted by MEDIA_FOUND -> worker addMedia/mergeMedia, not direct QA storage',
  );
  assert.ok(
    harness.indexOf('const imageCapture = await captureImageNowPlaying') <
      harness.lastIndexOf('quiesceSyntheticFacebookPage(facebookPage)'),
    'the image promotion must run while the real content-script context is alive',
  );
});

test('exercises object-shaped GraphQL and viewport-centred media through the real detector', () => {
  assert.match(harness, /async function exerciseDetectionPipeline/);
  assert.match(harness, /playable_url_quality_sd:\s*\{\s*uri:\s*graphqlVideoUrl\s*\}/);
  assert.match(harness, /width:\s*'944',\s*height:\s*'1088'/);
  assert.match(harness, /document\.createElement\('video'\)/);
  assert.match(harness, /data-facescrap-detection-probe/);
  assert.match(harness, /backgroundImage:\s*'url\("/);
  assert.match(harness, /item\?\.origin === 'dom'/);
  assert.match(harness, /visibleVideoUpdatedBelowTwoSeconds/);
  assert.match(harness, /visibleImageUpdatedBelowTwoSeconds/);
  assert.match(harness, /previousCaptureWaitMs:\s*4_000/);
  assert.match(harness, /detectionPipeline = await exerciseDetectionPipeline/);
  assert.match(harness, /Live detection pipeline QA failed/);
});

test('proves the final image Now Playing contract and download target without network', () => {
  assert.match(harness, /releaseHighVariant/);
  assert.match(harness, /highMetadataBeforeImageLoad/);
  assert.match(harness, /expectedTitle = language === 'es' \? 'Imagen' : 'Image'/);
  assert.match(harness, /foreground\.naturalWidth/);
  assert.match(harness, /foreground\.naturalHeight/);
  assert.match(harness, /durationMetricHidden/);
  assert.match(harness, /resolutionIsHighVariant/);
  assert.match(harness, /titleLocalized/);
  assert.match(harness, /previewUsesHighUrl/);
  assert.match(harness, /downloadUsesHighUrl/);
  assert.match(harness, /downloadReceiptUsesHighUrl/);
  assert.match(harness, /imageQualitySelectorHidden/);
  assert.match(harness, /FACESCRAP_DOWNLOAD_DIRECT/);
  assert.match(harness, /qaDownloadProbe/);
  assert.match(harness, /videoDurationPreserved/);
  assert.match(harness, /videoResolutionPreserved/);
  assert.match(harness, /now-image-low\.png/);
  assert.match(harness, /now-image\.png/);
  assert.match(
    harness,
    /captureImageNowPlaying\(\s*page,\s*facebookPage,\s*syntheticFacebook\.executionContexts,\s*extensionId,\s*fixture,\s*evidence\.seed\.tabId,\s*language,\s*fixtureImages,\s*\)/,
  );
  const start = harness.indexOf('async function captureImageNowPlaying');
  const end = harness.indexOf('\nasync function captureOpenSelect', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(harness.slice(start, end), /chrome\.tabs\.query/);
});

test('checks the quality option count as a language-independent number', () => {
  assert.match(harness, /qualityCountNumeric/);
  assert.match(harness, /qualityOptionCount/);
  assert.match(harness, /qualityOptionsPreserved/);
  assert.match(harness, /qualitySelectionPreserved/);
  assert.match(harness, /languageApplied/);
});

test('captures and restores the deterministic single-option quality state', () => {
  const start = harness.indexOf('async function captureSingleQualityOption');
  const end = harness.indexOf('\nasync function openPageTarget', start);
  assert.ok(start >= 0 && end > start, 'missing single-option quality capture');
  const capture = harness.slice(start, end);

  assert.match(capture, /now-quality-single-option\.png/);
  assert.match(capture, /qualityCountHiddenAndEmpty/);
  assert.match(capture, /qualitySelectDisabled/);
  assert.match(capture, /singleResolutionLabel/);
  assert.match(capture, /chevronHidden:\s*style\.backgroundImage === 'none'/);
  assert.match(capture, /Math\.abs\(rect\.width - qualityRect\.width\) <= 2/);
  assert.match(capture, /Math\.abs\(rect\.height - 46\) <= 2/);
  assert.match(capture, /finally \{/);
  assert.match(capture, /restored two-option Now Playing quality selector/);
  assert.match(capture, /count\.textContent\.trim\(\) === '2'/);
  assert.match(capture, /!select\.disabled/);
  assert.match(capture, /labels\[0\] === '1080p'/);
  assert.match(capture, /labels\[1\] === '720p'/);
  assert.match(harness, /captureSingleQualityOption\(page,\s*fixture,\s*evidence\.seed\.tabId\)/);
  assert.match(harness, /evidence\.interactionCaptures\.push\(singleQualityCapture\)/);
});

test('captures both compact-height quality states and restores the normal fixture and viewport', () => {
  const start = harness.indexOf('async function captureCompactQualityScreenshot');
  const end = harness.indexOf('\nasync function openPageTarget', start);
  assert.ok(start >= 0 && end > start, 'missing compact quality QA');
  const capture = harness.slice(start, end);

  assert.match(capture, /height:\s*650/);
  assert.match(capture, /now-quality-compact-two-options\.png/);
  assert.match(capture, /now-quality-compact-single-option\.png/);
  assert.match(capture, /count\.textContent\.trim\(\) === '2'/);
  assert.match(capture, /!select\.disabled/);
  assert.match(capture, /style\.backgroundImage !== 'none'/);
  assert.match(capture, /count\.textContent\.trim\(\) === ''/);
  assert.match(capture, /select\.disabled/);
  assert.match(capture, /style\.backgroundImage === 'none'/);
  assert.match(capture, /noHorizontalOverflow/);
  assert.match(capture, /Math\.abs\(rect\.height - 32\) <= 2/);
  assert.match(capture, /Math\.abs\(rect\.width - qualityRect\.width\) <= 2/);
  assert.match(capture, /finally \{/);
  assert.match(capture, /await setViewport\(page,\s*VIEWPORT\)/);
  assert.match(capture, /innerHeight === \$\{VIEWPORT\.height\}/);
  assert.match(capture, /restored normal viewport and two-option quality fixture/);
  assert.match(harness, /captureCompactQualityStates\(page,\s*fixture,\s*evidence\.seed\.tabId\)/);
  assert.match(harness, /evidence\.interactionCaptures\.push\(compactQualityCapture\)/);
  assert.ok(
    harness.indexOf('captureCompactQualityStates(page, fixture, evidence.seed.tabId)') <
      harness.indexOf("for (const surface of ['now', 'library', 'saved', 'settings'])"),
    'the compact QA must restore state before normal captures',
  );
});

test('updates a focused but closed quality selector well below the render-hold timeout', () => {
  const timeoutMatch = harness.match(/const FOCUSED_CLOSED_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(timeoutMatch, 'missing focused-closed timeout');
  const timeoutMs = Number(timeoutMatch[1].replaceAll('_', ''));
  assert.ok(timeoutMs <= 2_000, `focused-closed timeout must not exceed 2s, received ${timeoutMs}ms`);

  const start = harness.indexOf('async function captureFocusedClosedQualityTransition');
  const end = harness.indexOf('\nasync function openPageTarget', start);
  assert.ok(start >= 0 && end > start, 'missing focused-closed quality QA');
  const capture = harness.slice(start, end);

  assert.match(capture, /now-quality-focused-closed-transition\.png/);
  assert.match(capture, /select\.focus\(\{ preventScroll: true \}\)/);
  assert.match(capture, /document\.activeElement === select/);
  assert.match(capture, /select\.matches\(':open'\)/);
  assert.doesNotMatch(capture, /showPicker/);
  assert.doesNotMatch(capture, /Input\.dispatch/);
  assert.match(capture, /focusedClosed\.open !== false/);
  assert.match(capture, /FOCUSED_CLOSED_TIMEOUT_MS/);
  assert.match(capture, /updatedWithinFocusedClosedTimeout/);
  assert.match(capture, /count\.hidden/);
  assert.match(capture, /count\.textContent\.trim\(\) === ''/);
  assert.match(capture, /select\.disabled/);
  assert.match(capture, /labels\.length === 1/);
  assert.match(capture, /backgroundImage === 'none'/);
  assert.match(capture, /finally \{/);
  assert.match(capture, /document\.activeElement\.blur\(\)/);
  assert.match(capture, /restored two-option fixture after the focused-closed transition/);
  assert.match(harness, /captureFocusedClosedQualityTransition\(\s*page,\s*fixture,\s*evidence\.seed\.tabId,\s*\)/);
  assert.match(harness, /evidence\.interactionCaptures\.push\(focusedClosedCapture\)/);
});

test('forces the legacy picker fallback once and bounds its eventual storage update', () => {
  const timeoutMatch = harness.match(/const FORCED_FALLBACK_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(timeoutMatch, 'missing forced-fallback timeout');
  const timeoutMs = Number(timeoutMatch[1].replaceAll('_', ''));
  assert.ok(timeoutMs <= 2_000, `forced-fallback timeout must not exceed 2s, received ${timeoutMs}ms`);

  const start = harness.indexOf('async function captureForcedFallbackQualityTransition');
  const end = harness.indexOf('\nasync function openPageTarget', start);
  assert.ok(start >= 0 && end > start, 'missing forced-fallback quality QA');
  const capture = harness.slice(start, end);
  const finallyStart = capture.indexOf('  } finally {');
  assert.ok(finallyStart > 0, 'forced-fallback QA must restore state in finally');
  const transition = capture.slice(0, finallyStart);

  assert.match(capture, /now-quality-forced-fallback-transition\.png/);
  assert.match(transition, /Object\.defineProperty\(select,\s*'matches'/);
  assert.match(transition, /if \(selector === ':open'\)/);
  assert.match(transition, /throw new Error\('FaceScrap QA forced :open fallback'\)/);
  assert.match(transition, /Element\.prototype\.matches\.call\(this,\s*selector\)/);
  assert.match(transition, /select\.focus\(\{ preventScroll: true \}\)/);
  assert.equal(
    (transition.match(/new PointerEvent\('pointerdown'/g) ?? []).length,
    1,
    'forced fallback must dispatch exactly one pointerdown gesture',
  );
  assert.doesNotMatch(transition, /showPicker/);
  assert.doesNotMatch(transition, /\.blur\(\)/);
  assert.doesNotMatch(transition, /['"]change['"]/);
  assert.doesNotMatch(transition, /['"]Escape['"]/);
  assert.match(transition, /openMatchThrowCount > 0/);
  assert.match(transition, /pointerdownDispatchCount === 1/);
  assert.match(transition, /FORCED_FALLBACK_TIMEOUT_MS/);
  assert.match(transition, /updatedWithinForcedFallbackTimeout/);
  assert.match(transition, /count\.textContent\.trim\(\) === ''/);
  assert.match(transition, /select\.disabled/);
  assert.match(transition, /labels\.length === 1/);
  assert.match(transition, /backgroundImage === 'none'/);

  const cleanup = capture.slice(finallyStart);
  assert.match(cleanup, /Object\.defineProperty\(probe\.select,\s*'matches',\s*probe\.ownDescriptor\)/);
  assert.match(cleanup, /delete probe\.select\.matches/);
  assert.match(cleanup, /delete globalThis\[probeKey\]/);
  assert.match(cleanup, /document\.activeElement\.blur\(\)/);
  assert.match(cleanup, /restored two-option fixture and native matches after the forced fallback transition/);
  assert.match(harness, /captureForcedFallbackQualityTransition\(\s*page,\s*fixture,\s*evidence\.seed\.tabId,\s*\)/);
  assert.match(harness, /evidence\.interactionCaptures\.push\(forcedFallbackCapture\)/);
});

test('serves a local reference from a contained loopback HTTP root', () => {
  assert.doesNotMatch(harness, /--allow-file-access-from-files/);
  assert.match(harness, /function isPathInside/);
  assert.match(harness, /async function startReferenceServer/);
  assert.match(harness, /host:\s*'127\.0\.0\.1'/);
  assert.match(harness, /realpath/);
  assert.match(harness, /statusCode\s*=\s*403/);
  assert.match(harness, /pathname === '\/favicon\.ico'/);
  assert.match(harness, /server\.closeAllConnections\?\.\(\)/);
  const cleanup = harness.match(/\n  } finally \{[\s\S]*?\n  }\n\n  if \(runError\)/)?.[0];
  assert.ok(cleanup, 'missing main cleanup block');
  assert.ok(
    cleanup.indexOf('stopBrowser(browser, child, browserExit)') < cleanup.indexOf('referenceServer.close()'),
    'Browser must stop before closing its keep-alive reference server',
  );
});

test('fails the cleanup gate when the reference server does not stop', () => {
  const functionSource = harness.match(
    /function cleanupSucceeded\(cleanup, profileExpected, referenceServerExpected\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(functionSource, 'missing cleanupSucceeded implementation');
  const cleanupSucceeded = Function(`return (${functionSource})`)() as (
    cleanup: Record<string, boolean>,
    profileExpected: boolean,
    referenceServerExpected: boolean,
  ) => boolean;

  assert.equal(
    cleanupSucceeded(
      { browserStopped: true, profileRemoved: true, referenceServerStopped: false },
      true,
      true,
    ),
    false,
  );
  assert.equal(
    cleanupSucceeded(
      { browserStopped: true, profileRemoved: true, referenceServerStopped: true },
      true,
      true,
    ),
    true,
  );
  assert.ok((harness.match(/cleanupSucceeded\(/g) ?? []).length >= 3, 'cleanup gate must guard status and exit');
});

test('exposes complete sidepanel QA and verification scripts', () => {
  assert.equal(pkg.scripts?.['qa:sidepanel'], 'node scripts/sidepanel-visual-qa.mjs');
  assert.equal(pkg.scripts?.verify, 'npm run check && npm run build && npm run qa:sidepanel');
});

test('supports deterministic English and Spanish visual QA captures', () => {
  const functionSource = harness.match(/function parseArguments\(argv\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, 'missing parseArguments implementation');
  const parseArguments = Function('resolve', `return (${functionSource})`)(resolve) as (
    argv: string[],
  ) => {
    referencePath?: string;
    language: 'en' | 'es';
    browserName: 'edge' | 'brave';
    theme: 'light' | 'dark' | 'auto';
  };

  assert.deepEqual(parseArguments([]), {
    referencePath: undefined,
    language: 'es',
    browserName: 'edge',
    theme: 'light',
  });
  assert.deepEqual(parseArguments(['--lang', 'en']), {
    referencePath: undefined,
    language: 'en',
    browserName: 'edge',
    theme: 'light',
  });
  assert.deepEqual(parseArguments(['--lang=es']), {
    referencePath: undefined,
    language: 'es',
    browserName: 'edge',
    theme: 'light',
  });
  assert.throws(() => parseArguments(['--lang', 'fr']), /--lang must be en or es/);
  assert.throws(() => parseArguments(['--lang', 'en', '--lang=es']), /--lang may only be provided once/);
  assert.match(harness, /seedStorage\(page, fixture, language, theme\)/);
  assert.match(harness, /chrome\.storage\.local\.set\(\{ lang: language, settings: fixture\.settings \}\)/);
});

test('supports Edge and Brave with generic browser cleanup evidence', () => {
  const functionSource = harness.match(/function parseArguments\(argv\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, 'missing parseArguments implementation');
  const parseArguments = Function('resolve', `return (${functionSource})`)(resolve) as (
    argv: string[],
  ) => { browserName: 'edge' | 'brave' };

  assert.equal(parseArguments([]).browserName, 'edge');
  assert.equal(parseArguments(['--browser', 'brave']).browserName, 'brave');
  assert.equal(parseArguments(['--browser=edge']).browserName, 'edge');
  assert.throws(() => parseArguments(['--browser', 'chrome']), /--browser must be edge or brave/);
  assert.throws(
    () => parseArguments(['--browser', 'edge', '--browser=brave']),
    /--browser may only be provided once/,
  );
  assert.match(harness, /Microsoft\\{2}Edge\\{2}Application\\{2}msedge\.exe/);
  assert.match(harness, /BraveSoftware\\{2}Brave-Browser\\{2}Application\\{2}brave\.exe/);
  assert.match(harness, /async function stopBrowser/);
  assert.match(harness, /cleanup:\s*\{\s*browserStopped:\s*false,\s*profileRemoved:\s*false\s*\}/);
  assert.match(harness, /evidence\.cleanup\.browserStopped\s*=\s*stopped\.stopped/);
  assert.doesNotMatch(harness, /cleanup\.edgeStopped/);
});

test('supports requested themes and seeds the fixture setting', () => {
  const functionSource = harness.match(/function parseArguments\(argv\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, 'missing parseArguments implementation');
  const parseArguments = Function('resolve', `return (${functionSource})`)(resolve) as (
    argv: string[],
  ) => { theme: 'light' | 'dark' | 'auto' };

  assert.equal(parseArguments([]).theme, 'light');
  assert.equal(parseArguments(['--theme', 'dark']).theme, 'dark');
  assert.equal(parseArguments(['--theme=auto']).theme, 'auto');
  assert.throws(() => parseArguments(['--theme', 'dim']), /--theme must be light, dark, or auto/);
  assert.throws(() => parseArguments(['--theme', 'light', '--theme=dark']), /--theme may only be provided once/);
  assert.match(harness, /fixture\.settings\.theme\s*=\s*theme/);
  assert.match(harness, /requestedTheme:\s*theme/);
});

test('checks open select surfaces against the effective light or media theme token', () => {
  assert.match(harness, /\? '--media-surface' : '--surface'/);
  assert.match(harness, /pickerUsesExpectedSurface/);
  assert.doesNotMatch(harness, /pickerUsesDarkSurface/);
  assert.match(harness, /select\.getClientRects\(\)\.length > 0/);
  assert.match(harness, /rendered select #/);
});

test('checks DOM theme state and keeps media overlay text light', () => {
  assert.match(harness, /function inspectThemeState/);
  assert.match(harness, /document\.documentElement\.dataset\.theme/);
  assert.match(harness, /getComputedStyle\(document\.documentElement\)\.colorScheme/);
  assert.match(harness, /overlayTextLight/);
  assert.match(harness, /preview-play/);
  assert.match(harness, /card-title/);
});

test('exercises manual and automatic theme precedence before restoring the requested theme', () => {
  assert.match(harness, /async function exerciseThemeTransitions/);
  assert.match(harness, /facebook_theme_/);
  assert.match(harness, /manualLightWins/);
  assert.match(harness, /manualDarkWins/);
  assert.match(harness, /autoFollowsFacebookSignal/);
  assert.match(harness, /autoFallbackValid/);
  assert.match(harness, /requestedThemeRestored/);
  assert.match(
    harness,
    /exerciseThemeTransitions\(\s*page,\s*facebookPage,\s*fixture,\s*theme,\s*evidence\.seed\.tabId,\s*\)/,
  );
  assert.ok(
    harness.indexOf('evidence.themeTransitions = await exerciseThemeTransitions(') <
      harness.indexOf("for (const surface of ['now', 'library', 'saved', 'settings'])"),
    'requested theme must be restored before screenshots',
  );
});

test('drives automatic theme through a network-free Facebook content-script pipeline', () => {
  assert.match(harness, /https:\/\/www\.facebook\.com\/facescrap-theme-qa/);
  assert.match(harness, /async function openSyntheticFacebookPage/);
  assert.match(harness, /Fetch\.enable/);
  assert.match(harness, /resourceType:\s*'Document'/);
  assert.match(harness, /Fetch\.fulfillRequest/);
  assert.match(harness, /<main/);
  assert.match(harness, /async function paintSyntheticFacebookTheme/);
  assert.match(harness, /document\.documentElement\.style\.backgroundColor/);
  assert.match(harness, /async function waitForFacebookThemeSignal/);
  assert.match(harness, /chrome\.storage\.session\.get\(key\)/);
  assert.match(harness, /contentToWorkerToSession/);
});

test('proves content-script recovery after a real MV3 runtime reload', () => {
  const start = harness.indexOf('async function verifyRuntimeReloadRecovery');
  const end = harness.indexOf('\nasync function paintSyntheticFacebookTheme', start);
  assert.ok(start >= 0 && end > start, 'missing runtime reload recovery QA');
  const reloadQa = harness.slice(start, end);

  assert.match(reloadQa, /reloadSyntheticFacebookDocument/);
  assert.match(reloadQa, /Target\.activateTarget/);
  assert.match(reloadQa, /waitForLiveExtensionContentScriptContext/);
  assert.match(reloadQa, /const beforeContext/);
  assert.match(reloadQa, /registeredBeforeContextIds/);
  assert.match(reloadQa, /chrome\.runtime\.reload\(\)/);
  assert.match(reloadQa, /invokedFrom:\s*'service-worker'/);
  assert.match(reloadQa, /waitForReloadedServiceWorker/);
  assert.match(reloadQa, /__facescrapQaReloadMarker/);
  assert.match(reloadQa, /worker\.close\(\)/);
  assert.match(reloadQa, /targetReused/);
  assert.match(reloadQa, /registeredBeforeContextIds/);
  assert.match(reloadQa, /const afterContext/);
  assert.match(reloadQa, /captureHighImageThroughSyntheticDom/);
  assert.match(reloadQa, /afterContext\.id/);
  assert.match(reloadQa, /_qa_runtime_reload=1/);
  assert.match(reloadQa, /MEDIA_FOUND/);
  assert.match(harness, /function runtimeReloadStorageExpression[\s\S]*?chrome\.storage\.session\.get/);
  assert.match(reloadQa, /after\.storage\.matchingCount === 1/);
  assert.match(reloadQa, /after\.storage\.mediaCount > before\.storage\.mediaCount/);
  assert.match(reloadQa, /newServiceWorker/);
  assert.match(reloadQa, /newIsolatedContext/);
  assert.match(reloadQa, /capturedFlow/);
  assert.match(reloadQa, /status:\s*Object\.values\(checks\)\.every\(Boolean\) \? 'passed' : 'failed'/);
  assert.match(harness, /runtimeReloadRecovery:\s*null/);
  assert.match(harness, /evidence\.runtimeReloadRecovery = runtimeReloadRecovery\.evidence/);
  assert.match(harness, /if \(!evidence\.runtimeReloadRecovery\.passed\)/);
  assert.match(harness, /if \(browserName === 'edge'\)/);
  assert.match(harness, /status:\s*'skipped'/);
  assert.match(harness, /Brave headless does not restart/);

  const phaseCall = harness.indexOf('const runtimeReloadRecovery = await verifyRuntimeReloadRecovery');
  const lastCapture = harness.indexOf('await captureComparisons');
  const errorGate = harness.indexOf('if (evidence.errors.length > 0)', phaseCall);
  assert.ok(phaseCall > lastCapture, 'runtime reload QA must run after every visual/reference capture');
  assert.ok(errorGate > phaseCall, 'runtime reload QA must finish before the final runtime error gate');
});

test('initializes the simulated side panel against the already-active Facebook tab', () => {
  const syntheticPage = harness.indexOf('const syntheticFacebook = await openSyntheticFacebookPage');
  const sidepanelTarget = harness.indexOf("url: evidence.extension.sidepanelUrl");
  assert.ok(syntheticPage >= 0 && sidepanelTarget > syntheticPage);
  assert.match(
    harness.slice(syntheticPage, sidepanelTarget + 200),
    /Target\.createTarget[\s\S]*?url:\s*evidence\.extension\.sidepanelUrl[\s\S]*?background:\s*true/,
  );
  assert.match(harness, /async function alignPanelToFacebook/);
  assert.match(harness, /dataset\.trackedTab/);
  const initializationFlow = [
    'const initialSeed = await seedStorage',
    'const panelTracking = await alignPanelToFacebook',
    'const navigationBarrier = await waitForFacebookThemeSignal',
    'const stableSeed = await seedStableStorage',
    'evidence.seed = { ...stableSeed, panelTracking, navigationBarrier }',
    'evidence.themeTransitions = await exerciseThemeTransitions',
  ];
  let previousStep = -1;
  for (const step of initializationFlow) {
    const position = harness.indexOf(step);
    assert.ok(position > previousStep, `missing or out-of-order side-panel initialization step: ${step}`);
    previousStep = position;
  }
  assert.match(harness, /navigationBarrier/);
  assert.match(harness, /async function seedStableStorage/);
  assert.match(harness, /stableSamples/);
  assert.match(harness, /renderSurfaces\s*=\s*false/);
  assert.match(harness, /if \(renderSurfaces\)/);
  assert.match(
    harness,
    /waitForFacebookThemeSignal[\s\S]*?stableSeed = await seedStableStorage[\s\S]*?exerciseThemeTransitions/,
  );
  assert.match(
    harness,
    /evidence\.themeTransitions = await exerciseThemeTransitions[\s\S]*?quiesceSyntheticFacebookPage[\s\S]*?waitForTabCaptureClear[\s\S]*?postThemeStability[\s\S]*?Target\.activateTarget/,
  );
  assert.match(harness, /seedStableStorage\(page,\s*fixture,\s*language,\s*theme,\s*evidence\.seed\.tabId,\s*true\)/);
  assert.match(harness, /Page\.navigate[\s\S]*?about:blank/);
});

test('does not wait on animation frames in the synthetic Facebook tab', () => {
  const start = harness.indexOf('async function paintSyntheticFacebookTheme');
  const end = harness.indexOf('\nasync function waitForFacebookThemeSignal', start);
  assert.ok(start >= 0 && end > start, 'missing paintSyntheticFacebookTheme implementation');
  assert.doesNotMatch(
    harness.slice(start, end),
    /requestAnimationFrame/,
    'background Facebook tabs throttle animation frames and would stall CDP evaluation',
  );
});

test('keeps Facebook active for theme detection without waiting on a background panel frame', () => {
  const start = harness.indexOf('async function waitForTheme');
  const end = harness.indexOf('\nasync function setRequestedTheme', start);
  assert.ok(start >= 0 && end > start, 'missing waitForTheme implementation');
  assert.doesNotMatch(
    harness.slice(start, end),
    /requestAnimationFrame/,
    'the synthetic Facebook tab is active while automatic-theme transitions are exercised',
  );
  const transitionStart = harness.indexOf('async function exerciseThemeTransitions');
  const transitionEnd = harness.indexOf('\nasync function exerciseResponsiveWidths', transitionStart);
  assert.ok(transitionStart >= 0 && transitionEnd > transitionStart, 'missing exerciseThemeTransitions implementation');
  assert.doesNotMatch(
    harness.slice(transitionStart, transitionEnd),
    /activateSurface/,
    'theme precedence does not depend on a live media preview',
  );
  assert.match(harness, /async function activateSurface\(page,\s*surface,\s*settleFrames\s*=\s*true\)/);
  assert.match(harness, /if \(settleFrames\)[\s\S]*?requestAnimationFrame/);
  assert.match(
    harness,
    /evidence\.themeTransitions = await exerciseThemeTransitions[\s\S]*?Target\.activateTarget[\s\S]*?evidence\.responsive =/,
  );
});

test('checks responsive layout at 300, 340, and 500 pixels before restoring 340', () => {
  assert.match(harness, /RESPONSIVE_WIDTHS\s*=\s*Object\.freeze\(\[300,\s*340,\s*500\]\)/);
  assert.match(harness, /async function exerciseResponsiveWidths/);
  assert.match(harness, /noHorizontalOverflow/);
  assert.match(harness, /navItemsComplete/);
  assert.match(harness, /requestedWidth:\s*width/);
  assert.match(harness, /restoredWidth:\s*VIEWPORT\.width/);
  assert.match(harness, /exerciseResponsiveWidths\(page,\s*language\)/);
  assert.ok(
    harness.indexOf('exerciseResponsiveWidths(page, language)') <
      harness.indexOf("for (const surface of ['now', 'library', 'saved', 'settings'])"),
    '340px viewport must be restored before screenshots',
  );
});

test('checks localized Theme and Max saved items controls in Settings at every responsive width', () => {
  const responsiveStart = harness.indexOf('async function captureResponsiveSettingsControl');
  const responsiveEnd = harness.indexOf('\nasync function inspectReferenceRoots', responsiveStart);
  assert.ok(responsiveStart >= 0 && responsiveEnd > responsiveStart, 'missing responsive QA implementation');
  const responsive = harness.slice(responsiveStart, responsiveEnd);

  assert.match(responsive, /async function exerciseResponsiveWidths/);
  assert.match(responsive, /await activateSurface\(page,\s*'settings'\)/);
  for (const selector of ['#label-set-theme', '#set-theme', '#hint-set-theme', '#label-set-maxitems', '#set-maxitems', '#hint-set-maxitems']) {
    assert.match(responsive, new RegExp(selector));
  }
  for (const localizedText of [
    'Theme',
    'Tema',
    'Max saved items',
    'Máx. de items guardados',
    'Auto',
    'Automático',
    'Light',
    'Claro',
    'Dark',
    'Oscuro',
    'Unlimited',
    'Sin límite',
  ]) {
    assert.match(responsive, new RegExp(localizedText));
  }
  assert.match(responsive, /settingsLabelsLocalized/);
  assert.match(responsive, /settingsControlsVisible/);
  assert.match(responsive, /settingsControlsWithinViewport/);
  assert.match(responsive, /settingsControlsLabeled/);
  assert.match(responsive, /settingsControlsUsable/);
  assert.match(responsive, /settings-theme-\$\{width\}\.png/);
  assert.match(responsive, /settings-maxitems-\$\{width\}\.png/);
  assert.match(responsive, /Page\.captureScreenshot/);
  assert.match(responsive, /pngDimensions/);
});

test('keeps README screenshots localized to their document language', () => {
  for (const path of ['docs/now-en.png', 'docs/library-en.png', 'docs/saved-en.png', 'docs/settings-en.png']) {
    assert.match(readmeEn, new RegExp(path.replaceAll('.', '\\.')));
    assert.doesNotMatch(readmeEs, new RegExp(path.replaceAll('.', '\\.')));
    assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);
  }
  for (const path of ['docs/now-es.png', 'docs/library-es.png', 'docs/saved-es.png', 'docs/settings-es.png']) {
    assert.match(readmeEs, new RegExp(path.replaceAll('.', '\\.')));
    assert.doesNotMatch(readmeEn, new RegExp(path.replaceAll('.', '\\.')));
    assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);
  }
});
