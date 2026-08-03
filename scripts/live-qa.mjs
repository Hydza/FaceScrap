#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, detectBrowserPlatform, install } from '@puppeteer/browsers';
import { attachBrowserTelemetry, attachTarget, collectStoredDiagnostics } from './live-qa-cdp.mjs';
import { parseArguments } from './live-qa-core.mjs';
import { createSessionRecorder } from './live-qa-recorder.mjs';
import {
  BROWSER_EXECUTABLES,
  CdpSocket,
  DIST,
  delay,
  pollJsonList,
  requestJson,
  runIfMain,
  waitForDevToolsPort,
  watchChildExit,
} from './sidepanel-visual-qa.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_ROOT = join(ROOT, 'artifacts', 'live-qa');
const CFT_VERSION_FILE = join(ROOT, '.cft-version');
const CFT_CACHE = join(homedir(), '.cache', 'facescrap', 'chrome-for-testing');
const PROFILE_PREFIX = 'facescrap-live-qa-';

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function resolveBrowserExecutable(browserName) {
  if (browserName !== 'cft') return BROWSER_EXECUTABLES[browserName];
  const version = (await readFile(CFT_VERSION_FILE, 'utf8')).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Chrome for Testing version: ${JSON.stringify(version)}`);
  }
  const override = process.env.FACESCRAP_CFT_EXECUTABLE?.trim();
  if (override) return resolve(override);
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error(`Chrome for Testing is unavailable for ${process.platform}/${process.arch}`);
  const installed = await install({
    browser: Browser.CHROME,
    buildId: version,
    cacheDir: CFT_CACHE,
    platform,
    downloadProgressCallback: 'default',
  });
  return installed.executablePath;
}

function assertOwnedProfile(profileDir) {
  const prefix = join(tmpdir(), PROFILE_PREFIX);
  if (!profileDir.startsWith(prefix) || profileDir === tmpdir() || profileDir.endsWith(sep)) {
    throw new Error(`Refusing to remove an unowned browser profile: ${profileDir}`);
  }
}

async function stopBrowser(browser, child, browserExit) {
  if (child?.exitCode == null && browser && !browser.closed) {
    await Promise.race([browser.command('Browser.close').catch(() => undefined), delay(2_000)]);
  }
  let exit = await Promise.race([browserExit, delay(4_000).then(() => null)]);
  if (!exit && child?.exitCode == null) {
    child.kill('SIGTERM');
    exit = await Promise.race([browserExit, delay(3_000).then(() => null)]);
  }
  return exit;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const startedAt = new Date();
  const sessionId = startedAt.toISOString().replace(/[:.]/g, '-');
  const sessionDir = join(LIVE_ROOT, sessionId);
  const eventsPath = join(sessionDir, 'events.jsonl');
  const summaryPath = join(sessionDir, 'session.json');
  await mkdir(sessionDir, { recursive: true });
  const recorder = createSessionRecorder(eventsPath);
  const { record } = recorder;
  const clients = new Map();
  const diagnosticEvents = new Set();
  let diagnosticClient;
  let profileDir;
  let child;
  let browser;
  let browserExit = Promise.resolve(null);
  let exitResult;
  let extensionId;
  let runError;
  let stopRequested = false;
  let scanRequested = true;

  const summary = {
    schemaVersion: 1,
    status: 'starting',
    startedAt: startedAt.toISOString(),
    endedAt: null,
    browser: options.browserName,
    startUrl: 'https://www.facebook.com/…',
    extensionId: null,
    eventsPath,
    profilePolicy: 'temporary and removed on clean exit',
    counts: recorder.counts,
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const requestStop = () => {
    stopRequested = true;
    if (browser && !browser.closed) void browser.command('Browser.close').catch(() => undefined);
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  try {
    const browserExecutable = await resolveBrowserExecutable(options.browserName);
    await access(browserExecutable);
    await access(join(DIST, 'manifest.json'));
    profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
    assertOwnedProfile(profileDir);
    const args = [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--window-size=1440,1000',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      options.startUrl,
    ];
    child = spawn(browserExecutable, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    browserExit = watchChildExit(child);
    void browserExit.then((result) => {
      exitResult = result;
    });

    const port = await waitForDevToolsPort(profileDir, browserExit);
    const version = await requestJson(port, '/json/version');
    browser = await CdpSocket.connect(version.webSocketDebuggerUrl);
    await attachBrowserTelemetry({ browser, record });
    browser.on('Target.targetCreated', () => {
      scanRequested = true;
    });
    browser.on('Target.targetInfoChanged', () => {
      scanRequested = true;
    });
    await browser.command('Target.setDiscoverTargets', { discover: true });

    const discovery = await pollJsonList(
      port,
      (target) =>
        target.type === 'service_worker' &&
        /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js(?:[?#].*)?$/.test(target.url ?? ''),
      'the FaceScrap MV3 service worker',
    );
    extensionId = new URL(discovery.found.url).hostname;
    summary.status = 'running';
    summary.extensionId = '<redacted>';
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    record({
      level: 'info',
      kind: 'session-ready',
      context: 'harness',
      text: 'visible Facebook QA session is ready',
    });
    process.stdout.write(`FaceScrap live QA ready. Evidence: ${eventsPath}\n`);
    process.stdout.write(
      'Use the visible browser, open FaceScrap from the toolbar, and close the browser when finished.\n',
    );

    let lastDiagnosticRead = 0;
    while (!stopRequested && exitResult == null) {
      if (scanRequested) {
        scanRequested = false;
        const targets = await requestJson(port, '/json/list');
        for (const target of targets) {
          try {
            await attachTarget({
              target,
              extensionId,
              clients,
              connect: (webSocketUrl) => CdpSocket.connect(webSocketUrl),
              record,
              setDiagnosticClient: (client) => {
                diagnosticClient = client;
              },
            });
          } catch (error) {
            record({
              level: 'warn',
              kind: 'target-attach-failed',
              context: 'harness',
              text: errorText(error),
              sourceUrl: target.url,
            });
          }
        }
      }
      if (Date.now() - lastDiagnosticRead >= 2_000) {
        const readable = await collectStoredDiagnostics({
          client: diagnosticClient,
          seen: diagnosticEvents,
          record,
        });
        if (!readable) diagnosticClient = undefined;
        lastDiagnosticRead = Date.now();
      }
      await delay(250);
      scanRequested = true;
    }
  } catch (error) {
    runError = error;
    record({
      level: 'error',
      kind: 'harness-failure',
      context: 'harness',
      text: errorText(error),
    });
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    for (const client of clients.values()) client.close();
    await stopBrowser(browser, child, browserExit).catch(() => undefined);
    browser?.close();
    if (profileDir) {
      assertOwnedProfile(profileDir);
      await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    }
    record({
      level: runError ? 'error' : 'info',
      kind: 'session-ended',
      context: 'harness',
      text: runError ? 'live QA stopped after a harness failure' : 'live QA browser closed',
      data: exitResult ?? undefined,
    });
    summary.status = runError ? 'failed' : 'completed';
    summary.endedAt = new Date().toISOString();
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await recorder.close();
  }

  if (runError) throw runError;
}

runIfMain(import.meta.url, main);
