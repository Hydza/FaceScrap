import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface TargetDescriptor {
  readonly type?: string;
  readonly url?: string;
}

interface RuntimeEvent {
  readonly context: string;
  readonly kind: 'console' | 'exception' | 'log';
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
  readonly urls: readonly string[];
}

interface LiveQaCore {
  parseArguments(argv: readonly string[]): {
    readonly browserName: string;
    readonly startUrl: string;
  };
  classifyTarget(target: TargetDescriptor, extensionId: string): string | undefined;
  shouldRecordRuntimeEvent(event: RuntimeEvent, extensionId: string): boolean;
  redactUrl(raw: string): string;
  sanitizeText(raw: string): string;
}

async function loadCore(): Promise<LiveQaCore> {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'live-qa-core.mjs')).href;
  return (await import(moduleUrl)) as LiveQaCore;
}

test('live QA defaults to an isolated Chrome for Testing Facebook session', async () => {
  const core = await loadCore();

  const options = core.parseArguments([]);

  assert.deepEqual(options, {
    browserName: 'cft',
    startUrl: 'https://www.facebook.com/',
  });
});

test('live QA accepts supported browser and Facebook URL overrides', async () => {
  const core = await loadCore();

  const options = core.parseArguments([
    '--browser=edge',
    '--url=https://www.facebook.com/reel/123',
  ]);

  assert.deepEqual(options, {
    browserName: 'edge',
    startUrl: 'https://www.facebook.com/reel/123',
  });
});

test('live QA rejects branded Chrome and non-Facebook start URLs', async () => {
  const core = await loadCore();

  assert.throws(() => core.parseArguments(['--browser=chrome']), /Chrome for Testing/);
  assert.throws(() => core.parseArguments(['--url=https://example.com/']), /facebook\.com/);
});

test('live QA classifies every extension surface and Facebook pages', async () => {
  const core = await loadCore();
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

  assert.equal(
    core.classifyTarget(
      {
        type: 'service_worker',
        url: `chrome-extension://${extensionId}/service-worker.js`,
      },
      extensionId,
    ),
    'service-worker',
  );
  assert.equal(
    core.classifyTarget(
      {
        type: 'page',
        url: `chrome-extension://${extensionId}/offscreen/offscreen.html`,
      },
      extensionId,
    ),
    'offscreen',
  );
  assert.equal(
    core.classifyTarget(
      {
        type: 'other',
        url: `chrome-extension://${extensionId}/sidepanel/sidepanel.html`,
      },
      extensionId,
    ),
    'sidepanel',
  );
  assert.equal(
    core.classifyTarget({ type: 'page', url: 'https://www.facebook.com/' }, extensionId),
    'facebook',
  );
  assert.equal(
    core.classifyTarget({ type: 'page', url: 'https://example.com/' }, extensionId),
    undefined,
  );
});

test('live QA ignores Facebook noise but keeps extension-origin runtime failures', async () => {
  const core = await loadCore();
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

  assert.equal(
    core.shouldRecordRuntimeEvent(
      {
        context: 'facebook',
        kind: 'console',
        level: 'warn',
        text: 'A generic page warning',
        urls: ['https://static.xx.fbcdn.net/client.js'],
      },
      extensionId,
    ),
    false,
  );
  assert.equal(
    core.shouldRecordRuntimeEvent(
      {
        context: 'facebook',
        kind: 'exception',
        level: 'error',
        text: 'TypeError: capture failed',
        urls: [`chrome-extension://${extensionId}/content.js`],
      },
      extensionId,
    ),
    true,
  );
  assert.equal(
    core.shouldRecordRuntimeEvent(
      {
        context: 'facebook',
        kind: 'console',
        level: 'error',
        text: 'A page error without a source URL',
        urls: [],
      },
      extensionId,
    ),
    true,
  );
  assert.equal(
    core.shouldRecordRuntimeEvent(
      {
        context: 'facebook',
        kind: 'console',
        level: 'info',
        text: '[FaceScrap] capture failed',
        urls: [],
      },
      extensionId,
    ),
    true,
  );
});

test('live QA redacts signed URLs and extension identifiers before persistence', async () => {
  const core = await loadCore();

  const source = core.redactUrl(
    'https://video.xx.fbcdn.net/v/t42.1790-2/private.mp4?oh=secret&oe=timestamp',
  );
  const message = core.sanitizeText(
    'Failed https://www.facebook.com/reel/123456789?tracking=secret',
  );
  const extension = core.redactUrl(
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/service-worker.js',
  );

  assert.equal(source, 'https://video.xx.fbcdn.net/…');
  assert.equal(message, 'Failed https://www.facebook.com/…');
  assert.equal(extension, 'chrome-extension://<extension>/service-worker.js');
});
