import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import {
  canonicalizeHistoricalMediaId,
  makeItem,
  mediaId,
} from '../src/shared/media';

const ROOT = process.cwd();

test('re-canonicalizes the intermediate full-query safe-image id', () => {
  const url =
    'https://external.xx.fbcdn.net/safe_image.php?' +
    'url=https%3A%2F%2Fexample.com%2Fsame.jpg&oh=rotating-signature&oe=1';
  const intermediate =
    'asset:/safe_image.php?oe=1&oh=rotating-signature&' +
    'url=https%3A%2F%2Fexample.com%2Fsame.jpg';

  assert.equal(canonicalizeHistoricalMediaId(intermediate), mediaId(url));
});

test('an ambiguous path-only generic id never selects two different photos', async () => {
  await resetChromeStorage();
  const { setPlaying } = await import('../src/shared/storage');
  const { purgeTabBindings, selectPlaying } = await import('../src/shared/now-playing');
  const tabId = 99_202;
  const now = Date.now();
  const first = makeItem(
    'https://external.xx.fbcdn.net/safe_image.php?url=https%3A%2F%2Fexample.com%2Ffirst.jpg&oh=a',
    'image',
    'story',
    'dom',
    now,
  );
  const second = makeItem(
    'https://external.xx.fbcdn.net/safe_image.php?url=https%3A%2F%2Fexample.com%2Fsecond.jpg&oh=b',
    'image',
    'story',
    'dom',
    now + 1,
  );

  try {
    await setPlaying(tabId, { ids: ['asset:/safe_image.php'], hasVideo: false, at: now }, now);
    assert.deepEqual(await selectPlaying(tabId, [first, second]), []);
  } finally {
    purgeTabBindings(tabId);
    await resetChromeStorage();
  }
});

test('the packaged update-recovery path pings before scripting injection', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
    permissions?: string[];
  };
  const worker = readFileSync(join(ROOT, 'src', 'background', 'service-worker.ts'), 'utf8');
  const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');
  const recovery = readFileSync(join(ROOT, 'src', 'content', 'content-recovery.ts'), 'utf8');
  const build = readFileSync(join(ROOT, 'scripts', 'build.mjs'), 'utf8');
  const instanceClaim = content.indexOf(
    'contentBootstrap.__facescrapContentInstance = contentInstance',
  );
  const pingListenerRegistration = content.indexOf(
    'runtimeForInstance?.onMessage.addListener(handleContentRuntimeMessage)',
  );

  assert.ok(manifest.permissions?.includes('scripting'));
  assert.match(worker, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(worker, /chrome\.tabs\.sendMessage/);
  assert.match(worker, /chrome\.scripting\.executeScript/);
  assert.match(worker, /details\.reason === 'update' \? 'content-recovery\.js' : 'content\.js'/);
  assert.match(content, /FACESCRAP_CONTENT_PING/);
  assert.match(content, /__facescrapContentInstance/);
  assert.match(content, /__facescrapForceContentRecovery/);
  assert.match(content, /shouldStartContentInstance\(\s*existingContentInstance,\s*forceContentRecovery/);
  assert.match(content, /contentInstance\.active && Boolean\(runtimeForInstance\?\.id\)/);
  assert.match(content, /if \(startContentInstance\)/);
  assert.match(content, /removeListener\(handleContentRuntimeMessage\)/);
  assert.ok(instanceClaim >= 0 && instanceClaim < pingListenerRegistration);
  // The recovery skip flag still gates page-hook injection (no second fetch/XHR
  // wrap after an update), now via the instance-independent ensurePageHook path.
  assert.match(content, /ensurePageHook\(\);/);
  assert.match(content, /shouldInjectPageHook\(skipPageHookInjection,\s*contentBootstrap\.__facescrapHookInjected/);
  assert.match(recovery, /__facescrapSkipPageHook\s*=\s*true/);
  assert.match(recovery, /__facescrapForceContentRecovery\s*=\s*true/);
  assert.match(build, /'content-recovery'/);
});

test('a transient tabs.get failure does not freeze the panel on the previous tab', () => {
  const panel = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

  assert.doesNotMatch(panel, /if \(activatedTab == null\) return/);
  assert.match(panel, /setTrackedTab\(info\.tabId\)/);
});
