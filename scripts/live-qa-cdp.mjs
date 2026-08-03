import {
  classifyTarget,
  redactUrl,
  sanitizeData,
  sanitizeText,
  shouldRecordRuntimeEvent,
} from './live-qa-core.mjs';

function consoleLevel(type) {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warn';
  return 'info';
}

function remoteValue(argument) {
  if (Object.prototype.hasOwnProperty.call(argument, 'value')) {
    const value = argument.value;
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : argument.description ?? argument.type;
  }
  return argument.description ?? argument.type;
}

function stackUrls(stackTrace) {
  return (stackTrace?.callFrames ?? [])
    .map((frame) => frame.url)
    .filter((url) => typeof url === 'string' && url !== '');
}

export async function attachBrowserTelemetry({ browser, record }) {
  const downloads = new Map();
  let nextDownload = 1;
  browser.on('Browser.downloadWillBegin', (event) => {
    const correlation = `download-${nextDownload++}`;
    downloads.set(event.guid, correlation);
    record({
      level: 'info',
      kind: 'download-started',
      context: 'browser',
      text: 'browser accepted a download',
      correlation,
      sourceUrl: event.url,
    });
  });
  browser.on('Browser.downloadProgress', (event) => {
    if (event.state === 'inProgress') return;
    const correlation = downloads.get(event.guid) ?? 'download-unknown';
    downloads.delete(event.guid);
    record({
      level: event.state === 'completed' ? 'info' : event.state === 'canceled' ? 'warn' : 'error',
      kind: 'download-finished',
      context: 'browser',
      text: `download ${event.state}`,
      correlation,
      data: {
        receivedBytes: event.receivedBytes,
        totalBytes: event.totalBytes,
      },
    });
  });
  try {
    await browser.command('Browser.setDownloadBehavior', {
      behavior: 'default',
      eventsEnabled: true,
    });
  } catch (error) {
    record({
      level: 'warn',
      kind: 'telemetry-gap',
      context: 'browser',
      text: `download events unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export async function attachTarget({
  target,
  extensionId,
  clients,
  connect,
  record,
  setDiagnosticClient,
}) {
  const context = classifyTarget(target, extensionId);
  if (context == null || !target.webSocketDebuggerUrl || clients.has(target.id)) return;
  const client = await connect(target.webSocketDebuggerUrl);
  clients.set(target.id, client);
  const requests = new Map();

  const runtimeRecord = (event) => {
    if (!shouldRecordRuntimeEvent(event, extensionId)) return;
    record(event);
  };

  client.on('Runtime.consoleAPICalled', (params) => {
    const event = {
      level: consoleLevel(params.type),
      kind: 'console',
      context,
      text: (params.args ?? []).map(remoteValue).join(' '),
      urls: stackUrls(params.stackTrace),
    };
    runtimeRecord(event);
  });
  client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    const details = exceptionDetails ?? {};
    const urls = [details.url, ...stackUrls(details.stackTrace)].filter(
      (url) => typeof url === 'string' && url !== '',
    );
    runtimeRecord({
      level: 'error',
      kind: 'exception',
      context,
      text: details.exception?.description ?? details.text ?? 'unknown runtime exception',
      urls,
      sourceUrl: urls[0],
      data: {
        lineNumber: details.lineNumber,
        columnNumber: details.columnNumber,
      },
    });
  });
  client.on('Log.entryAdded', ({ entry }) => {
    if (entry == null) return;
    runtimeRecord({
      level: entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warn' : 'info',
      kind: 'log',
      context,
      text: entry.text,
      urls: entry.url ? [entry.url] : [],
      sourceUrl: entry.url,
    });
  });
  client.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (requestId && request?.url) requests.set(requestId, request.url);
  });
  client.on('Network.loadingFinished', ({ requestId }) => {
    requests.delete(requestId);
  });
  client.on('Network.loadingFailed', (event) => {
    const sourceUrl = requests.get(event.requestId);
    requests.delete(event.requestId);
    record({
      level: event.canceled ? 'warn' : 'error',
      kind: 'network-failure',
      context,
      text: event.errorText ?? 'network request failed',
      sourceUrl,
      data: {
        blockedReason: event.blockedReason,
        canceled: event.canceled === true,
      },
    });
  });
  client.on('protocolError', (error) => {
    record({
      level: 'error',
      kind: 'protocol-error',
      context,
      text: error instanceof Error ? error.message : String(error),
    });
  });
  client.on('disconnect', () => {
    if (clients.get(target.id) === client) clients.delete(target.id);
    record({
      level: 'info',
      kind: 'target-detached',
      context,
      text: 'runtime target stopped',
      sourceUrl: target.url,
    });
  });

  await client.command('Runtime.enable');
  await client.command('Log.enable');
  if (context !== 'facebook') await client.command('Network.enable');
  if (context === 'service-worker' || context === 'sidepanel' || context === 'extension-page') {
    setDiagnosticClient(client);
  }
  record({
    level: 'info',
    kind: 'target-attached',
    context,
    text: 'runtime target observed',
    sourceUrl: target.url,
  });
}

export async function collectStoredDiagnostics({ client, seen, record }) {
  if (client == null || client.closed) return false;
  let response;
  try {
    response = await client.command('Runtime.evaluate', {
      expression: `chrome.storage.local.get('diag_log')`,
      awaitPromise: true,
      returnByValue: true,
    });
  } catch {
    return false;
  }
  const events = response.result?.value?.diag_log;
  if (!Array.isArray(events)) return true;
  for (const event of events) {
    if (event == null || typeof event !== 'object') continue;
    const key = JSON.stringify([event.at, event.ctx, event.ev, event.lvl, event.data]);
    if (seen.has(key)) continue;
    seen.add(key);
    record({
      level: event.lvl === 'error' ? 'error' : event.lvl === 'warn' ? 'warn' : 'info',
      kind: 'diagnostic',
      context: typeof event.ctx === 'string' ? event.ctx : 'extension',
      text: typeof event.ev === 'string' ? event.ev : 'unknown diagnostic event',
      data: sanitizeData(event.data),
    });
  }
  return true;
}
