#!/usr/bin/env node

// Real visual smoke test for FaceScrap's built side panel.
//
// This intentionally uses only Node built-ins. It launches Edge or Brave with a fresh
// profile, discovers the unpacked MV3 extension through /json/list, drives the
// side-panel document over CDP, and writes screenshots plus machine-readable
// evidence to dist/qa/. Run `npm run build` before invoking this script.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const QA_DIR = join(DIST, 'qa');
const MANIFEST = join(DIST, 'manifest.json');
const BROWSER_EXECUTABLES = Object.freeze({
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  brave: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
});
const PROFILE_PREFIX = 'facescrap-sidepanel-qa-';
const VIEWPORT = Object.freeze({ width: 340, height: 780, deviceScaleFactor: 1 });
const RESPONSIVE_WIDTHS = Object.freeze([300, 340, 500]);
const REFERENCE_VIEWPORT = Object.freeze({ width: 1_200, height: 900, deviceScaleFactor: 1 });
const COMPARISON_VIEWPORT = Object.freeze({ width: 712, height: 820, deviceScaleFactor: 1 });
const REFERENCE_SURFACES = Object.freeze(['now', 'library', 'settings']);
const STARTUP_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 12_000;
const FOCUSED_CLOSED_TIMEOUT_MS = 2_000;
const FORCED_FALLBACK_TIMEOUT_MS = 2_000;
const MAX_BROWSER_LOG_CHARS = 64 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function stackText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  return next.length <= MAX_BROWSER_LOG_CHARS ? next : next.slice(next.length - MAX_BROWSER_LOG_CHARS);
}

function parseArguments(argv) {
  let referencePath;
  let language = 'es';
  let browserName = 'edge';
  let theme = 'light';
  let languageProvided = false;
  let browserProvided = false;
  let themeProvided = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--reference') {
      if (referencePath !== undefined) throw new Error('--reference may only be provided once');
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--reference requires a local HTML file path');
      referencePath = resolve(value);
      continue;
    }
    if (argument.startsWith('--reference=')) {
      if (referencePath !== undefined) throw new Error('--reference may only be provided once');
      const value = argument.slice('--reference='.length);
      if (!value) throw new Error('--reference requires a local HTML file path');
      referencePath = resolve(value);
      continue;
    }
    if (argument === '--lang') {
      if (languageProvided) throw new Error('--lang may only be provided once');
      const value = argv[++index];
      if (value !== 'en' && value !== 'es') throw new Error('--lang must be en or es');
      language = value;
      languageProvided = true;
      continue;
    }
    if (argument.startsWith('--lang=')) {
      if (languageProvided) throw new Error('--lang may only be provided once');
      const value = argument.slice('--lang='.length);
      if (value !== 'en' && value !== 'es') throw new Error('--lang must be en or es');
      language = value;
      languageProvided = true;
      continue;
    }
    if (argument === '--browser') {
      if (browserProvided) throw new Error('--browser may only be provided once');
      const value = argv[++index];
      if (value !== 'edge' && value !== 'brave') throw new Error('--browser must be edge or brave');
      browserName = value;
      browserProvided = true;
      continue;
    }
    if (argument.startsWith('--browser=')) {
      if (browserProvided) throw new Error('--browser may only be provided once');
      const value = argument.slice('--browser='.length);
      if (value !== 'edge' && value !== 'brave') throw new Error('--browser must be edge or brave');
      browserName = value;
      browserProvided = true;
      continue;
    }
    if (argument === '--theme') {
      if (themeProvided) throw new Error('--theme may only be provided once');
      const value = argv[++index];
      if (value !== 'light' && value !== 'dark' && value !== 'auto') {
        throw new Error('--theme must be light, dark, or auto');
      }
      theme = value;
      themeProvided = true;
      continue;
    }
    if (argument.startsWith('--theme=')) {
      if (themeProvided) throw new Error('--theme may only be provided once');
      const value = argument.slice('--theme='.length);
      if (value !== 'light' && value !== 'dark' && value !== 'auto') {
        throw new Error('--theme must be light, dark, or auto');
      }
      theme = value;
      themeProvided = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { referencePath, language, browserName, theme };
}

async function assertReferenceReady(referencePath) {
  if (!referencePath) return;
  const entry = await stat(referencePath).catch((error) => {
    throw new Error(`Cannot access --reference file ${referencePath}: ${errorText(error)}`);
  });
  if (!entry.isFile()) throw new Error(`--reference must point to a file: ${referencePath}`);
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`));
}

function referenceContentType(path) {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.gif': 'image/gif',
      '.html': 'text/html; charset=utf-8',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml; charset=utf-8',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }[extension] ?? 'application/octet-stream'
  );
}

async function startReferenceServer(referencePath) {
  const root = await realpath(dirname(referencePath));
  const entry = await realpath(referencePath);
  if (!isPathInside(root, entry)) throw new Error(`Reference file escapes its containing directory: ${referencePath}`);

  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET, HEAD');
        response.end('Method not allowed');
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      } catch {
        response.statusCode = 400;
        response.end('Invalid URL');
        return;
      }
      if (pathname.includes('\0')) {
        response.statusCode = 400;
        response.end('Invalid path');
        return;
      }
      // Edge requests this implicitly even when the standalone reference does
      // not declare one. Treat it as an empty optional asset, not a QA error.
      if (pathname === '/favicon.ico') {
        response.statusCode = 204;
        response.end();
        return;
      }

      const lexicalTarget = resolve(root, `.${pathname.replaceAll('/', sep)}`);
      if (!isPathInside(root, lexicalTarget)) {
        response.statusCode = 403;
        response.end('Forbidden');
        return;
      }

      const target = await realpath(lexicalTarget).catch(() => undefined);
      if (!target || !isPathInside(root, target)) {
        response.statusCode = target ? 403 : 404;
        response.end(target ? 'Forbidden' : 'Not found');
        return;
      }
      const targetStat = await stat(target);
      if (!targetStat.isFile()) {
        response.statusCode = 404;
        response.end('Not found');
        return;
      }

      const body = request.method === 'HEAD' ? undefined : await readFile(target);
      response.statusCode = 200;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', referenceContentType(target));
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.end(body);
    })().catch((error) => {
      if (response.headersSent) response.destroy(error);
      else {
        response.statusCode = 500;
        response.end('Reference server error');
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen({ host: '127.0.0.1', port: 0 }, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Reference server did not expose a TCP port');
  }

  return {
    root,
    entry,
    url: `http://127.0.0.1:${address.port}/${encodeURIComponent(basename(entry))}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        // Do not let a browser keep-alive socket make QA cleanup wait forever.
        // Node 18.2+ exposes this method; the guard preserves Node 18.0/18.1.
        server.closeAllConnections?.();
      }),
  };
}

async function assertBuildReady(browserExecutable) {
  await access(browserExecutable);
  await access(MANIFEST);
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  if (manifest.manifest_version !== 3) throw new Error('dist/manifest.json is not Manifest V3');
  if (manifest.side_panel?.default_path !== 'sidepanel/sidepanel.html') {
    throw new Error('dist/manifest.json does not expose sidepanel/sidepanel.html');
  }
}

function requestJson(port, path, method = 'GET') {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method, timeout: 4_000 },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            rejectRequest(new Error(`${method} ${path} returned ${response.statusCode}: ${body.slice(0, 500)}`));
            return;
          }
          try {
            resolveRequest(JSON.parse(body));
          } catch (error) {
            rejectRequest(new Error(`Invalid JSON from ${method} ${path}: ${errorText(error)}`));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error(`Timed out requesting ${path}`)));
    request.on('error', rejectRequest);
    request.end();
  });
}

class CdpSocket extends EventEmitter {
  static connect(webSocketUrl, timeoutMs = ACTION_TIMEOUT_MS) {
    return new Promise((resolveConnect, rejectConnect) => {
      const url = new URL(webSocketUrl);
      if (url.protocol !== 'ws:') {
        rejectConnect(new Error(`Unsupported CDP WebSocket protocol: ${url.protocol}`));
        return;
      }

      const key = randomBytes(16).toString('base64');
      const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
      const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 80) });
      let handshake = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => fail(new Error(`Timed out connecting to ${webSocketUrl}`)), timeoutMs);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        rejectConnect(error);
      };

      const onData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end < 0) {
          if (handshake.length > 64 * 1024) fail(new Error('Oversized WebSocket handshake'));
          return;
        }

        const header = handshake.subarray(0, end).toString('latin1');
        const lines = header.split('\r\n');
        if (!/^HTTP\/1\.1 101\b/.test(lines[0] ?? '')) {
          fail(new Error(`CDP WebSocket upgrade failed: ${lines[0] ?? 'empty response'}`));
          return;
        }
        const headers = new Map(
          lines.slice(1).map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
          }),
        );
        if (headers.get('sec-websocket-accept') !== expectedAccept) {
          fail(new Error('CDP WebSocket returned an invalid Sec-WebSocket-Accept'));
          return;
        }

        settled = true;
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', fail);
        const client = new CdpSocket(socket, timeoutMs);
        const remaining = handshake.subarray(end + 4);
        if (remaining.length > 0) client.accept(remaining);
        resolveConnect(client);
      };

      socket.once('connect', () => {
        socket.write(
          [
            `GET ${url.pathname}${url.search} HTTP/1.1`,
            `Host: ${url.host}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '\r\n',
          ].join('\r\n'),
        );
      });
      socket.on('data', onData);
      socket.on('error', fail);
    });
  }

  constructor(socket, timeoutMs) {
    super();
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = 0;
    this.fragments = [];
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.on('data', (chunk) => this.accept(chunk));
    socket.on('error', (error) => this.finish(error));
    socket.on('close', () => this.finish(new Error('CDP WebSocket closed')));
  }

  command(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP is closed; cannot call ${method}`));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`CDP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand, timer });
      try {
        this.sendFrame(0x1, Buffer.from(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectCommand(error);
      }
    });
  }

  sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.closed) throw new Error('Cannot write to a closed CDP WebSocket');
    const mask = randomBytes(4);
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index++) masked[index] = payload[index] ^ mask[index % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  accept(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const largeLength = this.buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.finish(new Error('CDP WebSocket frame is too large'));
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const rawPayload = this.buffer.subarray(offset, offset + length);
      const payload = masked ? Buffer.from(rawPayload.map((byte, index) => byte ^ mask[index % 4])) : rawPayload;
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) {
        this.finish(new Error('CDP WebSocket peer closed the connection'));
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0x0a, payload);
        continue;
      }
      if (opcode === 0x0a) continue;
      if (opcode === 0x0) {
        if (this.fragmentOpcode === 0) continue;
        this.fragments.push(Buffer.from(payload));
        if (final) {
          const combined = Buffer.concat(this.fragments);
          const originalOpcode = this.fragmentOpcode;
          this.fragmentOpcode = 0;
          this.fragments = [];
          this.handleMessage(originalOpcode, combined);
        }
        continue;
      }
      if (!final) {
        this.fragmentOpcode = opcode;
        this.fragments = [Buffer.from(payload)];
        continue;
      }
      this.handleMessage(opcode, payload);
    }
  }

  handleMessage(opcode, payload) {
    if (opcode !== 0x1) return;
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      this.emit('protocolError', error);
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method} failed (${message.error.code}): ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method === 'string') this.emit(message.method, message.params ?? {});
  }

  finish(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  close() {
    if (this.closed) return;
    try {
      this.sendFrame(0x8);
    } catch {
      // The transport is already gone; socket.end below is still safe.
    }
    this.closed = true;
    this.socket.end();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP connection closed by harness'));
    }
    this.pending.clear();
  }
}

async function waitForDevToolsPort(profileDir, browserExit) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    const exit = await Promise.race([browserExit, delay(75).then(() => null)]);
    if (exit) throw new Error(`Browser exited before CDP was ready (code ${exit.code}, signal ${exit.signal})`);
    try {
      const [portLine] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      lastError = new Error(`Invalid DevToolsActivePort value: ${portLine}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Browser did not expose CDP within ${STARTUP_TIMEOUT_MS}ms (${errorText(lastError)})`);
}

async function pollJsonList(port, predicate, description, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let targets = [];
  let lastError;
  while (Date.now() < deadline) {
    try {
      targets = await requestJson(port, '/json/list');
      const found = targets.find(predicate);
      if (found) return { found, targets };
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  const suffix = lastError ? `; last request error: ${errorText(lastError)}` : '';
  const error = new Error(`Timed out waiting for ${description} in /json/list${suffix}`);
  error.targets = targets;
  throw error;
}

async function evaluate(client, expression) {
  let result;
  try {
    result = await client.command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
  } catch (error) {
    const preview = expression.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`${errorText(error)} while evaluating: ${preview}`);
  }
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`Runtime.evaluate failed: ${description}`);
  }
  return result.result?.value;
}

async function evaluateInExecutionContext(client, contextId, expression) {
  let result;
  try {
    result = await client.command('Runtime.evaluate', {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
  } catch (error) {
    const preview = expression.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`${errorText(error)} in execution context ${contextId} while evaluating: ${preview}`);
  }
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`Runtime.evaluate failed in execution context ${contextId}: ${description}`);
  }
  return result.result?.value;
}

async function waitForEvaluation(client, expression, description, timeoutMs = ACTION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(client, expression);
      if (lastValue?.ready === true || lastValue === true) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}; last value=${JSON.stringify(lastValue)}${
      lastError ? `; last error=${errorText(lastError)}` : ''
    }`,
  );
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function buildFixture(now = Date.now()) {
  const mainAsset = '990001234567890';
  const storyAsset = '990001234567891';
  const squareAsset = '990001234567892';
  const mainEfg = base64UrlJson({ xpv_asset_id: mainAsset, video_id: mainAsset, vencode_tag: 'dash.1080.video' });
  const storyEfg = base64UrlJson({ xpv_asset_id: storyAsset, video_id: storyAsset, vencode_tag: 'dash.720.video' });
  const squareEfg = base64UrlJson({ xpv_asset_id: squareAsset, video_id: squareAsset, vencode_tag: 'dash.720.video' });
  const url = (path, query) => `https://video-mia3-2.xx.fbcdn.net${path}?${query}`;
  const imageUrl = (name) => `https://scontent-mia3-2.xx.fbcdn.net/v/t1.6435-6/${name}.jpg?_qa=1`;
  const imageAssetPath = '/v/t39.30808-6/qa-image-variant-12345678901234567_n.jpg';
  const canonicalImageId = `asset:${imageAssetPath}`;
  const imageLowUrl =
    `https://scontent-mia3-2.xx.fbcdn.net${imageAssetPath}` +
    '?stp=dst-jpg_p590x443&oh=qa-low-signature&oe=1&_qa_variant=low';
  const imageHighUrl =
    `https://scontent-mia3-2.xx.fbcdn.net${imageAssetPath}` +
    '?stp=dst-jpg_p944x1088&oh=qa-high-signature&oe=2&_qa_variant=high';
  const mainCover = imageUrl('qa-vertical-reel-cover-990001234567890');
  const storyCover = imageUrl('qa-horizontal-story-cover-990001234567891');
  const squareCover = imageUrl('qa-square-video-cover-990001234567892');
  const imageLow = {
    id: canonicalImageId,
    url: imageLowUrl,
    kind: 'image',
    source: 'video',
    origin: 'graphql',
    addedAt: now - 32_000,
    width: 590, height: 443,
  };
  const imageHigh = {
    ...imageLow,
    url: imageHighUrl,
    origin: 'dom',
    width: 944, height: 1_088,
  };
  const storyImage = imageUrl('story-photo-2026');
  const main1080 = url('/v/t42/reel-main-1080.mp4', `tag=avc_1080p&efg=${mainEfg}`);
  const main720 = url('/v/t42/reel-main-720.mp4', `tag=avc_720p&efg=${mainEfg}`);
  const mainAudio = url('/v/t42/reel-main-audio.m4a', `tag=dash_audio&efg=${mainEfg}`);
  const story720 = url('/v/t42/story-secondary-720.mp4', `tag=avc_720p&efg=${storyEfg}`);
  const square720 = url('/v/t42/square-secondary-720.mp4', `tag=avc_720p&efg=${squareEfg}`);

  return {
    playingVideoId: mainAsset,
    playingItemId: 'video-reel-main-1080?tag=avc_1080p',
    recentUrl: main1080,
    imageVariant: {
      canonicalPath: imageAssetPath,
      low: imageLow,
      high: imageHigh,
    },
    items: [
      {
        id: 'fixture-main-1080',
        url: main1080,
        kind: 'video',
        source: 'reel',
        dash: true,
        audioUrl: mainAudio,
        thumbUrl: mainCover,
        height: 1080,
        durationSec: 34,
        origin: 'graphql',
        addedAt: now - 1_200,
      },
      {
        id: 'fixture-main-720',
        url: main720,
        kind: 'video',
        source: 'reel',
        dash: false,
        thumbUrl: mainCover,
        height: 720,
        durationSec: 34,
        origin: 'network',
        addedAt: now - 1_100,
      },
      {
        id: 'fixture-story-video',
        url: story720,
        kind: 'video',
        source: 'story',
        dash: false,
        thumbUrl: storyCover,
        height: 720,
        durationSec: 18,
        origin: 'graphql',
        addedAt: now - 15_000,
      },
      {
        id: 'fixture-square-video',
        url: square720,
        kind: 'video',
        source: 'highlight',
        dash: false,
        thumbUrl: squareCover,
        height: 720,
        durationSec: 22,
        origin: 'graphql',
        addedAt: now - 24_000,
      },
      imageLow,
      {
        id: 'fixture-story-image',
        url: storyImage,
        kind: 'image',
        source: 'story',
        origin: 'graphql',
        addedAt: now - 52_000,
      },
    ],
    saved: [
      {
        id: `v:xpv:${mainAsset}`,
        kind: 'video',
        source: 'reel',
        savedAt: now - 20_000,
        thumbUrl: mainCover,
        resLabel: '1080p',
        durationSec: 34,
      },
      {
        id: `i:${canonicalImageId}`,
        kind: 'image',
        source: 'highlight',
        savedAt: now - 10_000,
        thumbUrl: imageLowUrl,
      },
      {
        id: `v:xpv:${storyAsset}`,
        kind: 'video',
        source: 'story',
        savedAt: now - 4_000,
        thumbUrl: storyCover,
        resLabel: '720p',
        durationSec: 12,
      },
      {
        id: `v:xpv:${squareAsset}`,
        kind: 'video',
        source: 'highlight',
        savedAt: now - 2_000,
        thumbUrl: squareCover,
        resLabel: '720p',
        durationSec: 22,
      },
    ],
    settings: {
      filenameTemplate: '{source}-{date}-{id}',
      subfolder: true,
      defaultQuality: 'highest',
      directDownload: false,
      followBrowserLang: false,
      listOrder: 'newest',
      confirmClear: true,
      videosOnly: false,
      minResolution: 0,
      maxItems: 1500,
      diagEnabled: false,
    },
  };
}

function fixtureImageSvg(url) {
  const variants = [
    ['#4c64ff', '#35e0f2', '#081229'],
    ['#ff6b8a', '#ffba67', '#241127'],
    ['#7f56d9', '#43d7a7', '#10162d'],
    ['#2f80ed', '#56ccf2', '#111827'],
  ];
  const hash = [...url].reduce((sum, char) => (sum + char.charCodeAt(0)) % variants.length, 0);
  const [from, to, background] = variants[hash];
  if (url.includes('_qa_variant=low')) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="590" height="443" viewBox="0 0 590 443">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
        <rect width="590" height="443" fill="${background}"/>
        <circle cx="445" cy="95" r="150" fill="url(#g)" opacity=".95"/>
        <path d="M35 380 C155 205 385 220 555 390 L555 443 L35 443 Z" fill="url(#g)" opacity=".75"/>
      </svg>`;
  }
  if (url.includes('_qa_variant=high')) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="944" height="1088" viewBox="0 0 944 1088">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
        <rect width="944" height="1088" fill="${background}"/>
        <circle cx="705" cy="225" r="285" fill="url(#g)" opacity=".95"/>
        <circle cx="180" cy="870" r="310" fill="url(#g)" opacity=".55"/>
        <path d="M75 870 C235 560 665 565 870 920 L870 1088 L75 1088 Z" fill="url(#g)" opacity=".78"/>
      </svg>`;
  }
  if (url.includes('qa-horizontal') || url.includes('highlight-summer-2026')) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
        <rect width="1200" height="675" fill="${background}"/>
        <circle cx="930" cy="125" r="260" fill="url(#g)" opacity=".95"/>
        <circle cx="230" cy="565" r="300" fill="url(#g)" opacity=".6"/>
        <path d="M110 560 C360 330 790 350 1090 580 L1090 675 L110 675 Z" fill="url(#g)" opacity=".8"/>
      </svg>`;
  }
  if (url.includes('qa-square')) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
        <rect width="800" height="800" fill="${background}"/>
        <circle cx="600" cy="190" r="210" fill="url(#g)" opacity=".95"/>
        <circle cx="180" cy="650" r="250" fill="url(#g)" opacity=".6"/>
      </svg>`;
  }
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
      <rect width="600" height="900" fill="${background}"/>
      <circle cx="450" cy="170" r="230" fill="url(#g)" opacity=".95"/>
      <circle cx="120" cy="690" r="280" fill="url(#g)" opacity=".6"/>
      <path d="M80 630 C180 470 380 450 540 650 L540 900 L80 900 Z" fill="url(#g)" opacity=".8"/>
    </svg>`;
}

function attachEvidenceListeners(client, evidence, context) {
  const primitive = (arg) => {
    if (Object.prototype.hasOwnProperty.call(arg, 'value')) return arg.value;
    return arg.description ?? arg.type;
  };
  client.on('Runtime.consoleAPICalled', (params) => {
    evidence.console.push({
      context,
      level: params.type,
      timestamp: params.timestamp,
      text: (params.args ?? []).map(primitive).map(String).join(' '),
      stack: params.stackTrace?.callFrames?.slice(0, 4),
    });
  });
  client.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails ?? {};
    evidence.errors.push({
      context,
      source: 'Runtime.exceptionThrown',
      text: details.exception?.description ?? details.text ?? 'Unknown page exception',
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    });
  });
  client.on('Log.entryAdded', ({ entry }) => {
    if (!entry) return;
    evidence.console.push({
      context,
      level: entry.level,
      source: entry.source,
      text: entry.text,
      url: entry.url,
      lineNumber: entry.lineNumber,
      timestamp: entry.timestamp,
    });
    if (entry.level === 'error') {
      evidence.errors.push({ context, source: `Log.${entry.source}`, text: entry.text, url: entry.url });
    }
  });
  client.on('protocolError', (error) => {
    evidence.errors.push({ context, source: 'CDP.protocol', text: errorText(error) });
  });
}

async function enableEvidenceDomains(client) {
  await client.command('Runtime.enable');
  await client.command('Log.enable');
}

async function installFixtureImageInterceptor(page, evidence) {
  const pausedHighRequests = new Map();
  const highReleaseEvidence = {
    releaseArmed: false,
    pausedRequestCount: 0,
    releasedRequestCount: 0,
    releasedUrls: [],
  };
  let highReleased = false;
  const fulfill = async (params) => {
    const svg = fixtureImageSvg(params.request.url);
    await page.command('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'image/svg+xml; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: Buffer.from(svg).toString('base64'),
    });
  };
  page.on('Fetch.requestPaused', (params) => {
    void (async () => {
      if (params.request.url.includes('_qa_variant=high')) {
        if (!highReleased) {
          pausedHighRequests.set(params.requestId, params);
          highReleaseEvidence.pausedRequestCount += 1;
          return;
        }
        await fulfill(params);
        highReleaseEvidence.releasedRequestCount += 1;
        highReleaseEvidence.releasedUrls.push(params.request.url);
        return;
      }
      await fulfill(params);
    })().catch((error) => {
      evidence.errors.push({ context: 'sidepanel', source: 'Fetch.fulfillRequest', text: errorText(error) });
    });
  });
  await page.command('Fetch.enable', {
    patterns: [{ urlPattern: '*://*.fbcdn.net/*', resourceType: 'Image', requestStage: 'Request' }],
  });
  return {
    async releaseHighVariant() {
      highReleased = true;
      highReleaseEvidence.releaseArmed = true;
      const pending = [...pausedHighRequests.values()];
      pausedHighRequests.clear();
      await Promise.all(
        pending.map(async (params) => {
          await fulfill(params);
          highReleaseEvidence.releasedRequestCount += 1;
          highReleaseEvidence.releasedUrls.push(params.request.url);
        }),
      );
      return highReleaseEvidence;
    },
  };
}

async function seedStorage(page, fixture, language, theme) {
  fixture.settings.theme = theme;
  const expression = `
    (async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active || !Number.isInteger(active.id)) throw new Error('No active tab id available to the side panel');
      const fixture = ${JSON.stringify(fixture)};
      const language = ${JSON.stringify(language)};
      const tabId = active.id;
      await chrome.storage.session.set({
        ['media_' + tabId]: fixture.items,
        ['playing_' + tabId]: {
          ids: [fixture.playingItemId],
          hasVideo: true,
          vid: fixture.playingVideoId,
          coverUrls: [fixture.items[0].thumbUrl],
          mark: 'qa:reel:' + fixture.playingVideoId,
          at: Date.now(),
        },
        ['recent_' + tabId]: { tracks: [{ url: fixture.recentUrl, at: Date.now() }] },
        ['saved_' + tabId]: fixture.saved,
        caps: { sidePanel: true, offscreen: true },
      });
      await chrome.storage.local.set({ lang: language, settings: fixture.settings });
      return {
        tabId,
        requestedTheme: ${JSON.stringify(theme)},
        itemCount: fixture.items.length,
        savedCount: fixture.saved.length,
        keys: ['media_' + tabId, 'playing_' + tabId, 'recent_' + tabId, 'saved_' + tabId],
      };
    })()
  `;
  return evaluate(page, expression);
}

async function seedStableStorage(page, fixture, language, theme, expectedTabId, renderSurfaces = false) {
  const stableSamples = 5;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const seed = await seedStorage(page, fixture, language, theme);
    if (seed.tabId !== expectedTabId) {
      throw new Error(`Active Facebook tab changed while seeding QA: ${expectedTabId} -> ${seed.tabId}`);
    }
    const samples = [];
    for (let sample = 0; sample < stableSamples; sample++) {
      await delay(150);
      const state = await evaluate(
        page,
        `(async () => {
          const tabId = ${JSON.stringify(expectedTabId)};
          const keys = ['media_' + tabId, 'playing_' + tabId, 'saved_' + tabId];
          const stored = await chrome.storage.session.get(keys);
          return {
            mediaCount: Array.isArray(stored[keys[0]]) ? stored[keys[0]].length : 0,
            playingPresent: stored[keys[1]] != null,
            savedCount: Array.isArray(stored[keys[2]]) ? stored[keys[2]].length : 0,
          };
        })()`,
      );
      samples.push(state);
      if (
        state.mediaCount !== fixture.items.length ||
        state.playingPresent !== true ||
        state.savedCount !== fixture.saved.length
      ) {
        break;
      }
    }
    if (samples.length === stableSamples) {
      if (renderSurfaces) {
        await activateSurface(page, 'library', false);
        await activateSurface(page, 'now', false);
      }
      return { ...seed, stability: { attempt, stableSamples, samples } };
    }
  }
  throw new Error(`Fixture storage did not remain stable for Facebook tab ${expectedTabId}`);
}

async function waitForPanelReady(page) {
  const state = await waitForEvaluation(
    page,
    `(() => {
      const fatal = document.querySelector('#fatal');
      const version = document.querySelector('#version');
      const initialized = document.readyState === 'complete' && Boolean(version?.textContent);
      return {
        ready: initialized || (fatal != null && !fatal.hidden),
        initialized,
        fatalVisible: fatal != null && !fatal.hidden,
        fatalText: fatal?.textContent ?? '',
        url: location.href,
        runtimeId: chrome.runtime?.id ?? null,
      };
    })()`,
    'FaceScrap side-panel initialization',
  );
  if (state.fatalVisible || !state.initialized) {
    throw new Error(`FaceScrap side panel failed to initialize: ${state.fatalText || 'unknown fatal state'}`);
  }
  return state;
}

async function activateSurface(page, surface, settleFrames = true) {
  const clickExpression =
    surface === 'settings'
      ? `document.querySelector('#settings-open')?.click()`
      : `document.querySelector('#views [data-view="${surface}"]')?.click()`;
  await evaluate(page, clickExpression);
  const readyExpression =
    surface === 'settings'
      ? `(() => ({ ready: document.querySelector('#app')?.classList.contains('is-settings') === true && document.querySelector('#settings')?.hidden === false }))()`
      : surface === 'now'
      ? `(() => ({ ready:
            document.querySelector('#app')?.dataset.view === 'now' &&
            document.querySelector('#app')?.classList.contains('is-settings') === false &&
            document.querySelector('#views [data-view="now"]')?.getAttribute('aria-pressed') === 'true' &&
            document.querySelector('#now-content')?.hidden === false
          , nowContentHidden: document.querySelector('#now-content')?.hidden,
            nowEmptyHidden: document.querySelector('#now-empty')?.hidden,
            fatalText: document.querySelector('#fatal')?.textContent ?? '',
            cardCount: document.querySelectorAll('#list .card').length
          }))()`
        : `(() => {
            const active = document.querySelector('#views [data-view="${surface}"]');
            const app = document.querySelector('#app');
            const cardCount = document.querySelectorAll('#list .card').length;
            return {
              ready:
                app?.dataset.view === '${surface}' &&
                app?.classList.contains('is-settings') === false &&
                active?.getAttribute('aria-pressed') === 'true' &&
                cardCount >= 3,
              appView: app?.dataset.view,
              activePressed: active?.getAttribute('aria-pressed'),
              gridTitle: document.querySelector('#grid-title')?.textContent ?? '',
              cardCount
            };
          })()`;
  await waitForEvaluation(page, readyExpression, `${surface} surface`);
  if (settleFrames) {
    // Let local fonts, image interception, and the CSS animation frame settle.
    await evaluate(page, `document.fonts?.ready ?? Promise.resolve()`);
    await evaluate(page, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  }
}

async function inspectSurface(page, surface, language) {
  return evaluate(
    page,
    `(() => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement) || el.hidden) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const nav = document.querySelector('#views');
      const navRect = nav?.getBoundingClientRect();
      const navItems = [...(nav?.querySelectorAll('.view-pill') ?? [])].map((item) => {
        const rect = item.getBoundingClientRect();
        const style = getComputedStyle(item);
        return {
          text: item.textContent?.trim() ?? '',
          left: rect.left,
          right: rect.right,
          width: rect.width,
          color: style.color,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          visible: visible(item),
        };
      });
      const app = document.querySelector('#app');
      const fatal = document.querySelector('#fatal');
      const viewButton = document.querySelector('#views [data-view="${surface}"]');
      const preview = document.querySelector('#now-preview');
      const play = preview?.querySelector('.preview-play');
      const foreground = preview?.querySelector(':scope > img:not(.thumb-bg)');
      const title = document.querySelector('#now-title');
      const qualitySelect = document.querySelector('#now-qselect');
      const qualityCountText = document.querySelector('#now-qcount')?.textContent?.trim() ?? '';
      const qualityOptionCount = qualitySelect instanceof HTMLSelectElement ? qualitySelect.options.length : 0;
      const qualityOptionLabels =
        qualitySelect instanceof HTMLSelectElement
          ? [...qualitySelect.options].map((option) => option.textContent?.trim() ?? '')
          : [];
      const qualitySelectedLabel =
        qualitySelect instanceof HTMLSelectElement ? qualitySelect.selectedOptions[0]?.textContent?.trim() ?? '' : '';
      const previewRect = preview?.getBoundingClientRect();
      const playRect = play?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      let mediaTop = 0;
      let mediaBottom = previewRect?.height ?? 0;
      if (
        previewRect &&
        foreground instanceof HTMLImageElement &&
        foreground.naturalWidth > 0 &&
        foreground.naturalHeight > 0 &&
        getComputedStyle(foreground).objectFit === 'contain'
      ) {
        const scale = Math.min(
          previewRect.width / foreground.naturalWidth,
          previewRect.height / foreground.naturalHeight,
        );
        const renderedHeight = foreground.naturalHeight * scale;
        mediaTop = (previewRect.height - renderedHeight) / 2;
        mediaBottom = mediaTop + renderedHeight;
      }
      const unobscuredBottom = previewRect && titleRect
        ? Math.max(0, Math.min(previewRect.height, titleRect.top - previewRect.top))
        : previewRect?.height ?? 0;
      const visibleMediaBottom = Math.min(mediaBottom, unobscuredBottom);
      const playExpectedY = visibleMediaBottom > mediaTop ? (mediaTop + visibleMediaBottom) / 2 : null;
      const playCenterDeltaX = previewRect && playRect
        ? playRect.left + playRect.width / 2 - (previewRect.left + previewRect.width / 2)
        : null;
      const playCenterDeltaY = previewRect && playRect && playExpectedY !== null
        ? playRect.top + playRect.height / 2 - (previewRect.top + playExpectedY)
        : null;
      const checks = {
        viewportExact: innerWidth === ${VIEWPORT.width} && innerHeight === ${VIEWPORT.height},
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          document.body.scrollWidth <= document.body.clientWidth &&
          (!app || app.scrollWidth <= app.clientWidth),
        navVisible: visible(nav),
        navAtBottom: Boolean(navRect && navRect.bottom <= innerHeight + 1 && navRect.bottom >= innerHeight - 4),
        navItemsComplete:
          navItems.length === 4 &&
          navItems.every((item) => item.visible && navRect && item.left >= navRect.left && item.right <= navRect.right),
        fatalHidden: Boolean(fatal && fatal.hidden && !visible(fatal)),
        languageApplied: document.documentElement.lang === '${language}',
        surfaceActive: ${
          surface === 'settings'
            ? `app?.classList.contains('is-settings') === true && document.querySelector('#settings-open')?.getAttribute('aria-expanded') === 'true'`
            : `app?.dataset.view === '${surface}' && viewButton?.getAttribute('aria-pressed') === 'true'`
        },
        contentPresent: ${
          surface === 'now'
            ? `visible(document.querySelector('#now-content'))`
            : surface === 'library'
              ? `document.querySelectorAll('#list .card').length >= 3`
              : surface === 'saved'
                ? `document.querySelectorAll('#list .card').length >= 3`
                : `visible(document.querySelector('#settings')) && document.querySelectorAll('#settings .set-card').length >= 4`
        },
        videoDurationPreserved: ${
          surface === 'now'
            ? `visible(document.querySelector('#m-duration-metric')) && document.querySelector('#m-duration')?.textContent === '0:34'`
            : `true`
        },
        videoResolutionPreserved: ${
          surface === 'now'
            ? `document.querySelector('#m-resolution')?.textContent === '1080p'`
            : `true`
        },
        qualityCountNumeric: ${
          surface === 'now'
            ? `visible(document.querySelector('#now-qcount')) && /^\\d+$/.test(qualityCountText) && Number(qualityCountText) === qualityOptionCount`
            : `true`
        },
        qualityOptionsPreserved: ${
          surface === 'now'
            ? `qualityOptionLabels.length === 2 && qualityOptionLabels[0] === '1080p' && qualityOptionLabels[1] === '720p'`
            : `true`
        },
        qualitySelectionPreserved: ${
          surface === 'now'
            ? `qualitySelect instanceof HTMLSelectElement && !qualitySelect.disabled && qualitySelectedLabel === '1080p'`
            : `true`
        },
        playCentered: ${
          surface === 'now'
            ? `visible(play) && playCenterDeltaX !== null && playCenterDeltaY !== null && Math.abs(playCenterDeltaX) <= 2 && Math.abs(playCenterDeltaY) <= 2`
            : surface === 'settings'
              ? `true`
              : `false`
        },
      };
      return {
        surface: '${surface}',
        checks,
        passed: Object.values(checks).every(Boolean),
        metrics: {
          innerWidth,
          innerHeight,
          documentScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          appScrollWidth: app?.scrollWidth ?? null,
          navTop: navRect?.top ?? null,
          navBottom: navRect?.bottom ?? null,
          navHeight: navRect?.height ?? null,
          navItems,
          mediaTop,
          mediaBottom,
          unobscuredBottom,
          visibleMediaBottom,
          playExpectedY,
          playCenterDeltaX,
          playCenterDeltaY,
          language: document.documentElement.lang,
          qualityCountText,
          qualityOptionCount,
          qualityOptionLabels,
          qualitySelectedLabel,
          cardCount: document.querySelectorAll('#list .card').length,
          fatalText: fatal?.textContent ?? '',
        },
      };
    })()`,
  );
}

async function inspectCardPlayPositions(page) {
  return evaluate(
    page,
    `(() => {
      const cards = [...document.querySelectorAll('#list .card-thumb.is-video')].map((thumb, index) => {
        const frame = thumb.getBoundingClientRect();
        const image = thumb.querySelector(':scope > img:not(.thumb-bg)');
        const obstruction = thumb.closest('.card')?.querySelector('.card-title');
        const obstructionRect = obstruction?.getBoundingClientRect();
        const imageReady = image instanceof HTMLImageElement && image.naturalWidth > 0 && image.naturalHeight > 0;
        const fit = imageReady && image.classList.contains('media-fit-cover') ? 'cover' : 'contain';
        let mediaTop = 0;
        let mediaBottom = frame.height;
        if (imageReady && fit === 'contain') {
          const scale = Math.min(frame.width / image.naturalWidth, frame.height / image.naturalHeight);
          const renderedHeight = image.naturalHeight * scale;
          mediaTop = (frame.height - renderedHeight) / 2;
          mediaBottom = mediaTop + renderedHeight;
        }
        const unobscuredBottom = obstructionRect && obstructionRect.height > 0
          ? Math.max(0, Math.min(frame.height, obstructionRect.top - frame.top))
          : frame.height;
        const visibleTop = Math.max(0, mediaTop);
        const visibleBottom = Math.min(frame.height, mediaBottom, unobscuredBottom);
        const badgeSize = 30;
        const clearance = 12;
        let expectedY = null;
        if (visibleBottom - visibleTop >= badgeSize + clearance * 2) {
          const center = (visibleTop + visibleBottom) / 2;
          expectedY = Math.max(
            visibleTop + badgeSize / 2 + clearance,
            Math.min(visibleBottom - badgeSize / 2 - clearance, center),
          );
        }
        const cssY = Number.parseFloat(thumb.style.getPropertyValue('--play-y'));
        const obstructed = thumb.classList.contains('play-obstructed');
        const pseudoVisibility = getComputedStyle(thumb, '::after').visibility;
        const ratio = imageReady ? image.naturalWidth / image.naturalHeight : null;
        const aspect = ratio == null ? 'missing' : ratio < 0.8 ? 'portrait' : ratio > 1.2 ? 'landscape' : 'square';
        const positionValid = expectedY == null
          ? obstructed && pseudoVisibility === 'hidden' && !Number.isFinite(cssY)
          : !obstructed && pseudoVisibility !== 'hidden' && Number.isFinite(cssY) && Math.abs(cssY - expectedY) <= 0.75;
        return {
          index,
          aspect,
          fit,
          imageReady,
          naturalWidth: imageReady ? image.naturalWidth : 0,
          naturalHeight: imageReady ? image.naturalHeight : 0,
          frameWidth: frame.width,
          frameHeight: frame.height,
          expectedY,
          cssY: Number.isFinite(cssY) ? cssY : null,
          obstructed,
          pseudoVisibility,
          positionValid,
        };
      });
      const aspects = [...new Set(cards.map((card) => card.aspect))].sort();
      const requiredAspects = ['landscape', 'portrait', 'square'];
      return {
        cards,
        aspects,
        cardCount: cards.length,
        aspectCoverage: requiredAspects.every((aspect) => aspects.includes(aspect)),
        allValid: cards.length >= 3 && cards.every((card) => card.positionValid),
      };
    })()`,
  );
}

async function exerciseCardPlayResize(page) {
  await evaluate(
    page,
    `(async () => {
      const images = [...document.querySelectorAll('#list .card-thumb.is-video > img:not(.thumb-bg)')];
      await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return true;
    })()`,
  );
  const initial = await inspectCardPlayPositions(page);
  await evaluate(
    page,
    `(() => {
      document.querySelectorAll('#list .card-thumb.is-video').forEach((thumb) => thumb.style.setProperty('--play-y', '-999px'));
      return true;
    })()`,
  );
  const poisoned = await inspectCardPlayPositions(page);
  await setViewport(page, { ...VIEWPORT, width: 400 });
  await evaluate(page, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const resized = await inspectCardPlayPositions(page);
  await setViewport(page, VIEWPORT);
  await evaluate(page, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const restored = await inspectCardPlayPositions(page);
  const resizeRepaired =
    poisoned.cardCount === initial.cardCount &&
    poisoned.cards.every((card) => !card.positionValid) &&
    resized.cards.every((card) => card.positionValid);
  return {
    initial,
    poisoned,
    resized,
    restored,
    valid:
      initial.allValid &&
      resized.allValid &&
      restored.allValid &&
      initial.aspectCoverage &&
      resized.aspectCoverage &&
      restored.aspectCoverage &&
      initial.cardCount === resized.cardCount &&
      initial.cardCount === restored.cardCount &&
      resizeRepaired,
    resizeRepaired,
  };
}

function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) throw new Error('CDP returned a non-PNG screenshot');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function captureSurface(page, surface, language) {
  await activateSurface(page, surface);
  let settingsInitialFocus;
  if (surface === 'library') {
    await evaluate(
      page,
      `(() => {
        const picks = [...document.querySelectorAll('#list .pick:not(:disabled)')];
        for (const index of [0, 2]) {
          const pick = picks[index];
          if (pick?.getAttribute('aria-pressed') !== 'true') pick?.click();
        }
      })()`,
    );
    await waitForEvaluation(
      page,
      `(() => ({ ready: document.querySelectorAll('#list .pick[aria-pressed="true"]').length === 2 && document.querySelector('#tray')?.hidden === false }))()`,
      'two selected Library cards and the bulk-download tray',
    );
  } else if (surface === 'saved') {
    await evaluate(
      page,
      `(() => document.querySelectorAll('#list .pick[aria-pressed="true"]').forEach((pick) => pick.click()))()`,
    );
    await waitForEvaluation(
      page,
      `(() => ({ ready: document.querySelector('#tray')?.hidden === true }))()`,
      'cleared Saved selection tray',
    );
  } else if (surface === 'settings') {
    settingsInitialFocus = await evaluate(page, `document.activeElement?.id ?? ''`);
    await evaluate(page, `document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  }
  const inspection = await inspectSurface(page, surface, language);
  if (surface === 'library') {
    const cardPlay = await exerciseCardPlayResize(page);
    inspection.checks.playCentered = cardPlay.initial.allValid;
    inspection.checks.cardPlayPositionsValid = cardPlay.initial.allValid && cardPlay.initial.aspectCoverage;
    inspection.checks.cardPlayResizeValid = cardPlay.valid;
    inspection.metrics.cardPlay = cardPlay;
    inspection.checks.selectionTrayVisible =
      await evaluate(page, `document.querySelector('#tray')?.hidden === false && document.querySelectorAll('#list .pick[aria-pressed="true"]').length === 2`);
    inspection.passed = Object.values(inspection.checks).every(Boolean);
  } else if (surface === 'saved') {
    const cardPlay = await exerciseCardPlayResize(page);
    inspection.checks.playCentered = cardPlay.initial.allValid;
    inspection.checks.cardPlayPositionsValid = cardPlay.initial.allValid && cardPlay.initial.aspectCoverage;
    inspection.checks.cardPlayResizeValid = cardPlay.valid;
    inspection.metrics.cardPlay = cardPlay;
    inspection.passed = Object.values(inspection.checks).every(Boolean);
  } else if (surface === 'settings') {
    inspection.checks.focusMovedIntoSettings = settingsInitialFocus === 'set-template';
    inspection.metrics.initialFocusedElement = settingsInitialFocus;
    inspection.passed = Object.values(inspection.checks).every(Boolean);
  }
  const screenshot = await page.command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(screenshot.data, 'base64');
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== VIEWPORT.width || dimensions.height !== VIEWPORT.height) {
    inspection.checks.pngDimensionsExact = false;
    inspection.passed = false;
  } else {
    inspection.checks.pngDimensionsExact = true;
  }
  const filename = `${surface}.png`;
  const path = join(QA_DIR, filename);
  await writeFile(path, bytes);
  return { ...inspection, file: filename, path, ...dimensions, bytes: bytes.length };
}

async function exerciseDetectionPipeline(page, facebookPage, tabId) {
  const graphqlEndpoint = 'https://www.facebook.com/api/graphql/?facescrap_detection_qa=1';
  const graphqlVideoUrl = 'https://video.xx.fbcdn.net/v/t42/qa-graphql-object.mp4?token=one';
  const graphqlImageUrl = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/qa-graphql-object.jpg?token=one';
  const visibleVideoUrl = 'https://video.xx.fbcdn.net/v/t42/qa-visible-active.mp4?token=one';
  const visibleImageUrl = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/qa-visible-active.jpg?token=one';
  const mediaKey = `media_${tabId}`;
  const playingKey = `playing_${tabId}`;
  const probeUrls = [graphqlVideoUrl, graphqlImageUrl, visibleVideoUrl, visibleImageUrl];

  await evaluate(
    page,
    `(async () => {
      const mediaKey = ${JSON.stringify(mediaKey)};
      const playingKey = ${JSON.stringify(playingKey)};
      const probeUrls = new Set(${JSON.stringify(probeUrls)});
      const stored = await chrome.storage.session.get([mediaKey, playingKey]);
      const media = Array.isArray(stored[mediaKey])
        ? stored[mediaKey].filter((item) => !probeUrls.has(item?.url))
        : [];
      await chrome.storage.session.set({ [mediaKey]: media });
      await chrome.storage.session.remove(playingKey);
      return { mediaCount: media.length, playingRemoved: true };
    })()`,
  );

  const graphqlBody = JSON.stringify({
    data: {
      playable_url_quality_sd: { uri: graphqlVideoUrl },
      image: { uri: graphqlImageUrl, width: '944', height: '1088' },
    },
  });
  let resolveGraphql;
  let rejectGraphql;
  const graphqlFulfilled = new Promise((resolveRequest, rejectRequest) => {
    resolveGraphql = resolveRequest;
    rejectGraphql = rejectRequest;
  });
  const graphqlHandler = (params) => {
    if (params.request.url !== graphqlEndpoint) {
      void facebookPage.command('Fetch.continueRequest', { requestId: params.requestId }).catch(rejectGraphql);
      return;
    }
    void facebookPage
      .command('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(graphqlBody).toString('base64'),
      })
      .then(
        () => resolveGraphql({ url: params.request.url, resourceType: params.resourceType }),
        rejectGraphql,
      );
  };
  facebookPage.on('Fetch.requestPaused', graphqlHandler);
  await facebookPage.command('Fetch.enable', {
    patterns: [{ urlPattern: graphqlEndpoint, requestStage: 'Request' }],
  });
  let graphqlRequest;
  try {
    const response = await evaluate(
      facebookPage,
      `(async () => {
        const response = await fetch(${JSON.stringify(graphqlEndpoint)}, { cache: 'no-store' });
        return { status: response.status, body: await response.text() };
      })()`,
    );
    graphqlRequest = await Promise.race([
      graphqlFulfilled,
      delay(ACTION_TIMEOUT_MS).then(() => {
        throw new Error('Timed out fulfilling the object-shaped GraphQL detection response');
      }),
    ]);
    if (response.status !== 200 || response.body !== graphqlBody) {
      throw new Error(`Synthetic GraphQL response mismatch: ${JSON.stringify(response)}`);
    }
  } finally {
    await facebookPage.command('Fetch.disable').catch(() => undefined);
    facebookPage.off('Fetch.requestPaused', graphqlHandler);
  }

  const graphqlCapture = await waitForEvaluation(
    page,
    `(async () => {
      const mediaKey = ${JSON.stringify(mediaKey)};
      const stored = (await chrome.storage.session.get(mediaKey))[mediaKey] ?? [];
      const video = stored.find((item) => item?.url === ${JSON.stringify(graphqlVideoUrl)});
      const image = stored.find((item) => item?.url === ${JSON.stringify(graphqlImageUrl)});
      return {
        ready:
          video?.kind === 'video' &&
          video?.origin === 'graphql' &&
          image?.kind === 'image' &&
          image?.origin === 'graphql' &&
          image?.width === 944 &&
          image?.height === 1088,
        video: video ?? null,
        image: image ?? null,
      };
    })()`,
    'the real page hook to capture object-shaped GraphQL video and image values',
  );

  const videoInsertedAt = Date.now();
  const videoInsertion = await evaluate(
    facebookPage,
    `(() => {
      document.querySelectorAll('[data-facescrap-detection-probe]').forEach((node) => node.remove());
      const video = document.createElement('video');
      video.dataset.facescrapDetectionProbe = 'video';
      video.preload = 'none';
      video.muted = true;
      video.src = ${JSON.stringify(visibleVideoUrl)};
      Object.assign(video.style, {
        position: 'fixed',
        left: '15vw',
        top: '15vh',
        width: '70vw',
        height: '70vh',
        zIndex: '2147483647',
        background: 'black',
        pointerEvents: 'auto',
      });
      document.body.append(video);
      return {
        connected: video.isConnected,
        src: video.src,
        currentSrc: video.currentSrc,
        rect: video.getBoundingClientRect().toJSON(),
      };
    })()`,
  );
  const visibleVideoDom = await waitForEvaluation(
    facebookPage,
    `(() => {
      const video = document.querySelector('[data-facescrap-detection-probe="video"]');
      return {
        ready:
          video instanceof HTMLVideoElement &&
          video.isConnected &&
          video.currentSrc === ${JSON.stringify(visibleVideoUrl)},
        currentSrc: video instanceof HTMLVideoElement ? video.currentSrc : null,
        networkState: video instanceof HTMLVideoElement ? video.networkState : null,
        readyState: video instanceof HTMLVideoElement ? video.readyState : null,
      };
    })()`,
    'the synthetic visible video element to expose its direct currentSrc',
  );
  const visibleVideoCapture = await waitForEvaluation(
    page,
    `(async () => {
      const stored = await chrome.storage.session.get([
        ${JSON.stringify(mediaKey)},
        ${JSON.stringify(playingKey)},
      ]);
      const media = stored[${JSON.stringify(mediaKey)}] ?? [];
      const playing = stored[${JSON.stringify(playingKey)}];
      const item = media.find((candidate) => candidate?.url === ${JSON.stringify(visibleVideoUrl)});
      return {
        ready:
          item?.kind === 'video' &&
          item?.origin === 'dom' &&
          playing?.hasVideo === true &&
          Array.isArray(playing?.ids) &&
          playing.ids.includes(item.id),
        item: item ?? null,
        playing: playing ?? null,
      };
    })()`,
    'the visible direct video to reach Library and Now Playing through content.ts',
  );
  const visibleVideoElapsedMs = Date.now() - videoInsertedAt;

  let resolveVisibleImage;
  let rejectVisibleImage;
  const visibleImageFulfilled = new Promise((resolveRequest, rejectRequest) => {
    resolveVisibleImage = resolveRequest;
    rejectVisibleImage = rejectRequest;
  });
  const visibleImageHandler = (params) => {
    if (params.resourceType !== 'Image' || params.request.url !== visibleImageUrl) {
      void facebookPage.command('Fetch.continueRequest', { requestId: params.requestId }).catch(rejectVisibleImage);
      return;
    }
    void facebookPage
      .command('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'image/svg+xml; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(fixtureImageSvg(visibleImageUrl)).toString('base64'),
      })
      .then(
        () => resolveVisibleImage({ url: params.request.url, resourceType: params.resourceType }),
        rejectVisibleImage,
      );
  };
  facebookPage.on('Fetch.requestPaused', visibleImageHandler);
  await facebookPage.command('Fetch.enable', {
    patterns: [{ urlPattern: visibleImageUrl, resourceType: 'Image', requestStage: 'Request' }],
  });
  const imageInsertedAt = Date.now();
  let imageInsertion;
  let visibleImageRequest;
  let visibleImageCapture;
  try {
    imageInsertion = await evaluate(
      facebookPage,
      `(() => {
        document.querySelectorAll('[data-facescrap-detection-probe]').forEach((node) => node.remove());
        const image = document.createElement('div');
        image.dataset.facescrapDetectionProbe = 'image';
        Object.assign(image.style, {
          position: 'fixed',
          left: '15vw',
          top: '15vh',
          width: '70vw',
          height: '70vh',
          zIndex: '2147483647',
          backgroundImage: 'url("${visibleImageUrl}")',
          backgroundPosition: 'center',
          backgroundSize: 'contain',
          backgroundRepeat: 'no-repeat',
          pointerEvents: 'auto',
        });
        document.body.append(image);
        return {
          connected: image.isConnected,
          backgroundImage: getComputedStyle(image).backgroundImage,
          rect: image.getBoundingClientRect().toJSON(),
        };
      })()`,
    );
    visibleImageRequest = await Promise.race([
      visibleImageFulfilled,
      delay(ACTION_TIMEOUT_MS).then(() => {
        throw new Error('Timed out fulfilling the visible CSS-background image');
      }),
    ]);
    visibleImageCapture = await waitForEvaluation(
      page,
      `(async () => {
        const stored = await chrome.storage.session.get([
          ${JSON.stringify(mediaKey)},
          ${JSON.stringify(playingKey)},
        ]);
        const media = stored[${JSON.stringify(mediaKey)}] ?? [];
        const playing = stored[${JSON.stringify(playingKey)}];
        const item = media.find((candidate) => candidate?.url === ${JSON.stringify(visibleImageUrl)});
        return {
          ready:
            item?.kind === 'image' &&
            item?.origin === 'dom' &&
            playing?.hasVideo === false &&
            Array.isArray(playing?.ids) &&
            playing.ids.includes(item.id),
          item: item ?? null,
          playing: playing ?? null,
        };
      })()`,
      'the visible CSS-background photo to reach Library and Now Playing through content.ts',
    );
  } finally {
    await facebookPage.command('Fetch.disable').catch(() => undefined);
    facebookPage.off('Fetch.requestPaused', visibleImageHandler);
  }
  const visibleImageElapsedMs = Date.now() - imageInsertedAt;

  await evaluate(
    facebookPage,
    `(() => {
      document.querySelectorAll('[data-facescrap-detection-probe]').forEach((node) => node.remove());
      return { remaining: document.querySelectorAll('[data-facescrap-detection-probe]').length };
    })()`,
  );
  // Let the detector publish the restored empty synthetic page before the
  // deterministic fixture is seeded again by the caller.
  await delay(1_600);

  const checks = {
    graphqlRequestObserved:
      graphqlRequest?.url === graphqlEndpoint &&
      (graphqlRequest?.resourceType === 'Fetch' || graphqlRequest?.resourceType === 'XHR'),
    graphqlObjectVideoCaptured:
      graphqlCapture?.video?.url === graphqlVideoUrl &&
      graphqlCapture?.video?.kind === 'video' &&
      graphqlCapture?.video?.origin === 'graphql',
    graphqlStringDimensionsCaptured:
      graphqlCapture?.image?.url === graphqlImageUrl &&
      graphqlCapture?.image?.kind === 'image' &&
      graphqlCapture?.image?.origin === 'graphql' &&
      graphqlCapture?.image?.width === 944 &&
      graphqlCapture?.image?.height === 1088,
    visibleVideoExposed:
      videoInsertion?.connected === true &&
      visibleVideoDom?.currentSrc === visibleVideoUrl,
    visibleVideoCaptured:
      visibleVideoCapture?.item?.url === visibleVideoUrl &&
      visibleVideoCapture?.item?.kind === 'video' &&
      visibleVideoCapture?.item?.origin === 'dom' &&
      visibleVideoCapture?.playing?.hasVideo === true &&
      visibleVideoCapture?.playing?.ids?.includes(visibleVideoCapture?.item?.id),
    visibleVideoUpdatedBelowTwoSeconds: visibleVideoElapsedMs < 2_000,
    visibleBackgroundImageExposed:
      imageInsertion?.connected === true &&
      imageInsertion?.backgroundImage?.includes(visibleImageUrl) &&
      visibleImageRequest?.url === visibleImageUrl,
    visibleBackgroundImageCaptured:
      visibleImageCapture?.item?.url === visibleImageUrl &&
      visibleImageCapture?.item?.kind === 'image' &&
      visibleImageCapture?.item?.origin === 'dom' &&
      visibleImageCapture?.playing?.hasVideo === false &&
      visibleImageCapture?.playing?.ids?.includes(visibleImageCapture?.item?.id),
    visibleImageUpdatedBelowTwoSeconds: visibleImageElapsedMs < 2_000,
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    timings: {
      visibleVideoElapsedMs,
      visibleImageElapsedMs,
      previousCaptureWaitMs: 4_000,
    },
    graphql: {
      request: graphqlRequest,
      capture: graphqlCapture,
    },
    visibleVideo: {
      insertion: videoInsertion,
      dom: visibleVideoDom,
      capture: visibleVideoCapture,
    },
    visibleImage: {
      insertion: imageInsertion,
      request: visibleImageRequest,
      capture: visibleImageCapture,
    },
  };
}

async function captureImageNowPlaying(
  page,
  facebookPage,
  facebookExecutionContexts,
  extensionId,
  fixture,
  tabId,
  language,
  fixtureImages,
) {
  const low = fixture.imageVariant?.low;
  const high = fixture.imageVariant?.high;
  if (!low || !high) throw new Error('Missing deterministic LOW/HIGH image fixture');
  if (low.id !== high.id) throw new Error('LOW/HIGH fixtures must share one canonical image id');
  if (new URL(low.url).pathname !== new URL(high.url).pathname) {
    throw new Error('LOW/HIGH fixtures must share one canonical image path');
  }
  const expectedTitle = language === 'es' ? 'Imagen' : 'Image';
  const mediaKey = `media_${tabId}`;
  const playingKey = `playing_${tabId}`;

  const lowStorage = await evaluate(
    page,
    `(async () => {
      const tabId = ${JSON.stringify(tabId)};
      if (!Number.isInteger(tabId)) throw new Error('Missing seeded Facebook tab id');
      const low = ${JSON.stringify(low)};
      const mediaKey = ${JSON.stringify(mediaKey)};
      const playingKey = ${JSON.stringify(playingKey)};
      const current = (await chrome.storage.session.get(mediaKey))[mediaKey] ?? [];
      const next = current.map((item) => item.id === low.id ? low : item);
      if (!next.some((item) => item.id === low.id)) next.push(low);
      await chrome.storage.session.set({
        [mediaKey]: next,
        [playingKey]: {
          ids: [low.id],
          hasVideo: false,
          coverUrls: [low.url],
          mark: 'qa:image-variant:low',
          at: Date.now(),
        },
      });
      const stored = (await chrome.storage.session.get(mediaKey))[mediaKey] ?? [];
      const match = stored.find((item) => item.id === low.id);
      return {
        phase: 'low',
        mediaKey,
        playingKey,
        storedLowVariant:
          match?.url === low.url &&
          match?.width === low.width &&
          match?.height === low.height,
        item: match ?? null,
      };
    })()`,
  );
  await activateSurface(page, 'now');
  const lowInspection = await waitForEvaluation(
    page,
    `(() => {
      const expectedUrl = ${JSON.stringify(low.url)};
      const foreground = document.querySelector('#now-preview > img:not(.thumb-bg)');
      const quality = document.querySelector('#now-quality');
      const resolution = document.querySelector('#m-resolution')?.textContent?.trim() ?? '';
      const ready =
        foreground instanceof HTMLImageElement &&
        foreground.complete &&
        foreground.naturalWidth === 590 &&
        foreground.naturalHeight === 443 &&
        foreground.getAttribute('src') === expectedUrl &&
        foreground.currentSrc === expectedUrl &&
        resolution === '590×443' &&
        quality instanceof HTMLElement &&
        quality.hidden &&
        getComputedStyle(quality).display === 'none';
      return {
        ready,
        phase: 'low',
        url: foreground instanceof HTMLImageElement ? foreground.currentSrc : null,
        naturalWidth: foreground instanceof HTMLImageElement ? foreground.naturalWidth : 0,
        naturalHeight: foreground instanceof HTMLImageElement ? foreground.naturalHeight : 0,
        resolution,
        imageQualitySelectorHidden:
          quality instanceof HTMLElement &&
          quality.hidden &&
          getComputedStyle(quality).display === 'none',
      };
    })()`,
    'the LOW 590×443 image variant to paint first',
  );
  const lowScreenshot = await page.command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const lowBytes = Buffer.from(lowScreenshot.data, 'base64');
  const lowDimensions = pngDimensions(lowBytes);
  const lowFilename = 'now-image-low.png';
  const lowPath = join(QA_DIR, lowFilename);
  await writeFile(lowPath, lowBytes);

  const highIngress = await captureHighImageThroughSyntheticDom(
    facebookPage,
    facebookExecutionContexts,
    extensionId,
    high,
  );
  const highStorage = await waitForEvaluation(
    page,
    `(async () => {
      const high = ${JSON.stringify(high)};
      const mediaKey = ${JSON.stringify(mediaKey)};
      const stored = (await chrome.storage.session.get(mediaKey))[mediaKey] ?? [];
      const matches = stored.filter((item) => item.id === high.id);
      const match = matches[0];
      const storedHighVariant =
        matches.length === 1 &&
        match?.url === high.url &&
        match?.width === high.width &&
        match?.height === high.height;
      return {
        ready: storedHighVariant,
        phase: 'high',
        storedHighVariant,
        canonicalItemCount: matches.length,
        item: match ?? null,
      };
    })()`,
    'the service worker to merge and store the HIGH image variant',
  );
  const highMetadataBeforeImageLoad = await waitForEvaluation(
    page,
    `(() => {
      const expectedUrl = ${JSON.stringify(high.url)};
      const expectedTitle = ${JSON.stringify(expectedTitle)};
      const foreground = document.querySelector('#now-preview > img:not(.thumb-bg)');
      const quality = document.querySelector('#now-quality');
      const select = document.querySelector('#now-qselect');
      const resolution = document.querySelector('#m-resolution')?.textContent?.trim() ?? '';
      const title = document.querySelector('#now-title')?.textContent?.trim() ?? '';
      const metadataReady =
        foreground instanceof HTMLImageElement &&
        foreground.getAttribute('src') === expectedUrl &&
        !foreground.complete &&
        foreground.naturalWidth === 0 &&
        foreground.naturalHeight === 0 &&
        resolution === '944×1088' &&
        title === expectedTitle &&
        quality instanceof HTMLElement &&
        quality.hidden &&
        getComputedStyle(quality).display === 'none' &&
        select instanceof HTMLSelectElement &&
        select.getClientRects().length === 0;
      return {
        ready: metadataReady,
        phase: 'high',
        highMetadataBeforeImageLoad: metadataReady,
        src: foreground instanceof HTMLImageElement ? foreground.getAttribute('src') : null,
        complete: foreground instanceof HTMLImageElement ? foreground.complete : null,
        naturalWidth: foreground instanceof HTMLImageElement ? foreground.naturalWidth : 0,
        naturalHeight: foreground instanceof HTMLImageElement ? foreground.naturalHeight : 0,
        resolution,
        title,
        imageQualitySelectorHidden:
          quality instanceof HTMLElement &&
          quality.hidden &&
          getComputedStyle(quality).display === 'none' &&
          select instanceof HTMLSelectElement &&
          select.getClientRects().length === 0,
      };
    })()`,
    'stored HIGH metadata to repaint before the HIGH image response is released',
  );
  const highRelease = await fixtureImages.releaseHighVariant();
  const highLoaded = await waitForEvaluation(
    page,
    `(() => {
      const expectedUrl = ${JSON.stringify(high.url)};
      const foreground = document.querySelector('#now-preview > img:not(.thumb-bg)');
      return {
        ready:
          foreground instanceof HTMLImageElement &&
          foreground.complete &&
          foreground.naturalWidth === 944 &&
          foreground.naturalHeight === 1088 &&
          foreground.getAttribute('src') === expectedUrl &&
          foreground.currentSrc === expectedUrl,
        currentSrc: foreground instanceof HTMLImageElement ? foreground.currentSrc : null,
        naturalWidth: foreground instanceof HTMLImageElement ? foreground.naturalWidth : 0,
        naturalHeight: foreground instanceof HTMLImageElement ? foreground.naturalHeight : 0,
      };
    })()`,
    'the HIGH 944×1088 image response to load',
  );

  let qaDownloadProbe;
  try {
    const probeStarted = await evaluate(
      page,
      `(() => {
        const button = document.querySelector('#now-download');
        const originalSendMessage = chrome.runtime.sendMessage;
        const messages = [];
        const stub = (...args) => {
          const message = args[0];
          if (message?.type === 'FACESCRAP_DOWNLOAD_DIRECT') {
            messages.push(JSON.parse(JSON.stringify(message)));
            return Promise.resolve({ ok: true });
          }
          return originalSendMessage.apply(chrome.runtime, args);
        };
        chrome.runtime.sendMessage = stub;
        const patched = chrome.runtime.sendMessage === stub;
        globalThis.__facescrapQaDownloadProbe = { originalSendMessage, messages };
        if (patched && button instanceof HTMLButtonElement && !button.disabled) button.click();
        return {
          patched,
          clicked: patched && button instanceof HTMLButtonElement && !button.disabled,
          buttonText: button?.textContent?.trim() ?? '',
        };
      })()`,
    );
    if (!probeStarted?.patched || !probeStarted.clicked) {
      throw new Error(`Could not install the network-free image download probe: ${JSON.stringify(probeStarted)}`);
    }
    qaDownloadProbe = await waitForEvaluation(
      page,
      `(() => {
        const qaDownloadProbe = globalThis.__facescrapQaDownloadProbe;
        const message = qaDownloadProbe?.messages?.find(
          (entry) => entry?.type === 'FACESCRAP_DOWNLOAD_DIRECT',
        );
        return {
          ready: message != null,
          message: message ?? null,
          messageCount: qaDownloadProbe?.messages?.length ?? 0,
        };
      })()`,
      'the image Download button to expose its worker message target',
    );
  } finally {
    await evaluate(
      page,
      `(() => {
        const qaDownloadProbe = globalThis.__facescrapQaDownloadProbe;
        if (qaDownloadProbe?.originalSendMessage) {
          chrome.runtime.sendMessage = qaDownloadProbe.originalSendMessage;
        }
        delete globalThis.__facescrapQaDownloadProbe;
      })()`,
    ).catch(() => undefined);
  }

  const finalState = await waitForEvaluation(
    page,
    `(() => {
      const expectedUrl = ${JSON.stringify(high.url)};
      const expectedTitle = ${JSON.stringify(expectedTitle)};
      const foreground = document.querySelector('#now-preview > img:not(.thumb-bg)');
      const background = document.querySelector('#now-preview > img.thumb-bg');
      const quality = document.querySelector('#now-quality');
      const select = document.querySelector('#now-qselect');
      const ready =
        foreground instanceof HTMLImageElement &&
        foreground.complete &&
        foreground.naturalWidth === 944 &&
        foreground.naturalHeight === 1088 &&
        foreground.getAttribute('src') === expectedUrl &&
        foreground.currentSrc === expectedUrl &&
        background instanceof HTMLImageElement &&
        background.getAttribute('src') === expectedUrl &&
        document.querySelector('#m-resolution')?.textContent?.trim() === '944×1088' &&
        document.querySelector('#now-title')?.textContent?.trim() === expectedTitle &&
        quality instanceof HTMLElement &&
        quality.hidden &&
        getComputedStyle(quality).display === 'none' &&
        select instanceof HTMLSelectElement &&
        select.getClientRects().length === 0;
      return {
        ready,
        foregroundSrc: foreground instanceof HTMLImageElement ? foreground.getAttribute('src') : null,
        currentSrc: foreground instanceof HTMLImageElement ? foreground.currentSrc : null,
        backgroundSrc: background instanceof HTMLImageElement ? background.getAttribute('src') : null,
        naturalWidth: foreground instanceof HTMLImageElement ? foreground.naturalWidth : 0,
        naturalHeight: foreground instanceof HTMLImageElement ? foreground.naturalHeight : 0,
        resolution: document.querySelector('#m-resolution')?.textContent?.trim() ?? '',
        title: document.querySelector('#now-title')?.textContent?.trim() ?? '',
        qualityHidden: quality instanceof HTMLElement ? quality.hidden : false,
        qualityDisplay: quality instanceof HTMLElement ? getComputedStyle(quality).display : null,
        qualitySelectRects: select instanceof HTMLSelectElement ? select.getClientRects().length : null,
      };
    })()`,
    'the HIGH image Now Playing state after the download probe repaint',
  );
  const inspection = await evaluate(
    page,
    `(() => {
      const foreground = document.querySelector('#now-preview > img:not(.thumb-bg)');
      const background = document.querySelector('#now-preview > img.thumb-bg');
      const durationMetric = document.querySelector('#m-duration-metric');
      const durationValue = document.querySelector('#m-duration');
      const previewDuration = document.querySelector('#now-dur');
      const quality = document.querySelector('#now-quality');
      const select = document.querySelector('#now-qselect');
      return {
        durationMetricHidden:
          durationMetric instanceof HTMLElement &&
          durationMetric.hidden &&
          getComputedStyle(durationMetric).display === 'none',
        durationValueEmpty: durationValue?.textContent === '',
        previewDurationHidden:
          previewDuration instanceof HTMLElement &&
          previewDuration.textContent === '' &&
          getComputedStyle(previewDuration).display === 'none',
        formatIsJpg: document.querySelector('#m-format')?.textContent?.trim() === 'JPG',
        imageQualitySelectorHidden:
          quality instanceof HTMLElement &&
          quality.hidden &&
          getComputedStyle(quality).display === 'none' &&
          select instanceof HTMLSelectElement &&
          select.getClientRects().length === 0,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          document.body.scrollWidth <= document.body.clientWidth,
        foregroundSrc: foreground instanceof HTMLImageElement ? foreground.getAttribute('src') : null,
        foregroundCurrentSrc: foreground instanceof HTMLImageElement ? foreground.currentSrc : null,
        backgroundSrc: background instanceof HTMLImageElement ? background.getAttribute('src') : null,
        naturalWidth: foreground instanceof HTMLImageElement ? foreground.naturalWidth : 0,
        naturalHeight: foreground instanceof HTMLImageElement ? foreground.naturalHeight : 0,
        resolutionText: document.querySelector('#m-resolution')?.textContent?.trim() ?? '',
        titleText: document.querySelector('#now-title')?.textContent?.trim() ?? '',
      };
    })()`,
  );
  const downloadMessage = qaDownloadProbe?.message ?? null;
  const checks = {
    canonicalIdentityPreserved:
      low.id === high.id && new URL(low.url).pathname === new URL(high.url).pathname,
    storedLowVariant: lowStorage?.storedLowVariant === true,
    lowPaintedFirst:
      lowInspection?.phase === 'low' &&
      lowInspection.url === low.url &&
      lowInspection.naturalWidth === 590 &&
      lowInspection.naturalHeight === 443 &&
      lowInspection.resolution === '590×443',
    lowPngDimensionsExact:
      lowDimensions.width === VIEWPORT.width && lowDimensions.height === VIEWPORT.height,
    highDomIngressObserved:
      highIngress?.contentContext?.runtimeId === extensionId &&
      highIngress?.context?.origin === `chrome-extension://${extensionId}` &&
      highIngress?.inserted?.elementType === 'HTMLImageElement' &&
      highIngress?.request?.url === high.url &&
      highIngress?.request?.cacheControl === 'no-store' &&
      highIngress?.loaded?.currentSrc === high.url &&
      highIngress?.loaded?.naturalWidth === 944 &&
      highIngress?.loaded?.naturalHeight === 1_088,
    storedHighVariant: highStorage?.storedHighVariant === true && highStorage?.canonicalItemCount === 1,
    highMetadataBeforeImageLoad: highMetadataBeforeImageLoad?.highMetadataBeforeImageLoad === true,
    highImageResponseReleased:
      highRelease.releaseArmed === true &&
      highRelease.releasedRequestCount > 0 &&
      highRelease.releasedUrls.every((url) => url === high.url),
    imageLoaded:
      highLoaded?.naturalWidth === 944 &&
      highLoaded?.naturalHeight === 1_088 &&
      finalState?.naturalWidth === 944 &&
      finalState?.naturalHeight === 1_088,
    durationMetricHidden: inspection.durationMetricHidden,
    durationValueEmpty: inspection.durationValueEmpty,
    previewDurationHidden: inspection.previewDurationHidden,
    resolutionIsHighVariant: inspection.resolutionText === '944×1088',
    titleLocalized: inspection.titleText === expectedTitle,
    previewUsesHighUrl:
      inspection.foregroundSrc === high.url &&
      inspection.foregroundCurrentSrc === high.url &&
      inspection.backgroundSrc === high.url,
    downloadUsesHighUrl:
      downloadMessage?.type === 'FACESCRAP_DOWNLOAD_DIRECT' &&
      downloadMessage?.url === high.url,
    downloadReceiptUsesHighUrl: downloadMessage?.receipt?.thumbUrl === high.url,
    imageQualitySelectorHidden: inspection.imageQualitySelectorHidden,
    formatIsJpg: inspection.formatIsJpg,
    noHorizontalOverflow: inspection.noHorizontalOverflow,
  };
  const screenshot = await page.command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(screenshot.data, 'base64');
  const dimensions = pngDimensions(bytes);
  checks.pngDimensionsExact =
    dimensions.width === VIEWPORT.width && dimensions.height === VIEWPORT.height;
  const filename = 'now-image.png';
  const path = join(QA_DIR, filename);
  await writeFile(path, bytes);
  return {
    surface: 'now-image',
    phase: 'high',
    checks,
    passed: Object.values(checks).every(Boolean),
    transition: {
      low: { storage: lowStorage, render: lowInspection },
      high: {
        ingress: highIngress,
        storage: highStorage,
        beforeImageLoad: highMetadataBeforeImageLoad,
        released: highRelease,
        loaded: highLoaded,
        final: finalState,
        download: qaDownloadProbe,
      },
    },
    lowCapture: {
      file: lowFilename,
      path: lowPath,
      width: lowDimensions.width,
      height: lowDimensions.height,
      bytes: lowBytes.length,
    },
    file: filename,
    path,
    ...dimensions,
    bytes: bytes.length,
  };
}

async function dismissPicker(page) {
  const key = {
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  };
  await page.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await page.command('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

async function captureOpenSelect(page, { surface, selectId, filename }) {
  await activateSurface(page, surface);
  const support = await evaluate(
    page,
    `(() => {
      const select = document.getElementById(${JSON.stringify(selectId)});
      return {
        customizableSelect: CSS.supports('appearance', 'base-select'),
        showPicker: select instanceof HTMLSelectElement && typeof select.showPicker === 'function',
      };
    })()`,
  );
  if (!support.customizableSelect || !support.showPicker) {
    throw new Error(`Browser does not expose the customizable select picker for #${selectId}: ${JSON.stringify(support)}`);
  }
  await waitForEvaluation(
    page,
    `(() => {
      const select = document.getElementById(${JSON.stringify(selectId)});
      return {
        ready:
          select instanceof HTMLSelectElement &&
          !select.disabled &&
          select.getClientRects().length > 0,
        hidden: select instanceof HTMLElement ? select.hidden : null,
        disabled: select instanceof HTMLSelectElement ? select.disabled : null,
        optionCount: select instanceof HTMLSelectElement ? select.options.length : 0,
        trackedTab: document.documentElement.dataset.trackedTab ?? '',
        nowContentHidden: document.querySelector('#now-content')?.hidden ?? null,
      };
    })()`,
    `rendered select #${selectId}`,
  );

  try {
    await evaluate(
      page,
      `(() => {
        const select = document.getElementById(${JSON.stringify(selectId)});
        if (!(select instanceof HTMLSelectElement)) throw new Error('Missing select #${selectId}');
        select.focus();
        select.showPicker();
      })()`,
    );
    await waitForEvaluation(
      page,
      `(() => {
        const select = document.getElementById(${JSON.stringify(selectId)});
        return { ready: select instanceof HTMLSelectElement && select.matches(':open') };
      })()`,
      `open picker for #${selectId}`,
    );
    await evaluate(page, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

    const inspection = await evaluate(
      page,
      `(() => {
        const select = document.getElementById(${JSON.stringify(selectId)});
        if (!(select instanceof HTMLSelectElement)) throw new Error('Missing select #${selectId}');
        const trigger = getComputedStyle(select);
        const picker = getComputedStyle(select, '::picker(select)');
        const radius = Number.parseFloat(picker.borderTopLeftRadius);
        const surfaceToken = getComputedStyle(document.documentElement).getPropertyValue(
          ${JSON.stringify(selectId)} === 'now-qselect' ? '--media-surface' : '--surface',
        ).trim();
        const probe = document.createElement('span');
        probe.style.backgroundColor = surfaceToken;
        document.body.append(probe);
        const expectedPickerBackground = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const checks = {
          pickerOpen: select.matches(':open'),
          triggerUsesBaseSelect: trigger.appearance === 'base-select',
          pickerUsesBaseSelect: picker.appearance === 'base-select',
          pickerRounded: Number.isFinite(radius) && radius >= 14,
          pickerUsesExpectedSurface: picker.backgroundColor === expectedPickerBackground,
          selectedValuePresent: select.selectedOptions.length === 1 && select.selectedOptions[0].textContent.trim().length > 0,
        };
        return {
          surface: ${JSON.stringify(surface)},
          selectId: ${JSON.stringify(selectId)},
          checks,
          passed: Object.values(checks).every(Boolean),
          metrics: {
            triggerAppearance: trigger.appearance,
            triggerDisplay: trigger.display,
            triggerAlignItems: trigger.alignItems,
            pickerAppearance: picker.appearance,
            pickerBackground: picker.backgroundColor,
            expectedPickerBackground,
            pickerBorderRadius: picker.borderTopLeftRadius,
            selectedText: select.selectedOptions[0]?.textContent?.trim() ?? '',
          },
        };
      })()`,
    );

    const screenshot = await page.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(screenshot.data, 'base64');
    const dimensions = pngDimensions(bytes);
    inspection.checks.pngDimensionsExact =
      dimensions.width === VIEWPORT.width && dimensions.height === VIEWPORT.height;
    inspection.passed = Object.values(inspection.checks).every(Boolean);
    const path = join(QA_DIR, filename);
    await writeFile(path, bytes);
    return { ...inspection, file: filename, path, ...dimensions, bytes: bytes.length };
  } finally {
    await dismissPicker(page).catch(() => undefined);
  }
}

async function captureSingleQualityOption(page, fixture, tabId) {
  const filename = 'now-quality-single-option.png';
  const mediaKey = `media_${tabId}`;
  const singleOptionItems = fixture.items.filter((item) => item.id !== 'fixture-main-720');
  let capture;
  let restoration;

  try {
    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(singleOptionItems)},
        });
      })()`,
    );
    await activateSurface(page, 'now');
    await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        return {
          ready:
            count instanceof HTMLElement &&
            count.hidden &&
            count.textContent.trim() === '' &&
            select instanceof HTMLSelectElement &&
            select.disabled &&
            select.options.length === 1 &&
            select.options[0]?.textContent?.trim() === '1080p',
        };
      })()`,
      'single-option Now Playing quality selector',
    );

    const inspection = await evaluate(
      page,
      `(() => {
        const visible = (element) => {
          if (!(element instanceof HTMLElement) || element.hidden) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        const quality = document.querySelector('#now-quality');
        if (!(select instanceof HTMLSelectElement)) throw new Error('Missing select #now-qselect');
        const style = getComputedStyle(select);
        const rect = select.getBoundingClientRect();
        const qualityRect = quality?.getBoundingClientRect();
        const labels = [...select.options].map((option) => option.textContent?.trim() ?? '');
        const checks = {
          qualityCountHiddenAndEmpty:
            count instanceof HTMLElement &&
            count.hidden &&
            count.textContent.trim() === '' &&
            !visible(count),
          qualitySelectDisabled: select.disabled,
          singleResolutionLabel:
            labels.length === 1 &&
            labels[0] === '1080p' &&
            select.selectedOptions[0]?.textContent?.trim() === '1080p',
          chevronHidden: style.backgroundImage === 'none',
          // The redesign makes the resolution field full width (level with the
          // download button) and 46px tall at the standard viewport — it still
          // collapses to 32px under the max-height:650px rule, checked separately.
          compactDimensions:
            Boolean(qualityRect) &&
            Math.abs(rect.width - qualityRect.width) <= 2 &&
            rect.width > 180 &&
            Math.abs(rect.height - 46) <= 2,
          viewportExact: innerWidth === ${VIEWPORT.width} && innerHeight === ${VIEWPORT.height},
        };
        return {
          surface: 'now-quality-single-option',
          checks,
          passed: Object.values(checks).every(Boolean),
          metrics: {
            countHidden: count instanceof HTMLElement ? count.hidden : null,
            countText: count?.textContent?.trim() ?? null,
            selectDisabled: select.disabled,
            optionCount: select.options.length,
            optionLabels: labels,
            selectedText: select.selectedOptions[0]?.textContent?.trim() ?? '',
            backgroundImage: style.backgroundImage,
            width: rect.width,
            height: rect.height,
          },
        };
      })()`,
    );
    const screenshot = await page.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(screenshot.data, 'base64');
    const dimensions = pngDimensions(bytes);
    inspection.checks.pngDimensionsExact =
      dimensions.width === VIEWPORT.width && dimensions.height === VIEWPORT.height;
    inspection.passed = Object.values(inspection.checks).every(Boolean);
    const path = join(QA_DIR, filename);
    await writeFile(path, bytes);
    capture = { ...inspection, file: filename, path, ...dimensions, bytes: bytes.length };
  } finally {
    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(fixture.items)},
        });
      })()`,
    );
    await activateSurface(page, 'now');
    restoration = await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        const labels =
          select instanceof HTMLSelectElement
            ? [...select.options].map((option) => option.textContent?.trim() ?? '')
            : [];
        return {
          ready:
            count instanceof HTMLElement &&
            !count.hidden &&
            count.textContent.trim() === '2' &&
            select instanceof HTMLSelectElement &&
            !select.disabled &&
            labels.length === 2 &&
            labels[0] === '1080p' &&
            labels[1] === '720p',
          countHidden: count instanceof HTMLElement ? count.hidden : null,
          countText: count?.textContent?.trim() ?? null,
          selectDisabled: select instanceof HTMLSelectElement ? select.disabled : null,
          optionLabels: labels,
        };
      })()`,
      'restored two-option Now Playing quality selector',
    );
  }

  if (!capture) throw new Error('Single-option quality capture did not complete');
  capture.restoration = restoration;
  capture.checks.fixtureRestored = restoration.ready === true;
  capture.passed = Object.values(capture.checks).every(Boolean);
  return capture;
}

async function captureCompactQualityScreenshot(page, { mode, filename }) {
  const multiple = mode === 'multiple';
  const inspection = await evaluate(
    page,
    `(() => {
      const count = document.querySelector('#now-qcount');
      const select = document.querySelector('#now-qselect');
      const quality = document.querySelector('#now-quality');
      const app = document.querySelector('#app');
      if (!(select instanceof HTMLSelectElement)) throw new Error('Missing select #now-qselect');
      const style = getComputedStyle(select);
      const rect = select.getBoundingClientRect();
      const qualityRect = quality?.getBoundingClientRect();
      const labels = [...select.options].map((option) => option.textContent?.trim() ?? '');
      const noHorizontalOverflow =
        document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
        document.body.scrollWidth <= document.body.clientWidth &&
        (!app || app.scrollWidth <= app.clientWidth) &&
        Boolean(
          qualityRect &&
          qualityRect.left >= -1 &&
          qualityRect.right <= innerWidth + 1 &&
          qualityRect.width <= innerWidth + 1,
        );
      const checks = {
        compactViewportExact: innerWidth === ${VIEWPORT.width} && innerHeight === 650,
        noHorizontalOverflow,
        qualityCountState: ${
          multiple
            ? `count instanceof HTMLElement &&
              !count.hidden &&
              count.textContent.trim() === '2'`
            : `count instanceof HTMLElement &&
              count.hidden &&
              count.textContent.trim() === ''`
        },
        qualitySelectState: ${
          multiple
            ? `!select.disabled &&
              labels.length === 2 &&
              labels[0] === '1080p' &&
              labels[1] === '720p'`
            : `select.disabled &&
              labels.length === 1 &&
              labels[0] === '1080p' &&
              select.selectedOptions[0]?.textContent?.trim() === '1080p'`
        },
        chevronState: ${multiple ? `style.backgroundImage !== 'none'` : `style.backgroundImage === 'none'`},
        compactDimensions:
          Boolean(qualityRect) &&
          Math.abs(rect.width - qualityRect.width) <= 2 &&
          rect.width > 180 &&
          Math.abs(rect.height - 32) <= 2,
      };
      return {
        surface: ${JSON.stringify(`now-quality-compact-${multiple ? 'two-options' : 'single-option'}`)},
        checks,
        passed: Object.values(checks).every(Boolean),
        metrics: {
          innerWidth,
          innerHeight,
          documentScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          appScrollWidth: app?.scrollWidth ?? null,
          countHidden: count instanceof HTMLElement ? count.hidden : null,
          countText: count?.textContent?.trim() ?? null,
          selectDisabled: select.disabled,
          optionCount: select.options.length,
          optionLabels: labels,
          selectedText: select.selectedOptions[0]?.textContent?.trim() ?? '',
          backgroundImage: style.backgroundImage,
          width: rect.width,
          height: rect.height,
          qualityLeft: qualityRect?.left ?? null,
          qualityRight: qualityRect?.right ?? null,
        },
      };
    })()`,
  );
  const screenshot = await page.command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(screenshot.data, 'base64');
  const dimensions = pngDimensions(bytes);
  inspection.checks.pngDimensionsExact =
    dimensions.width === VIEWPORT.width && dimensions.height === 650;
  inspection.passed = Object.values(inspection.checks).every(Boolean);
  const path = join(QA_DIR, filename);
  await writeFile(path, bytes);
  return { ...inspection, file: filename, path, ...dimensions, bytes: bytes.length };
}

async function captureCompactQualityStates(page, fixture, tabId) {
  const mediaKey = `media_${tabId}`;
  const singleOptionItems = fixture.items.filter((item) => item.id !== 'fixture-main-720');
  const compactViewport = Object.freeze({ ...VIEWPORT, height: 650 });
  let multiple;
  let single;
  let restoration;

  try {
    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(fixture.items)},
        });
      })()`,
    );
    await setViewport(page, compactViewport);
    await activateSurface(page, 'now');
    await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        return {
          ready:
            innerWidth === ${VIEWPORT.width} &&
            innerHeight === 650 &&
            count instanceof HTMLElement &&
            !count.hidden &&
            count.textContent.trim() === '2' &&
            select instanceof HTMLSelectElement &&
            !select.disabled &&
            select.options.length === 2,
        };
      })()`,
      'compact two-option Now Playing quality selector',
    );
    multiple = await captureCompactQualityScreenshot(page, {
      mode: 'multiple',
      filename: 'now-quality-compact-two-options.png',
    });

    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(singleOptionItems)},
        });
      })()`,
    );
    await activateSurface(page, 'now');
    await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        return {
          ready:
            innerWidth === ${VIEWPORT.width} &&
            innerHeight === 650 &&
            count instanceof HTMLElement &&
            count.hidden &&
            count.textContent.trim() === '' &&
            select instanceof HTMLSelectElement &&
            select.disabled &&
            select.options.length === 1,
        };
      })()`,
      'compact single-option Now Playing quality selector',
    );
    single = await captureCompactQualityScreenshot(page, {
      mode: 'single',
      filename: 'now-quality-compact-single-option.png',
    });
  } finally {
    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(fixture.items)},
        });
      })()`,
    );
    await setViewport(page, VIEWPORT);
    await activateSurface(page, 'now');
    restoration = await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        const labels =
          select instanceof HTMLSelectElement
            ? [...select.options].map((option) => option.textContent?.trim() ?? '')
            : [];
        return {
          ready:
            innerWidth === ${VIEWPORT.width} &&
            innerHeight === ${VIEWPORT.height} &&
            count instanceof HTMLElement &&
            !count.hidden &&
            count.textContent.trim() === '2' &&
            select instanceof HTMLSelectElement &&
            !select.disabled &&
            labels.length === 2 &&
            labels[0] === '1080p' &&
            labels[1] === '720p',
          innerWidth,
          innerHeight,
          countHidden: count instanceof HTMLElement ? count.hidden : null,
          countText: count?.textContent?.trim() ?? null,
          selectDisabled: select instanceof HTMLSelectElement ? select.disabled : null,
          optionLabels: labels,
        };
      })()`,
      'restored normal viewport and two-option quality fixture',
    );
  }

  if (!multiple || !single) throw new Error('Compact quality captures did not complete');
  const checks = {
    multipleOptionsPassed: multiple.passed,
    singleOptionPassed: single.passed,
    fixtureAndViewportRestored: restoration.ready === true,
  };
  return {
    surface: 'now-quality-compact',
    checks,
    passed: Object.values(checks).every(Boolean),
    captures: { multiple, single },
    restoration,
  };
}

async function captureFocusedClosedQualityTransition(page, fixture, tabId) {
  const filename = 'now-quality-focused-closed-transition.png';
  const mediaKey = `media_${tabId}`;
  const singleOptionItems = fixture.items.filter((item) => item.id !== 'fixture-main-720');
  let capture;
  let restoration;

  try {
    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(fixture.items)},
        });
      })()`,
    );
    await activateSurface(page, 'now');
    await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        return {
          ready:
            count instanceof HTMLElement &&
            !count.hidden &&
            count.textContent.trim() === '2' &&
            select instanceof HTMLSelectElement &&
            !select.disabled &&
            select.options.length === 2,
        };
      })()`,
      'two-option selector before the focused-closed transition',
    );
    const focusedClosed = await evaluate(
      page,
      `(() => {
        const select = document.querySelector('#now-qselect');
        if (!(select instanceof HTMLSelectElement)) throw new Error('Missing select #now-qselect');
        select.focus({ preventScroll: true });
        return {
          focused: document.activeElement === select,
          open: select.matches(':open'),
          disabled: select.disabled,
          optionCount: select.options.length,
        };
      })()`,
    );
    if (
      focusedClosed.focused !== true ||
      focusedClosed.open !== false ||
      focusedClosed.disabled !== false ||
      focusedClosed.optionCount !== 2
    ) {
      throw new Error(`Could not establish focused-closed quality state: ${JSON.stringify(focusedClosed)}`);
    }

    const transitionStartedAt = Date.now();
    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(singleOptionItems)},
        });
      })()`,
    );
    const transition = await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        if (!(select instanceof HTMLSelectElement)) {
          return { ready: false, reason: 'missing-select' };
        }
        const labels = [...select.options].map((option) => option.textContent?.trim() ?? '');
        const backgroundImage = getComputedStyle(select).backgroundImage;
        return {
          ready:
            count instanceof HTMLElement &&
            count.hidden &&
            count.textContent.trim() === '' &&
            select.disabled &&
            labels.length === 1 &&
            labels[0] === '1080p' &&
            backgroundImage === 'none',
          countHidden: count instanceof HTMLElement ? count.hidden : null,
          countText: count?.textContent?.trim() ?? null,
          selectDisabled: select.disabled,
          optionLabels: labels,
          backgroundImage,
          activeElementId: document.activeElement?.id ?? '',
        };
      })()`,
      'focused but closed quality selector to accept the single-option storage update',
      FOCUSED_CLOSED_TIMEOUT_MS,
    );
    const elapsedMs = Date.now() - transitionStartedAt;
    const screenshot = await page.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(screenshot.data, 'base64');
    const dimensions = pngDimensions(bytes);
    const checks = {
      focusedClosedBeforeMutation:
        focusedClosed.focused === true &&
        focusedClosed.open === false &&
        focusedClosed.disabled === false &&
        focusedClosed.optionCount === 2,
      updatedWithinFocusedClosedTimeout:
        transition.ready === true && elapsedMs <= FOCUSED_CLOSED_TIMEOUT_MS,
      qualityCountHiddenAndEmpty:
        transition.countHidden === true && transition.countText === '',
      qualitySelectDisabled: transition.selectDisabled === true,
      singleResolutionLabel:
        transition.optionLabels.length === 1 && transition.optionLabels[0] === '1080p',
      chevronHidden: transition.backgroundImage === 'none',
      pngDimensionsExact:
        dimensions.width === VIEWPORT.width && dimensions.height === VIEWPORT.height,
    };
    const path = join(QA_DIR, filename);
    await writeFile(path, bytes);
    capture = {
      surface: 'now-quality-focused-closed-transition',
      checks,
      passed: Object.values(checks).every(Boolean),
      focusedClosed,
      transition: { ...transition, elapsedMs, timeoutMs: FOCUSED_CLOSED_TIMEOUT_MS },
      file: filename,
      path,
      ...dimensions,
      bytes: bytes.length,
    };
  } finally {
    await evaluate(
      page,
      `(async () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(fixture.items)},
        });
      })()`,
    );
    await activateSurface(page, 'now');
    restoration = await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        const labels =
          select instanceof HTMLSelectElement
            ? [...select.options].map((option) => option.textContent?.trim() ?? '')
            : [];
        return {
          ready:
            count instanceof HTMLElement &&
            !count.hidden &&
            count.textContent.trim() === '2' &&
            select instanceof HTMLSelectElement &&
            !select.disabled &&
            labels.length === 2 &&
            labels[0] === '1080p' &&
            labels[1] === '720p' &&
            document.activeElement?.id !== 'now-qselect',
          countHidden: count instanceof HTMLElement ? count.hidden : null,
          countText: count?.textContent?.trim() ?? null,
          selectDisabled: select instanceof HTMLSelectElement ? select.disabled : null,
          optionLabels: labels,
          activeElementId: document.activeElement?.id ?? '',
        };
      })()`,
      'restored two-option fixture after the focused-closed transition',
    );
  }

  if (!capture) throw new Error('Focused-closed quality transition capture did not complete');
  capture.restoration = restoration;
  capture.checks.fixtureRestored = restoration.ready === true;
  capture.passed = Object.values(capture.checks).every(Boolean);
  return capture;
}

async function captureForcedFallbackQualityTransition(page, fixture, tabId) {
  const filename = 'now-quality-forced-fallback-transition.png';
  const mediaKey = `media_${tabId}`;
  const singleOptionItems = fixture.items.filter((item) => item.id !== 'fixture-main-720');
  const probeKey = '__facescrapQaQualityMatchesProbe';
  let capture;
  let restoration;

  try {
    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(fixture.items)},
        });
      })()`,
    );
    await activateSurface(page, 'now');
    await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        return {
          ready:
            count instanceof HTMLElement &&
            !count.hidden &&
            count.textContent.trim() === '2' &&
            select instanceof HTMLSelectElement &&
            !select.disabled &&
            select.options.length === 2,
        };
      })()`,
      'two-option selector before the forced fallback transition',
    );
    const fallbackArmed = await evaluate(
      page,
      `(() => {
        const select = document.querySelector('#now-qselect');
        if (!(select instanceof HTMLSelectElement)) throw new Error('Missing select #now-qselect');
        const probe = {
          select,
          ownDescriptor: Object.getOwnPropertyDescriptor(select, 'matches'),
          openMatchThrowCount: 0,
          pointerdownDispatchCount: 0,
        };
        Object.defineProperty(select, 'matches', {
          configurable: true,
          value(selector) {
            if (selector === ':open') {
              probe.openMatchThrowCount += 1;
              throw new Error('FaceScrap QA forced :open fallback');
            }
            return Element.prototype.matches.call(this, selector);
          },
        });
        globalThis[${JSON.stringify(probeKey)}] = probe;
        select.focus({ preventScroll: true });
        select.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerType: 'mouse',
          }),
        );
        probe.pointerdownDispatchCount += 1;
        return {
          focused: document.activeElement === select,
          ownMatchesInstalled: Object.hasOwn(select, 'matches'),
          pointerdownDispatchCount: probe.pointerdownDispatchCount,
          openMatchThrowCount: probe.openMatchThrowCount,
          disabled: select.disabled,
          optionCount: select.options.length,
        };
      })()`,
    );
    if (
      fallbackArmed.focused !== true ||
      fallbackArmed.ownMatchesInstalled !== true ||
      fallbackArmed.pointerdownDispatchCount !== 1 ||
      fallbackArmed.openMatchThrowCount !== 0 ||
      fallbackArmed.disabled !== false ||
      fallbackArmed.optionCount !== 2
    ) {
      throw new Error(`Could not arm the forced quality fallback: ${JSON.stringify(fallbackArmed)}`);
    }

    const transitionStartedAt = Date.now();
    await evaluate(
      page,
      `(async () => {
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(singleOptionItems)},
        });
      })()`,
    );
    const transition = await waitForEvaluation(
      page,
      `(() => {
        const probe = globalThis[${JSON.stringify(probeKey)}];
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        if (!(select instanceof HTMLSelectElement)) {
          return {
            ready: false,
            reason: 'missing-select',
            openMatchThrowCount: probe?.openMatchThrowCount ?? 0,
          };
        }
        const labels = [...select.options].map((option) => option.textContent?.trim() ?? '');
        const backgroundImage = getComputedStyle(select).backgroundImage;
        return {
          ready:
            probe?.openMatchThrowCount > 0 &&
            count instanceof HTMLElement &&
            count.hidden &&
            count.textContent.trim() === '' &&
            select.disabled &&
            labels.length === 1 &&
            labels[0] === '1080p' &&
            backgroundImage === 'none',
          openMatchThrowCount: probe?.openMatchThrowCount ?? 0,
          pointerdownDispatchCount: probe?.pointerdownDispatchCount ?? 0,
          countHidden: count instanceof HTMLElement ? count.hidden : null,
          countText: count?.textContent?.trim() ?? null,
          selectDisabled: select.disabled,
          optionLabels: labels,
          backgroundImage,
          activeElementId: document.activeElement?.id ?? '',
        };
      })()`,
      'forced legacy fallback to release and apply the single-option storage update',
      FORCED_FALLBACK_TIMEOUT_MS,
    );
    const elapsedMs = Date.now() - transitionStartedAt;
    const screenshot = await page.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(screenshot.data, 'base64');
    const dimensions = pngDimensions(bytes);
    const checks = {
      fallbackArmedWithOneGesture:
        fallbackArmed.focused === true &&
        fallbackArmed.ownMatchesInstalled === true &&
        fallbackArmed.pointerdownDispatchCount === 1 &&
        fallbackArmed.openMatchThrowCount === 0,
      forcedCatchObserved:
        transition.openMatchThrowCount > 0 &&
        transition.pointerdownDispatchCount === 1,
      updatedWithinForcedFallbackTimeout:
        transition.ready === true && elapsedMs <= FORCED_FALLBACK_TIMEOUT_MS,
      qualityCountHiddenAndEmpty:
        transition.countHidden === true && transition.countText === '',
      qualitySelectDisabled: transition.selectDisabled === true,
      singleResolutionLabel:
        transition.optionLabels.length === 1 && transition.optionLabels[0] === '1080p',
      chevronHidden: transition.backgroundImage === 'none',
      pngDimensionsExact:
        dimensions.width === VIEWPORT.width && dimensions.height === VIEWPORT.height,
    };
    const path = join(QA_DIR, filename);
    await writeFile(path, bytes);
    capture = {
      surface: 'now-quality-forced-fallback-transition',
      checks,
      passed: Object.values(checks).every(Boolean),
      fallbackArmed,
      transition: { ...transition, elapsedMs, timeoutMs: FORCED_FALLBACK_TIMEOUT_MS },
      file: filename,
      path,
      ...dimensions,
      bytes: bytes.length,
    };
  } finally {
    await evaluate(
      page,
      `(async () => {
        const probeKey = ${JSON.stringify(probeKey)};
        const probe = globalThis[probeKey];
        if (probe?.select instanceof HTMLSelectElement) {
          if (probe.ownDescriptor) {
            Object.defineProperty(probe.select, 'matches', probe.ownDescriptor);
          } else {
            delete probe.select.matches;
          }
        }
        delete globalThis[probeKey];
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        await chrome.storage.session.set({
          ${JSON.stringify(mediaKey)}: ${JSON.stringify(fixture.items)},
        });
      })()`,
    );
    await activateSurface(page, 'now');
    restoration = await waitForEvaluation(
      page,
      `(() => {
        const count = document.querySelector('#now-qcount');
        const select = document.querySelector('#now-qselect');
        const labels =
          select instanceof HTMLSelectElement
            ? [...select.options].map((option) => option.textContent?.trim() ?? '')
            : [];
        return {
          ready:
            globalThis[${JSON.stringify(probeKey)}] === undefined &&
            count instanceof HTMLElement &&
            !count.hidden &&
            count.textContent.trim() === '2' &&
            select instanceof HTMLSelectElement &&
            !select.disabled &&
            labels.length === 2 &&
            labels[0] === '1080p' &&
            labels[1] === '720p' &&
            document.activeElement?.id !== 'now-qselect',
          probeRemoved: globalThis[${JSON.stringify(probeKey)}] === undefined,
          countHidden: count instanceof HTMLElement ? count.hidden : null,
          countText: count?.textContent?.trim() ?? null,
          selectDisabled: select instanceof HTMLSelectElement ? select.disabled : null,
          optionLabels: labels,
          activeElementId: document.activeElement?.id ?? '',
        };
      })()`,
      'restored two-option fixture and native matches after the forced fallback transition',
    );
  }

  if (!capture) throw new Error('Forced fallback quality transition capture did not complete');
  capture.restoration = restoration;
  capture.checks.fixtureAndMatchesRestored = restoration.ready === true;
  capture.passed = Object.values(capture.checks).every(Boolean);
  return capture;
}

async function openPageTarget(browser, port, url, description, evidence, context) {
  const target = await browser.command('Target.createTarget', { url, background: false });
  await browser.command('Target.activateTarget', { targetId: target.targetId });
  const lookup = await pollJsonList(
    port,
    (candidate) => candidate.id === target.targetId && Boolean(candidate.webSocketDebuggerUrl),
    description,
  );
  const client = await CdpSocket.connect(lookup.found.webSocketDebuggerUrl);
  attachEvidenceListeners(client, evidence, context);
  await enableEvidenceDomains(client);
  await client.command('Page.enable');
  return {
    client,
    target: { id: lookup.found.id, type: lookup.found.type, title: lookup.found.title, url: lookup.found.url },
  };
}

function trackExecutionContexts(client) {
  const contexts = new Map();
  client.on('Runtime.executionContextCreated', ({ context }) => {
    if (context && Number.isInteger(context.id)) contexts.set(context.id, context);
  });
  client.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    contexts.delete(executionContextId);
  });
  client.on('Runtime.executionContextsCleared', () => {
    contexts.clear();
  });
  return contexts;
}

async function openSyntheticFacebookPage(browser, port, evidence) {
  const url = 'https://www.facebook.com/facescrap-theme-qa';
  const target = await browser.command('Target.createTarget', { url: 'about:blank', background: false });
  await browser.command('Target.activateTarget', { targetId: target.targetId });
  const lookup = await pollJsonList(
    port,
    (candidate) => candidate.id === target.targetId && Boolean(candidate.webSocketDebuggerUrl),
    'the synthetic Facebook theme target',
  );
  const client = await CdpSocket.connect(lookup.found.webSocketDebuggerUrl);
  attachEvidenceListeners(client, evidence, 'synthetic-facebook');
  const executionContexts = trackExecutionContexts(client);
  await enableEvidenceDomains(client);
  await client.command('Page.enable');

  const html = `<!doctype html>
<html style="background-color: rgb(250, 250, 250)">
<head><meta charset="utf-8"><title>FaceScrap theme QA</title></head>
<body style="margin: 0; background-color: rgb(250, 250, 250)">
<main style="min-height: 100vh; background-color: rgb(250, 250, 250)">FaceScrap theme QA</main>
</body>
</html>`;
  let resolveFulfilled;
  let rejectFulfilled;
  const fulfilled = new Promise((resolveRequest, rejectRequest) => {
    resolveFulfilled = resolveRequest;
    rejectFulfilled = rejectRequest;
  });
  const requestHandler = (params) => {
    if (params.resourceType !== 'Document' || params.request.url !== url) {
      void client.command('Fetch.continueRequest', { requestId: params.requestId }).catch(rejectFulfilled);
      return;
    }
    void client
      .command('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'X-Content-Type-Options', value: 'nosniff' },
        ],
        body: Buffer.from(html).toString('base64'),
      })
      .then(resolveFulfilled, rejectFulfilled);
  };
  client.on('Fetch.requestPaused', requestHandler);
  await client.command('Fetch.enable', {
    patterns: [{ urlPattern: url, resourceType: 'Document', requestStage: 'Request' }],
  });
  const navigation = await client.command('Page.navigate', { url });
  if (navigation.errorText) throw new Error(`Could not open the synthetic Facebook page: ${navigation.errorText}`);
  await Promise.race([
    fulfilled,
    delay(ACTION_TIMEOUT_MS).then(() => {
      throw new Error('Timed out fulfilling the synthetic Facebook document');
    }),
  ]);
  await client.command('Fetch.disable');
  client.off('Fetch.requestPaused', requestHandler);
  await waitForEvaluation(
    client,
    `(() => ({
      ready:
        location.href === ${JSON.stringify(url)} &&
        document.readyState === 'complete' &&
        document.querySelector('main')?.textContent === 'FaceScrap theme QA',
      url: location.href,
      readyState: document.readyState,
    }))()`,
    'the network-free synthetic Facebook document',
  );
  return {
    client,
    executionContexts,
    url,
    target: { id: lookup.found.id, type: lookup.found.type, url },
    transport: 'CDP Fetch fulfilled main document; no Facebook network dependency',
  };
}

async function reloadSyntheticFacebookDocument(facebookPage, url) {
  const html = `<!doctype html>
<html style="background-color: rgb(250, 250, 250)">
<head><meta charset="utf-8"><title>FaceScrap runtime reload QA</title></head>
<body style="margin: 0; background-color: rgb(250, 250, 250)">
<main style="min-height: 100vh; background-color: rgb(250, 250, 250)">FaceScrap runtime reload QA</main>
</body>
</html>`;
  let resolveFulfilled;
  let rejectFulfilled;
  const fulfilled = new Promise((resolveRequest, rejectRequest) => {
    resolveFulfilled = resolveRequest;
    rejectFulfilled = rejectRequest;
  });
  const requestHandler = (params) => {
    if (params.resourceType !== 'Document' || params.request.url !== url) {
      void facebookPage.command('Fetch.continueRequest', { requestId: params.requestId }).catch(rejectFulfilled);
      return;
    }
    void facebookPage
      .command('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'X-Content-Type-Options', value: 'nosniff' },
        ],
        body: Buffer.from(html).toString('base64'),
      })
      .then(resolveFulfilled, rejectFulfilled);
  };
  facebookPage.on('Fetch.requestPaused', requestHandler);
  await facebookPage.command('Fetch.enable', {
    patterns: [{ urlPattern: url, resourceType: 'Document', requestStage: 'Request' }],
  });
  try {
    const navigation = await facebookPage.command('Page.navigate', { url });
    if (navigation.errorText) {
      throw new Error(`Could not restore the synthetic Facebook page for runtime reload QA: ${navigation.errorText}`);
    }
    await Promise.race([
      fulfilled,
      delay(ACTION_TIMEOUT_MS).then(() => {
        throw new Error('Timed out fulfilling the runtime reload synthetic Facebook document');
      }),
    ]);
    return waitForEvaluation(
      facebookPage,
      `(() => ({
        ready:
          location.href === ${JSON.stringify(url)} &&
          document.readyState === 'complete' &&
          document.querySelector('main')?.textContent === 'FaceScrap runtime reload QA',
        url: location.href,
        readyState: document.readyState,
      }))()`,
      'the network-free runtime reload Facebook document',
    );
  } finally {
    await facebookPage.command('Fetch.disable').catch(() => undefined);
    facebookPage.off('Fetch.requestPaused', requestHandler);
  }
}

async function waitForExtensionContentScriptContext(
  executionContexts,
  extensionId,
  excludedContextIds = new Set(),
) {
  const expectedOrigin = `chrome-extension://${extensionId}`;
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let observed = [];
  while (Date.now() < deadline) {
    observed = [...executionContexts.values()];
    const context = observed.find(
      (candidate) =>
        !excludedContextIds.has(candidate.id) &&
        (candidate.origin === expectedOrigin || candidate.origin === `${expectedOrigin}/`) &&
        candidate.auxData?.type === 'isolated' &&
        candidate.auxData?.isDefault !== true,
    );
    if (context) return context;
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for FaceScrap's isolated content-script execution context (${expectedOrigin}); ` +
      `observed=${JSON.stringify(
        observed.map(({ id, origin, name, auxData }) => ({ id, origin, name, auxData })),
      )}`,
  );
}

async function captureHighImageThroughSyntheticDom(
  facebookPage,
  executionContexts,
  extensionId,
  item,
  requiredContextId,
) {
  const context =
    requiredContextId == null
      ? await waitForExtensionContentScriptContext(executionContexts, extensionId)
      : executionContexts.get(requiredContextId);
  if (!context) {
    throw new Error(`Required synthetic content-script context ${requiredContextId} is no longer registered`);
  }
  const contentContext = await evaluateInExecutionContext(
    facebookPage,
    context.id,
    `(() => ({
      runtimeId: chrome.runtime?.id ?? null,
      url: location.href,
      documentReady: document.readyState === 'complete',
    }))()`,
  );
  if (contentContext?.runtimeId !== extensionId || contentContext?.documentReady !== true) {
    throw new Error(`Synthetic content-script context is not ready for DOM image capture: ${JSON.stringify(contentContext)}`);
  }

  let resolveFulfilled;
  let rejectFulfilled;
  const fulfilled = new Promise((resolveRequest, rejectRequest) => {
    resolveFulfilled = resolveRequest;
    rejectFulfilled = rejectRequest;
  });
  const requestHandler = (params) => {
    if (params.resourceType !== 'Image' || params.request.url !== item.url) {
      void facebookPage.command('Fetch.continueRequest', { requestId: params.requestId }).catch(rejectFulfilled);
      return;
    }
    void facebookPage
      .command('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'image/svg+xml; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(fixtureImageSvg(item.url)).toString('base64'),
      })
      .then(
        () =>
          resolveFulfilled({
            url: params.request.url,
            resourceType: params.resourceType,
            responseCode: 200,
            cacheControl: 'no-store',
          }),
        rejectFulfilled,
      );
  };
  facebookPage.on('Fetch.requestPaused', requestHandler);
  await facebookPage.command('Fetch.enable', {
    patterns: [{ urlPattern: '*://*.fbcdn.net/*_qa_variant=high*', resourceType: 'Image', requestStage: 'Request' }],
  });
  try {
    const inserted = await evaluate(
      facebookPage,
      `(() => {
        document.querySelector('#facescrap-qa-high-image')?.remove();
        const image = document.createElement('img');
        image.id = 'facescrap-qa-high-image';
        image.alt = 'FaceScrap synthetic HIGH capture';
        image.decoding = 'sync';
        image.src = ${JSON.stringify(item.url)};
        document.body.append(image);
        return {
          inserted: image.isConnected,
          src: image.getAttribute('src'),
          elementType: image.constructor.name,
        };
      })()`,
    );
    const request = await Promise.race([
      fulfilled,
      delay(ACTION_TIMEOUT_MS).then(() => {
        throw new Error('Timed out fulfilling the synthetic HIGH image request');
      }),
    ]);
    const loaded = await waitForEvaluation(
      facebookPage,
      `(() => {
        const image = document.querySelector('#facescrap-qa-high-image');
        return {
          ready:
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth === 944 &&
            image.naturalHeight === 1088 &&
            image.currentSrc === ${JSON.stringify(item.url)},
          complete: image instanceof HTMLImageElement ? image.complete : null,
          currentSrc: image instanceof HTMLImageElement ? image.currentSrc : null,
          naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
        };
      })()`,
      'the synthetic Facebook HIGH image load event',
    );
    return {
      transport:
        'MAIN-world HTMLImageElement load -> content.ts capture listener -> MEDIA_FOUND -> service-worker addMedia/mergeMedia',
      context: {
        id: context.id,
        origin: context.origin,
        name: context.name,
        auxData: context.auxData,
      },
      contentContext,
      inserted,
      request,
      loaded,
    };
  } finally {
    await facebookPage.command('Fetch.disable').catch(() => undefined);
    facebookPage.off('Fetch.requestPaused', requestHandler);
  }
}

function runtimeReloadStorageExpression(tabId, recoveryUrl, waitForRecovery) {
  return `(async () => {
    const mediaKey = ${JSON.stringify(`media_${tabId}`)};
    const media = (await chrome.storage.session.get(mediaKey))[mediaKey] ?? [];
    const matches = media.filter((item) => item?.url === ${JSON.stringify(recoveryUrl)});
    return {
      ready: ${waitForRecovery ? 'matches.length === 1' : 'true'},
      mediaKey,
      mediaCount: media.length,
      matchingCount: matches.length,
      matching: matches,
      urls: media.map((item) => item?.url).filter(Boolean),
    };
  })()`;
}

function summarizeExecutionContext(context) {
  return {
    id: context.id,
    uniqueId: context.uniqueId ?? null,
    origin: context.origin,
    name: context.name,
    auxData: context.auxData,
  };
}

async function waitForLiveExtensionContentScriptContext(
  facebookPage,
  executionContexts,
  extensionId,
  excludedContextIds = new Set(),
) {
  const expectedOrigin = `chrome-extension://${extensionId}`;
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let observed = [];
  let lastProbe;
  while (Date.now() < deadline) {
    observed = [...executionContexts.values()].filter(
      (candidate) =>
        !excludedContextIds.has(candidate.id) &&
        (candidate.origin === expectedOrigin || candidate.origin === `${expectedOrigin}/`) &&
        candidate.auxData?.type === 'isolated' &&
        candidate.auxData?.isDefault !== true,
    );
    for (const context of observed) {
      try {
        const contentContext = await evaluateInExecutionContext(
          facebookPage,
          context.id,
          `(() => ({
            runtimeId: chrome.runtime?.id ?? null,
            url: location.href,
            documentReady: document.readyState === 'complete',
          }))()`,
        );
        lastProbe = { contextId: context.id, contentContext };
        if (
          contentContext?.runtimeId === extensionId &&
          contentContext?.documentReady === true
        ) {
          return { context, contentContext };
        }
      } catch (error) {
        lastProbe = { contextId: context.id, error: errorText(error) };
      }
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for a live FaceScrap isolated context (${expectedOrigin}); ` +
      `excluded=${JSON.stringify([...excludedContextIds])}; ` +
      `observed=${JSON.stringify(observed.map(summarizeExecutionContext))}; ` +
      `lastProbe=${JSON.stringify(lastProbe)}`,
  );
}

async function waitForReloadedServiceWorker(port, extensionId, reloadMarker) {
  const expectedUrl = `chrome-extension://${extensionId}/service-worker.js`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError;
  let lastProbe;
  let targets = [];
  while (Date.now() < deadline) {
    let candidateClient;
    try {
      targets = await requestJson(port, '/json/list');
      const candidate = targets.find(
        (target) =>
          target.type === 'service_worker' &&
          target.url === expectedUrl &&
          Boolean(target.webSocketDebuggerUrl),
      );
      if (!candidate) {
        await delay(100);
        continue;
      }
      // Brave can reuse both the target id and WebSocket URL while replacing
      // the worker execution context. Probe through a fresh short-lived socket
      // instead of assuming a new target id as Edge currently does.
      candidateClient = await CdpSocket.connect(candidate.webSocketDebuggerUrl, 1_500);
      const probe = await evaluate(
        candidateClient,
        `(() => ({
          runtimeId: chrome.runtime?.id ?? null,
          reloadMarker: globalThis.__facescrapQaReloadMarker ?? null,
        }))()`,
      );
      lastProbe = probe;
      if (probe?.runtimeId === extensionId && probe?.reloadMarker !== reloadMarker) {
        return { client: candidateClient, target: candidate, probe, targets };
      }
    } catch (error) {
      lastError = error;
    }
    candidateClient?.close();
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for the reloaded FaceScrap service-worker runtime; ` +
      `lastProbe=${JSON.stringify(lastProbe)}; targets=${JSON.stringify(
        targets.map((target) => ({ id: target.id, type: target.type, url: target.url })),
      )}${lastError ? `; last error=${errorText(lastError)}` : ''}`,
  );
}

async function verifyRuntimeReloadRecovery({
  browser,
  port,
  worker,
  facebookPage,
  executionContexts,
  extensionId,
  facebookTarget,
  facebookUrl,
  tabId,
  fixture,
  evidence,
}) {
  const restoredDocument = await reloadSyntheticFacebookDocument(facebookPage, facebookUrl);
  await browser.command('Target.activateTarget', { targetId: facebookTarget.id });

  const beforeLiveContext = await waitForLiveExtensionContentScriptContext(
    facebookPage,
    executionContexts,
    extensionId,
  );
  const beforeContext = beforeLiveContext.context;
  const beforeContentContext = beforeLiveContext.contentContext;
  const registeredBeforeContextIds = new Set(
    [...executionContexts.values()]
      .filter(
        (context) =>
          context.auxData?.type === 'isolated' &&
          (context.origin === `chrome-extension://${extensionId}` ||
            context.origin === `chrome-extension://${extensionId}/`),
      )
      .map((context) => context.id),
  );
  const workerLookup = await pollJsonList(
    port,
    (target) =>
      target.type === 'service_worker' &&
      target.url === `chrome-extension://${extensionId}/service-worker.js` &&
      Boolean(target.webSocketDebuggerUrl),
    'the pre-reload FaceScrap service worker',
  );
  const beforeWorkerTarget = workerLookup.found;
  if (!worker || worker.closed) {
    worker = await CdpSocket.connect(beforeWorkerTarget.webSocketDebuggerUrl);
    attachEvidenceListeners(worker, evidence, 'service-worker-reload-before');
    await enableEvidenceDomains(worker);
  }

  const recoveryItem = {
    ...fixture.imageVariant.high,
    id: `qa-runtime-reload-${tabId}`,
    url:
      `https://scontent-mia3-2.xx.fbcdn.net/v/t39.30808-6/qa-runtime-reload-${tabId}_n.jpg` +
      '?stp=dst-jpg_p944x1088&oh=qa-runtime-reload&oe=3&_qa_variant=high&_qa_runtime_reload=1',
    addedAt: Date.now(),
  };
  const beforeStorage = await evaluate(
    worker,
    runtimeReloadStorageExpression(tabId, recoveryItem.url, false),
  );
  const reloadMarker = `facescrap-qa-${Date.now()}-${randomBytes(8).toString('hex')}`;
  const reloadInvocation = await evaluate(
    worker,
    `(() => {
      const runtimeId = chrome.runtime.id;
      globalThis.__facescrapQaReloadMarker = ${JSON.stringify(reloadMarker)};
      setTimeout(() => chrome.runtime.reload(), 0);
      return {
        requested: true,
        invokedFrom: 'service-worker',
        runtimeId,
        reloadMarker: ${JSON.stringify(reloadMarker)},
        method: 'chrome.runtime.reload()',
      };
    })()`,
  );
  // The old CDP socket can remain open but commandless in Brave after reload.
  // Closing it lets the harness attach cleanly to the replacement runtime even
  // when the browser deliberately reuses the same target id and debugger URL.
  worker.close();
  const reloadedWorker = await waitForReloadedServiceWorker(
    port,
    extensionId,
    reloadMarker,
  );
  const afterWorkerTarget = reloadedWorker.target;
  const afterWorker = reloadedWorker.client;
  attachEvidenceListeners(afterWorker, evidence, 'service-worker-reload-after');
  await enableEvidenceDomains(afterWorker);

  const afterLiveContext = await waitForLiveExtensionContentScriptContext(
    facebookPage,
    executionContexts,
    extensionId,
    registeredBeforeContextIds,
  );
  const afterContext = afterLiveContext.context;
  const afterContentContext = afterLiveContext.contentContext;
  const ingress = await captureHighImageThroughSyntheticDom(
    facebookPage,
    executionContexts,
    extensionId,
    recoveryItem,
    afterContext.id,
  );
  const afterStorage = await waitForEvaluation(
    afterWorker,
    runtimeReloadStorageExpression(tabId, recoveryItem.url, true),
    'MEDIA_FOUND from the recovered content script to update storage after runtime reload',
  );
  const finalTab = await evaluate(
    afterWorker,
    `(async () => {
      const tab = await chrome.tabs.get(${JSON.stringify(tabId)});
      return { id: tab.id, url: tab.url, status: tab.status };
    })()`,
  );
  const before = {
    serviceWorker: {
      id: beforeWorkerTarget.id,
      type: beforeWorkerTarget.type,
      url: beforeWorkerTarget.url,
    },
    isolatedContext: summarizeExecutionContext(beforeContext),
    registeredIsolatedContextIds: [...registeredBeforeContextIds],
    contentContext: beforeContentContext,
    storage: beforeStorage,
  };
  const after = {
    serviceWorker: {
      id: afterWorkerTarget.id,
      type: afterWorkerTarget.type,
      url: afterWorkerTarget.url,
      targetReused: afterWorkerTarget.id === beforeWorkerTarget.id,
      runtimeProbe: reloadedWorker.probe,
    },
    isolatedContext: summarizeExecutionContext(afterContext),
    contentContext: afterContentContext,
    storage: afterStorage,
  };
  const checks = {
    reloadRequestedFromServiceWorker:
      reloadInvocation?.requested === true && reloadInvocation?.invokedFrom === 'service-worker',
    facebookTabStayedOpen:
      finalTab?.id === tabId && finalTab?.url === facebookUrl && finalTab?.status === 'complete',
    newServiceWorker:
      after.serviceWorker.runtimeProbe?.runtimeId === extensionId &&
      after.serviceWorker.runtimeProbe?.reloadMarker !== reloadMarker,
    newIsolatedContext: after.isolatedContext.id !== before.isolatedContext.id,
    recoveredRuntime:
      before.contentContext?.runtimeId === extensionId &&
      after.contentContext?.runtimeId === extensionId &&
      after.contentContext?.documentReady === true,
    recoveryImageLoaded:
      ingress.inserted?.inserted === true &&
      ingress.request?.responseCode === 200 &&
      ingress.loaded?.ready === true,
    mediaFoundCaptured:
      ingress.transport.includes('MEDIA_FOUND') &&
      after.storage.matchingCount === 1,
    storageUpdated:
      before.storage.matchingCount === 0 &&
      after.storage.mediaCount > before.storage.mediaCount,
  };
  const result = {
    status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    restoredDocument,
    tab: {
      id: tabId,
      targetId: facebookTarget.id,
      url: facebookUrl,
      after: finalTab,
    },
    recoveryItem,
    before,
    reload: reloadInvocation,
    after,
    capturedFlow: {
      transport: ingress.transport,
      messageType: 'MEDIA_FOUND',
      ingress,
    },
    checks,
    passed: Object.values(checks).every(Boolean),
  };
  return { worker: afterWorker, evidence: result };
}

async function paintSyntheticFacebookTheme(facebookPage, theme) {
  const color = theme === 'dark' ? 'rgb(24, 25, 26)' : 'rgb(250, 250, 250)';
  return evaluate(
    facebookPage,
    `(() => {
      const color = ${JSON.stringify(color)};
      document.documentElement.style.backgroundColor = color;
      document.body.style.backgroundColor = color;
      const main = document.querySelector('main');
      if (main instanceof HTMLElement) main.style.backgroundColor = color;
      document.documentElement.dataset.facescrapQaTheme = ${JSON.stringify(theme)};
      return {
        theme: ${JSON.stringify(theme)},
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        main: main == null ? null : getComputedStyle(main).backgroundColor,
      };
    })()`,
  );
}

async function quiesceSyntheticFacebookPage(facebookPage) {
  const navigation = await facebookPage.command('Page.navigate', { url: 'about:blank' });
  if (navigation.errorText) throw new Error(`Could not quiesce the synthetic Facebook page: ${navigation.errorText}`);
  return waitForEvaluation(
    facebookPage,
    `(() => ({ ready: location.href === 'about:blank' && document.readyState === 'complete', url: location.href }))()`,
    'the synthetic Facebook content script to stop before visual captures',
  );
}

async function waitForTabCaptureClear(page, tabId) {
  return waitForEvaluation(
    page,
    `(async () => {
      const tabId = ${JSON.stringify(tabId)};
      const keys = ['media_' + tabId, 'playing_' + tabId, 'recent_' + tabId];
      const stored = await chrome.storage.session.get(keys);
      return {
        ready: keys.every((key) => stored[key] === undefined),
        remaining: keys.filter((key) => stored[key] !== undefined),
      };
    })()`,
    'the synthetic Facebook navigation clear to finish',
  );
}

async function alignPanelToFacebook(browser, panelTargetId, facebookTargetId, page, tabId) {
  await browser.command('Target.activateTarget', { targetId: panelTargetId });
  await browser.command('Target.activateTarget', { targetId: facebookTargetId });
  return waitForEvaluation(
    page,
    `(async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      const trackedTab = document.documentElement.dataset.trackedTab ?? '';
      return {
        ready: active?.id === ${JSON.stringify(tabId)} && trackedTab === ${JSON.stringify(String(tabId))},
        activeTab: active?.id ?? null,
        trackedTab,
      };
    })()`,
    'the simulated side panel to track the seeded Facebook tab',
  );
}

async function waitForFacebookThemeSignal(page, tabId, expectedTheme) {
  const key = `facebook_theme_${tabId}`;
  return waitForEvaluation(
    page,
    `(async () => {
      const key = ${JSON.stringify(key)};
      const signal = (await chrome.storage.session.get(key))[key] ?? null;
      return {
        ready: signal?.theme === ${JSON.stringify(expectedTheme)} && Number.isFinite(signal?.at),
        key,
        signal,
      };
    })()`,
    `the real content-to-worker Facebook ${expectedTheme} theme signal`,
  );
}

async function setViewport(page, viewport) {
  await page.command('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: false,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
}

async function inspectThemeState(page) {
  return evaluate(
    page,
    `(() => {
      const root = document.documentElement;
      const rootStyle = getComputedStyle(root);
      const resolvedTheme = root.dataset.theme ?? '';
      const colorScheme = rootStyle.colorScheme;
      const visible = (element) => {
        if (!(element instanceof HTMLElement) || element.hidden) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const parseColor = (value) => {
        const channels = value.match(/[\\d.]+/g)?.slice(0, 3).map(Number) ?? [];
        return channels.length === 3 ? channels : null;
      };
      const isLight = (value) => {
        const channels = parseColor(value);
        if (!channels) return false;
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 >= 170;
      };
      const textOverlays = [
        ...document.querySelectorAll('#now-preview .preview-dur, #list .card-title, #list .card-meta'),
      ]
        .filter(visible)
        .map((element) => ({
          selector: element.className,
          text: element.textContent?.trim() ?? '',
          color: getComputedStyle(element).color,
        }));
      const play = document.querySelector('#now-preview .preview-play');
      const playIconColor =
        play instanceof HTMLElement && visible(play) ? getComputedStyle(play, '::before').backgroundColor : null;
      const overlayTextLight =
        textOverlays.every((entry) => isLight(entry.color)) &&
        (playIconColor === null || isLight(playIconColor));
      return {
        resolvedTheme,
        dataThemeValid: resolvedTheme === 'light' || resolvedTheme === 'dark',
        colorScheme,
        colorSchemeMatches: colorScheme.split(/\\s+/).includes(resolvedTheme),
        overlayTextLight,
        textOverlays,
        playIconColor,
      };
    })()`,
  );
}

async function waitForTheme(page, expectedTheme, description) {
  await waitForEvaluation(
    page,
    `(() => {
      const theme = document.documentElement.dataset.theme ?? '';
      const colorScheme = getComputedStyle(document.documentElement).colorScheme;
      return {
        ready:
          theme === ${JSON.stringify(expectedTheme)} &&
          colorScheme.split(/\\s+/).includes(theme),
        theme,
        colorScheme,
      };
    })()`,
    description,
  );
  return inspectThemeState(page);
}

async function setRequestedTheme(page, fixture, theme) {
  const settings = { ...fixture.settings, theme };
  return evaluate(
    page,
    `(async () => {
      await chrome.storage.local.set({ settings: ${JSON.stringify(settings)} });
      return { theme: ${JSON.stringify(theme)} };
    })()`,
  );
}

async function exerciseThemeTransitions(page, facebookPage, fixture, theme, tabId) {
  await paintSyntheticFacebookTheme(facebookPage, 'light');
  const initialLightSignal = await waitForFacebookThemeSignal(page, tabId, 'light');
  await setRequestedTheme(page, fixture, 'light');
  await waitForTheme(page, 'light', 'manual light theme setup');
  await paintSyntheticFacebookTheme(facebookPage, 'dark');
  const manualLightSignal = await waitForFacebookThemeSignal(page, tabId, 'dark');
  const manualLight = await waitForTheme(page, 'light', 'manual light theme precedence over Facebook dark');

  await setRequestedTheme(page, fixture, 'dark');
  await waitForTheme(page, 'dark', 'manual dark theme setup');
  await paintSyntheticFacebookTheme(facebookPage, 'light');
  const manualDarkSignal = await waitForFacebookThemeSignal(page, tabId, 'light');
  const manualDark = await waitForTheme(page, 'dark', 'manual dark theme precedence over Facebook light');

  await setRequestedTheme(page, fixture, 'auto');
  const autoLight = await waitForTheme(page, 'light', 'automatic light Facebook theme');
  await paintSyntheticFacebookTheme(facebookPage, 'dark');
  const autoDarkSignal = await waitForFacebookThemeSignal(page, tabId, 'dark');
  const autoDark = await waitForTheme(page, 'dark', 'automatic dark Facebook theme');
  await paintSyntheticFacebookTheme(facebookPage, 'light');
  const autoLightSignal = await waitForFacebookThemeSignal(page, tabId, 'light');
  const autoLightAgain = await waitForTheme(page, 'light', 'automatic light Facebook theme after mutation');

  await evaluate(
    page,
    `(async () => chrome.storage.session.remove(${JSON.stringify(`facebook_theme_${tabId}`)}))()`,
  );
  const autoFallback = await waitForEvaluation(
    page,
    `(() => {
      const resolvedTheme = document.documentElement.dataset.theme ?? '';
      const colorScheme = getComputedStyle(document.documentElement).colorScheme;
      return {
        ready:
          (resolvedTheme === 'light' || resolvedTheme === 'dark') &&
          colorScheme.split(/\\s+/).includes(resolvedTheme),
        resolvedTheme,
        colorScheme,
      };
    })()`,
    'automatic theme fallback without a Facebook signal',
  );

  let restoredSignal = null;
  if (theme === 'auto') {
    await paintSyntheticFacebookTheme(facebookPage, 'dark');
    restoredSignal = await waitForFacebookThemeSignal(page, tabId, 'dark');
  }
  await setRequestedTheme(page, fixture, theme);
  const restored =
    theme === 'auto'
      ? await waitForTheme(page, 'dark', 'restored automatic requested theme')
      : await waitForTheme(page, theme, `restored requested ${theme} theme`);
  const storedTheme = await evaluate(
    page,
    `(async () => (await chrome.storage.local.get('settings')).settings?.theme ?? null)()`,
  );
  const restoredInspection = await inspectThemeState(page);

  const result = {
    sequence: ['light', 'dark', 'auto'],
    facebookThemeKey: `facebook_theme_${tabId}`,
    requestedTheme: theme,
    contentToWorkerToSession: {
      initialLightSignal,
      manualLightSignal,
      manualDarkSignal,
      autoDarkSignal,
      autoLightSignal,
      restoredSignal,
    },
    manualLight,
    manualDark,
    autoDark,
    autoLight,
    autoLightAgain,
    autoFallback,
    restored,
    restoredInspection,
    manualLightWins: manualLight.resolvedTheme === 'light',
    manualDarkWins: manualDark.resolvedTheme === 'dark',
    autoFollowsFacebookSignal:
      autoLight.resolvedTheme === 'light' &&
      autoDark.resolvedTheme === 'dark' &&
      autoLightAgain.resolvedTheme === 'light',
    autoFallbackValid:
      autoFallback.resolvedTheme === 'light' || autoFallback.resolvedTheme === 'dark',
    requestedThemeRestored:
      storedTheme === theme &&
      (theme === 'auto'
        ? restoredInspection.dataThemeValid && restoredInspection.colorSchemeMatches
        : restoredInspection.resolvedTheme === theme && restoredInspection.colorSchemeMatches),
    overlayTextLight:
      manualLight.overlayTextLight &&
      manualDark.overlayTextLight &&
      autoDark.overlayTextLight &&
      autoLight.overlayTextLight &&
      autoLightAgain.overlayTextLight &&
      restoredInspection.overlayTextLight,
  };
  result.passed =
    result.manualLightWins &&
    result.manualDarkWins &&
    result.autoFollowsFacebookSignal &&
    result.autoFallbackValid &&
    result.requestedThemeRestored &&
    result.overlayTextLight;
  return result;
}

async function captureResponsiveSettingsControl(page, width, controlName, expectedText) {
  const selectors =
    controlName === 'theme'
      ? {
          label: '#label-set-theme',
          control: '#set-theme',
          hint: '#hint-set-theme',
          filename: `settings-theme-${width}.png`,
        }
      : {
          label: '#label-set-maxitems',
          control: '#set-maxitems',
          hint: '#hint-set-maxitems',
          filename: `settings-maxitems-${width}.png`,
        };
  const inspection = await evaluate(
    page,
    `(() => {
      const controlName = ${JSON.stringify(controlName)};
      const expectedText = ${JSON.stringify(expectedText)};
      const label = document.querySelector(${JSON.stringify(selectors.label)});
      const control = document.querySelector(${JSON.stringify(selectors.control)});
      const hint = document.querySelector(${JSON.stringify(selectors.hint)});
      const row = control?.closest('.set-row');
      row?.scrollIntoView({ block: 'center', inline: 'nearest' });

      const normalizedText = (element) => element?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
      const rendered = (element) => {
        if (!(element instanceof HTMLElement) || element.hidden) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const withinViewport = (element) => {
        if (!rendered(element)) return false;
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= -1 &&
          rect.right <= innerWidth + 1 &&
          rect.top >= -1 &&
          rect.bottom <= innerHeight + 1
        );
      };
      const rectOf = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };

      const labelText = normalizedText(label);
      const hintText = normalizedText(hint);
      const optionLabels =
        control instanceof HTMLSelectElement
          ? [...control.options].map((option) => normalizedText(option))
          : [];
      const optionValues =
        control instanceof HTMLSelectElement
          ? [...control.options].map((option) => option.value)
          : [];
      const settingsLabelsLocalized =
        labelText === expectedText.label &&
        hintText === expectedText.hint &&
        (expectedText.options == null ||
          JSON.stringify(optionLabels) === JSON.stringify(expectedText.options));
      const settingsControlsVisible = rendered(label) && rendered(control) && rendered(hint);
      const settingsControlsWithinViewport =
        withinViewport(label) && withinViewport(control) && withinViewport(hint);
      const settingsControlsLabeled =
        control instanceof HTMLElement &&
        label instanceof HTMLElement &&
        hint instanceof HTMLElement &&
        control.getAttribute('aria-labelledby') === label.id &&
        control.getAttribute('aria-describedby') === hint.id;
      const settingsControlsUsable =
        controlName === 'theme'
          ? control instanceof HTMLSelectElement &&
            !control.disabled &&
            JSON.stringify(optionValues) === JSON.stringify(['auto', 'light', 'dark']) &&
            optionValues.includes(control.value)
          : control instanceof HTMLInputElement &&
            !control.disabled &&
            control.type === 'text' &&
            control.inputMode === 'numeric' &&
            control.pattern === '[0-9]*' &&
            /^\\d+$/.test(control.value);
      const app = document.querySelector('#app');
      const noHorizontalOverflow =
        document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
        document.body.scrollWidth <= document.body.clientWidth &&
        (!app || app.scrollWidth <= app.clientWidth);
      const result = {
        control: controlName,
        language: document.documentElement.lang,
        labelText,
        hintText,
        optionLabels,
        value: control instanceof HTMLInputElement || control instanceof HTMLSelectElement ? control.value : null,
        settingsLabelsLocalized,
        settingsControlsVisible,
        settingsControlsWithinViewport,
        settingsControlsLabeled,
        settingsControlsUsable,
        noHorizontalOverflow,
        metrics: {
          label: rectOf(label),
          control: rectOf(control),
          hint: rectOf(hint),
          row: rectOf(row),
        },
      };
      return {
        ...result,
        passed:
          result.settingsLabelsLocalized &&
          result.settingsControlsVisible &&
          result.settingsControlsWithinViewport &&
          result.settingsControlsLabeled &&
          result.settingsControlsUsable &&
          result.noHorizontalOverflow,
      };
    })()`,
  );

  const screenshot = await page.command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const bytes = Buffer.from(screenshot.data, 'base64');
  const dimensions = pngDimensions(bytes);
  const screenshotDimensionsExact =
    dimensions.width === width && dimensions.height === VIEWPORT.height;
  const path = join(QA_DIR, selectors.filename);
  await writeFile(path, bytes);

  return {
    ...inspection,
    screenshot: {
      file: selectors.filename,
      path,
      ...dimensions,
      bytes: bytes.length,
      dimensionsExact: screenshotDimensionsExact,
    },
    passed: inspection.passed && screenshotDimensionsExact,
  };
}

async function exerciseResponsiveWidths(page, language) {
  const expectedSettingsText =
    language === 'es'
      ? {
          theme: {
            label: 'Tema',
            hint: 'Sigue Facebook y luego tu dispositivo',
            options: ['Automático', 'Claro', 'Oscuro'],
          },
          maxItems: { label: 'Máx. de items guardados', hint: '0 = Sin límite' },
        }
      : {
          theme: {
            label: 'Theme',
            hint: 'Follows Facebook, then your device',
            options: ['Auto', 'Light', 'Dark'],
          },
          maxItems: { label: 'Max saved items', hint: '0 = Unlimited' },
        };
  await activateSurface(page, 'settings');
  const widths = [];
  for (const width of RESPONSIVE_WIDTHS) {
    await setViewport(page, { ...VIEWPORT, width });
    await evaluate(page, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const themeControl = await captureResponsiveSettingsControl(
      page,
      width,
      'theme',
      expectedSettingsText.theme,
    );
    const maxItemsControl = await captureResponsiveSettingsControl(
      page,
      width,
      'maxitems',
      expectedSettingsText.maxItems,
    );
    const inspection = await evaluate(
      page,
      `(() => {
        const nav = document.querySelector('#views');
        const navRect = nav?.getBoundingClientRect();
        const navItems = [...(nav?.querySelectorAll('.view-pill') ?? [])].map((item) => {
          const rect = item.getBoundingClientRect();
          const style = getComputedStyle(item);
          return {
            left: rect.left,
            right: rect.right,
            visible:
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0,
          };
        });
        const app = document.querySelector('#app');
        const noHorizontalOverflow =
          document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
          document.body.scrollWidth <= document.body.clientWidth &&
          (!app || app.scrollWidth <= app.clientWidth);
        const settingsSurfaceActive =
          app?.classList.contains('is-settings') === true &&
          document.querySelector('#settings')?.hidden === false &&
          document.querySelector('#settings-open')?.getAttribute('aria-expanded') === 'true';
        const navItemsComplete =
          navItems.length === 4 &&
          navItems.every(
            (item) =>
              item.visible &&
              navRect &&
              item.left >= navRect.left - 1 &&
              item.right <= navRect.right + 1 &&
              item.left >= -1 &&
              item.right <= innerWidth + 1,
          );
        return {
          requestedWidth: ${JSON.stringify(width)},
          actualWidth: innerWidth,
          language: document.documentElement.lang,
          noHorizontalOverflow,
          navItemsComplete,
          navVisible: Boolean(navRect && navRect.width > 0 && navRect.height > 0),
          settingsSurfaceActive,
          passed:
            innerWidth === ${JSON.stringify(width)} &&
            document.documentElement.lang === ${JSON.stringify(language)} &&
            noHorizontalOverflow &&
            navItemsComplete &&
            settingsSurfaceActive,
        };
      })()`,
    );
    const settingsLabelsLocalized =
      themeControl.settingsLabelsLocalized && maxItemsControl.settingsLabelsLocalized;
    const settingsControlsVisible =
      themeControl.settingsControlsVisible && maxItemsControl.settingsControlsVisible;
    const settingsControlsWithinViewport =
      themeControl.settingsControlsWithinViewport && maxItemsControl.settingsControlsWithinViewport;
    const settingsControlsLabeled =
      themeControl.settingsControlsLabeled && maxItemsControl.settingsControlsLabeled;
    const settingsControlsUsable =
      themeControl.settingsControlsUsable && maxItemsControl.settingsControlsUsable;
    widths.push({
      ...inspection,
      requestedWidth: width,
      settingsLabelsLocalized,
      settingsControlsVisible,
      settingsControlsWithinViewport,
      settingsControlsLabeled,
      settingsControlsUsable,
      controls: {
        theme: themeControl,
        maxItems: maxItemsControl,
      },
      passed:
        inspection.passed &&
        themeControl.passed &&
        maxItemsControl.passed &&
        settingsLabelsLocalized &&
        settingsControlsVisible &&
        settingsControlsWithinViewport &&
        settingsControlsLabeled &&
        settingsControlsUsable,
    });
  }
  await setViewport(page, VIEWPORT);
  await evaluate(page, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const restoredWidth = await evaluate(page, 'innerWidth');
  return {
    widths,
    restoredWidth: VIEWPORT.width,
    actualRestoredWidth: restoredWidth,
    passed: widths.every((entry) => entry.passed) && restoredWidth === VIEWPORT.width,
  };
}

async function inspectReferenceRoots(page) {
  return evaluate(
    page,
    `(() => {
      const container = document.getElementById('2b');
      if (!container) return { containerFound: false, candidateCount: 0, rootCount: 0, roots: [] };
      const candidates = [...container.querySelectorAll('div')].filter(
        (element) => element.style.width === '${VIEWPORT.width}px' && element.style.height === '${VIEWPORT.height}px',
      );
      const roots = candidates.filter(
        (candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)),
      );
      roots.forEach((element, index) => element.setAttribute('data-facescrap-reference-index', String(index)));
      return {
        containerFound: true,
        candidateCount: candidates.length,
        rootCount: roots.length,
        roots: roots.map((element, index) => {
          const rect = element.getBoundingClientRect();
          return {
            index,
            tagName: element.tagName,
            id: element.id || null,
            className: typeof element.className === 'string' ? element.className : '',
            inlineWidth: element.style.width,
            inlineHeight: element.style.height,
            rect: {
              x: rect.left + scrollX,
              y: rect.top + scrollY,
              width: rect.width,
              height: rect.height,
            },
          };
        }),
      };
    })()`,
  );
}

async function captureReferenceSurfaces(page, referenceEvidence) {
  await setViewport(page, REFERENCE_VIEWPORT);
  await waitForEvaluation(
    page,
    `(() => ({ ready: document.readyState === 'complete', state: document.readyState, url: location.href }))()`,
    'the local reference document to finish loading',
  );
  await evaluate(page, `document.fonts?.ready ?? Promise.resolve()`);
  await evaluate(page, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

  const inspection = await inspectReferenceRoots(page);
  referenceEvidence.discovery = inspection;
  if (!inspection.containerFound) throw new Error('Reference HTML does not contain the required #2b container');
  if (inspection.rootCount !== REFERENCE_SURFACES.length) {
    throw new Error(
      `Reference HTML must contain exactly three root divs inside #2b with inline width:${VIEWPORT.width}px and height:${VIEWPORT.height}px; ` +
        `found ${inspection.rootCount} roots among ${inspection.candidateCount} matching divs`,
    );
  }

  for (const [index, surface] of REFERENCE_SURFACES.entries()) {
    const rect = await evaluate(
      page,
      `(() => {
        const element = document.getElementById('2b')?.querySelector('[data-facescrap-reference-index="${index}"]');
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.left + scrollX,
          y: bounds.top + scrollY,
          width: bounds.width,
          height: bounds.height,
        };
      })()`,
    );
    if (!rect) throw new Error(`Reference ${surface} root disappeared before capture`);
    if (Math.abs(rect.width - VIEWPORT.width) > 0.01 || Math.abs(rect.height - VIEWPORT.height) > 0.01) {
      throw new Error(`Reference ${surface} rendered at ${rect.width}x${rect.height}, expected ${VIEWPORT.width}x${VIEWPORT.height}`);
    }
    const screenshot = await page.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: rect.x, y: rect.y, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
    });
    const bytes = Buffer.from(screenshot.data, 'base64');
    const dimensions = pngDimensions(bytes);
    if (dimensions.width !== VIEWPORT.width || dimensions.height !== VIEWPORT.height) {
      throw new Error(
        `Reference ${surface} PNG is ${dimensions.width}x${dimensions.height}, expected ${VIEWPORT.width}x${VIEWPORT.height}`,
      );
    }
    const file = `reference-${surface}.png`;
    const path = join(QA_DIR, file);
    await writeFile(path, bytes);
    referenceEvidence.captures.push({
      surface,
      sourceIndex: index,
      file,
      path,
      ...dimensions,
      bytes: bytes.length,
      scale: 1,
      passed: true,
    });
  }
}

function comparisonDocument(surface) {
  const surfaceLabels = { now: 'Now', library: 'Library', settings: 'Settings' };
  const label = surfaceLabels[surface];
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; width: ${COMPARISON_VIEWPORT.width}px; height: ${COMPARISON_VIEWPORT.height}px; overflow: hidden; }
body { padding: 8px; display: grid; grid-template-columns: ${VIEWPORT.width}px ${VIEWPORT.width}px; gap: 16px; background: #111318; color: #f5f7fb; font: 600 13px/20px Arial, sans-serif; }
figure { margin: 0; width: ${VIEWPORT.width}px; }
figcaption { height: 20px; margin: 0 0 4px; white-space: nowrap; }
img { display: block; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; max-width: none; }
</style></head><body>
<figure><figcaption>Reference - ${label}</figcaption><img data-image="reference" alt="Reference ${label}"></figure>
<figure><figcaption>Implementation - ${label}</figcaption><img data-image="implementation" alt="Implementation ${label}"></figure>
</body></html>`;
}

async function captureComparisons(page, referenceEvidence) {
  await setViewport(page, COMPARISON_VIEWPORT);
  for (const surface of REFERENCE_SURFACES) {
    const referenceFile = join(QA_DIR, `reference-${surface}.png`);
    const implementationFile = join(QA_DIR, `${surface}.png`);
    const [referencePng, implementationPng] = await Promise.all([readFile(referenceFile), readFile(implementationFile)]);
    const html = comparisonDocument(surface);
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const navigation = await page.command('Page.navigate', { url: dataUrl });
    if (navigation.errorText) throw new Error(`Could not open ${surface} comparison page: ${navigation.errorText}`);
    await waitForEvaluation(
      page,
      `(() => ({ ready: document.readyState === 'complete' && document.querySelectorAll('img').length === 2 }))()`,
      `${surface} comparison document`,
    );
    await evaluate(
      page,
      `document.querySelector('[data-image="reference"]').src = ${JSON.stringify(`data:image/png;base64,${referencePng.toString('base64')}`)}`,
    );
    await evaluate(
      page,
      `document.querySelector('[data-image="implementation"]').src = ${JSON.stringify(`data:image/png;base64,${implementationPng.toString('base64')}`)}`,
    );
    const inspection = await waitForEvaluation(
      page,
      `(() => {
        const images = [...document.images];
        const rects = images.map((image) => {
          const rect = image.getBoundingClientRect();
          return { width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
        });
        return {
          ready: document.readyState === 'complete' && images.length === 2 && images.every((image) => image.complete),
          imageCount: images.length,
          labels: [...document.querySelectorAll('figcaption')].map((element) => element.textContent),
          rects,
        };
      })()`,
      `${surface} comparison page`,
    );
    await evaluate(page, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const imagesExact = inspection.rects.every(
      (rect) =>
        rect.width === VIEWPORT.width &&
        rect.height === VIEWPORT.height &&
        rect.naturalWidth === VIEWPORT.width &&
        rect.naturalHeight === VIEWPORT.height,
    );
    if (!imagesExact) throw new Error(`Comparison ${surface} did not render both PNGs at 1:1: ${JSON.stringify(inspection.rects)}`);
    const screenshot = await page.command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(screenshot.data, 'base64');
    const dimensions = pngDimensions(bytes);
    if (dimensions.width !== COMPARISON_VIEWPORT.width || dimensions.height !== COMPARISON_VIEWPORT.height) {
      throw new Error(
        `Comparison ${surface} PNG is ${dimensions.width}x${dimensions.height}, expected ${COMPARISON_VIEWPORT.width}x${COMPARISON_VIEWPORT.height}`,
      );
    }
    const file = `comparison-${surface}.png`;
    const path = join(QA_DIR, file);
    await writeFile(path, bytes);
    referenceEvidence.comparisons.push({
      surface,
      file,
      path,
      ...dimensions,
      bytes: bytes.length,
      labels: inspection.labels,
      scale: 1,
      referenceFile,
      implementationFile,
      passed: null,
      capturedForManualReview: true,
    });
  }
}

function assertProfileIsOwned(profileDir) {
  const resolvedProfile = resolve(profileDir);
  const resolvedTemp = resolve(tmpdir());
  const relativeToTemp = relative(resolvedTemp, resolvedProfile);
  const insideTemp = relativeToTemp !== '' && relativeToTemp !== '..' && !relativeToTemp.startsWith(`..${sep}`);
  if (!insideTemp || dirname(resolvedProfile) !== resolvedTemp || !basename(resolvedProfile).startsWith(PROFILE_PREFIX)) {
    throw new Error(`Refusing to delete unowned profile path: ${resolvedProfile}`);
  }
}

function cleanupSucceeded(cleanup, profileExpected, referenceServerExpected) {
  return (
    cleanup.browserStopped === true &&
    (!profileExpected || cleanup.profileRemoved === true) &&
    (!referenceServerExpected || cleanup.referenceServerStopped === true)
  );
}

async function stopBrowser(browser, child, browserExit) {
  if (browser && !browser.closed) {
    try {
      await Promise.race([browser.command('Browser.close'), delay(2_000)]);
    } catch {
      // Browser.close often closes the WebSocket before returning its response.
    }
  }
  let exit = await Promise.race([browserExit, delay(5_000).then(() => null)]);
  if (!exit && child && child.exitCode == null) {
    child.kill('SIGTERM');
    exit = await Promise.race([browserExit, delay(3_000).then(() => null)]);
  }
  if (!exit && child && child.exitCode == null) {
    child.kill('SIGKILL');
    exit = await Promise.race([browserExit, delay(2_000).then(() => null)]);
  }
  return { stopped: Boolean(exit || child?.exitCode != null), exit };
}

async function writeEvidence(evidence) {
  await mkdir(QA_DIR, { recursive: true });
  await writeFile(join(QA_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

async function main() {
  const evidence = {
    schemaVersion: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    language: null,
    requestedTheme: null,
    requirements: {
      runAfter: 'npm run build',
      browserName: null,
      browserExecutable: null,
      extensionDirectory: DIST,
      nodeModules: 'built-in only',
      transport: 'Chrome DevTools Protocol over a native WebSocket client',
    },
    viewport: VIEWPORT,
    browser: null,
    extension: null,
    seed: null,
    syntheticFacebook: null,
    runtimeReloadRecovery: null,
    themeTransitions: null,
    responsive: null,
    captures: [],
    interactionCaptures: [],
    referenceComparison: {
      enabled: false,
      status: 'skipped',
      source: null,
      expectedContainer: '#2b',
      expectedRootSize: { width: VIEWPORT.width, height: VIEWPORT.height },
      surfaceMapping: 'document order: now, library, settings',
      captures: [],
      comparisons: [],
    },
    console: [],
    errors: [],
    diagnostics: {},
    cleanup: { browserStopped: false, profileRemoved: false },
  };

  let profileDir;
  let child;
  let browserExit = Promise.resolve(null);
  let browser;
  let page;
  let facebookPage;
  let worker;
  let referencePage;
  let comparisonPage;
  let referenceServer;
  let referencePath;
  let language = 'es';
  let browserName = 'edge';
  let browserExecutable = BROWSER_EXECUTABLES.edge;
  let theme = 'light';
  let runError;
  let browserStdout = '';
  let browserStderr = '';

  try {
    ({ referencePath, language, browserName, theme } = parseArguments(process.argv.slice(2)));
    browserExecutable = BROWSER_EXECUTABLES[browserName];
    evidence.language = language;
    evidence.requestedTheme = theme;
    evidence.requirements.browserName = browserName;
    evidence.requirements.browserExecutable = browserExecutable;
    if (referencePath) {
      evidence.referenceComparison.enabled = true;
      evidence.referenceComparison.status = 'running';
      evidence.referenceComparison.source = {
        path: referencePath,
      };
    }
    await assertBuildReady(browserExecutable);
    await assertReferenceReady(referencePath);
    if (referencePath) {
      referenceServer = await startReferenceServer(referencePath);
      evidence.referenceComparison.source = {
        ...evidence.referenceComparison.source,
        root: referenceServer.root,
        entry: referenceServer.entry,
        url: referenceServer.url,
        transport: 'restricted loopback HTTP',
      };
    }
    await mkdir(QA_DIR, { recursive: true });
    profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
    assertProfileIsOwned(profileDir);

    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      'about:blank',
    ];
    child = spawn(browserExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout?.on('data', (chunk) => {
      browserStdout = appendBounded(browserStdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      browserStderr = appendBounded(browserStderr, chunk);
    });
    browserExit = new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });

    const port = await waitForDevToolsPort(profileDir, browserExit);
    const version = await requestJson(port, '/json/version');
    evidence.browser = {
      product: version.Browser,
      protocolVersion: version['Protocol-Version'],
      userAgent: version['User-Agent'],
      remoteDebuggingPort: port,
      headlessMode: 'new',
    };
    browser = await CdpSocket.connect(version.webSocketDebuggerUrl);
    attachEvidenceListeners(browser, evidence, 'browser');

    let discovery;
    try {
      discovery = await pollJsonList(
        port,
        (target) =>
          target.type === 'service_worker' &&
          /^chrome-extension:\/\/[a-p]{32}\/service-worker\.js(?:[?#].*)?$/.test(target.url ?? ''),
        'the FaceScrap MV3 service worker',
      );
    } catch (error) {
      const targets = error.targets ?? (await requestJson(port, '/json/list').catch(() => []));
      evidence.diagnostics.targetsWithoutFaceScrap = targets.map(({ id, type, title, url }) => ({ id, type, title, url }));
      throw new Error(
        `${browserName} exposed CDP, but the FaceScrap extension never appeared in /json/list. ` +
          'This browser/headless build may not support unpacked extensions in --headless=new, or dist/manifest.json failed to load. ' +
          `Observed targets: ${targets.map((target) => `${target.type}:${target.url}`).join(', ') || '(none)'}`,
      );
    }

    const workerTarget = discovery.found;
    const extensionId = new URL(workerTarget.url).hostname;
    evidence.diagnostics.discoveryTargets = discovery.targets.map(({ id, type, title, url }) => ({ id, type, title, url }));
    evidence.extension = {
      id: extensionId,
      discoveredFrom: '/json/list service_worker target',
      workerTarget: { id: workerTarget.id, type: workerTarget.type, url: workerTarget.url },
      sidepanelUrl: `chrome-extension://${extensionId}/sidepanel/sidepanel.html`,
    };

    if (workerTarget.webSocketDebuggerUrl) {
      try {
        worker = await CdpSocket.connect(workerTarget.webSocketDebuggerUrl);
        attachEvidenceListeners(worker, evidence, 'service-worker');
        await enableEvidenceDomains(worker);
      } catch (error) {
        // An MV3 worker may go idle between /json/list and the WebSocket
        // handshake. Page telemetry remains authoritative for this visual run.
        evidence.diagnostics.workerTelemetry = `unavailable: ${errorText(error)}`;
        worker?.close();
        worker = undefined;
      }
    }

    const syntheticFacebook = await openSyntheticFacebookPage(browser, port, evidence);
    facebookPage = syntheticFacebook.client;
    evidence.syntheticFacebook = {
      url: syntheticFacebook.url,
      target: syntheticFacebook.target,
      transport: syntheticFacebook.transport,
    };

    const target = await browser.command('Target.createTarget', {
      url: evidence.extension.sidepanelUrl,
      background: true,
    });
    const pageLookup = await pollJsonList(
      port,
      (candidate) => candidate.id === target.targetId && Boolean(candidate.webSocketDebuggerUrl),
      'the FaceScrap side-panel page target',
    );
    evidence.extension.pageTarget = {
      id: pageLookup.found.id,
      type: pageLookup.found.type,
      url: pageLookup.found.url,
    };

    page = await CdpSocket.connect(pageLookup.found.webSocketDebuggerUrl);
    attachEvidenceListeners(page, evidence, 'sidepanel');
    await enableEvidenceDomains(page);
    await page.command('Page.enable');
    await page.command('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
      mobile: false,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    const fixtureImages = await installFixtureImageInterceptor(page, evidence);

    const initial = await waitForPanelReady(page);
    if (initial.runtimeId !== extensionId || !initial.url.startsWith(`chrome-extension://${extensionId}/`)) {
      throw new Error(`The opened target is not the discovered FaceScrap extension page: ${JSON.stringify(initial)}`);
    }

    const fixture = buildFixture();
    const initialSeed = await seedStorage(page, fixture, language, theme);
    const panelTracking = await alignPanelToFacebook(
      browser,
      target.targetId,
      syntheticFacebook.target.id,
      page,
      initialSeed.tabId,
    );
    await paintSyntheticFacebookTheme(facebookPage, 'light');
    const navigationBarrier = await waitForFacebookThemeSignal(page, initialSeed.tabId, 'light');
    const stableSeed = await seedStableStorage(page, fixture, language, theme, initialSeed.tabId);
    evidence.seed = { ...stableSeed, panelTracking, navigationBarrier };

    evidence.syntheticFacebook.detectionPipeline = await exerciseDetectionPipeline(
      page,
      facebookPage,
      evidence.seed.tabId,
    );
    if (!evidence.syntheticFacebook.detectionPipeline.passed) {
      throw new Error(
        `Live detection pipeline QA failed: ${JSON.stringify(evidence.syntheticFacebook.detectionPipeline.checks)}`,
      );
    }
    evidence.seed.postDetectionStability = (
      await seedStableStorage(page, fixture, language, theme, evidence.seed.tabId)
    ).stability;

    evidence.themeTransitions = await exerciseThemeTransitions(
      page,
      facebookPage,
      fixture,
      theme,
      evidence.seed.tabId,
    );
    if (!evidence.themeTransitions.passed) {
      throw new Error(`Theme transition QA failed: ${JSON.stringify(evidence.themeTransitions)}`);
    }

    await browser.command('Target.activateTarget', { targetId: target.targetId });
    await delay(250);
    const imageCapture = await captureImageNowPlaying(
      page,
      facebookPage,
      syntheticFacebook.executionContexts,
      extensionId,
      fixture,
      evidence.seed.tabId,
      language,
      fixtureImages,
    );
    evidence.captures.push(imageCapture);
    if (!imageCapture.passed) {
      throw new Error(`Visual QA checks failed for image Now Playing: ${JSON.stringify(imageCapture.checks)}`);
    }
    await browser.command('Target.activateTarget', { targetId: syntheticFacebook.target.id });

    evidence.syntheticFacebook.quiesced = await quiesceSyntheticFacebookPage(facebookPage);
    evidence.syntheticFacebook.captureClear = await waitForTabCaptureClear(page, evidence.seed.tabId);
    const postThemeSeed = await seedStableStorage(page, fixture, language, theme, evidence.seed.tabId, true);
    evidence.seed.postThemeStability = postThemeSeed.stability;
    await browser.command('Target.activateTarget', { targetId: target.targetId });
    await delay(250);
    evidence.diagnostics.panelActivation = await evaluate(
      page,
      `(async () => {
        const ownUrl = chrome.runtime.getURL('sidepanel/sidepanel.html');
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const current = await chrome.tabs.getCurrent();
        const matching = await chrome.tabs.query({ url: ownUrl });
        return {
          trackedTab: document.documentElement.dataset.trackedTab ?? '',
          active: active == null ? null : { id: active.id, url: active.url, pendingUrl: active.pendingUrl },
          current: current == null ? null : { id: current.id, url: current.url, pendingUrl: current.pendingUrl },
          matching: matching.map((tab) => ({ id: tab.id, url: tab.url, pendingUrl: tab.pendingUrl })),
        };
      })()`,
    );
    evidence.responsive = await exerciseResponsiveWidths(page, language);
    if (!evidence.responsive.passed) {
      throw new Error(`Responsive QA failed: ${JSON.stringify(evidence.responsive)}`);
    }

    const compactQualityCapture = await captureCompactQualityStates(page, fixture, evidence.seed.tabId);
    evidence.interactionCaptures.push(compactQualityCapture);
    if (!compactQualityCapture.passed) {
      throw new Error(
        `Visual QA checks failed for compact video quality states: ${JSON.stringify(compactQualityCapture.checks)}`,
      );
    }

    const focusedClosedCapture = await captureFocusedClosedQualityTransition(
      page,
      fixture,
      evidence.seed.tabId,
    );
    evidence.interactionCaptures.push(focusedClosedCapture);
    if (!focusedClosedCapture.passed) {
      throw new Error(
        `Visual QA checks failed for focused-closed video quality transition: ${JSON.stringify(focusedClosedCapture.checks)}`,
      );
    }

    const forcedFallbackCapture = await captureForcedFallbackQualityTransition(
      page,
      fixture,
      evidence.seed.tabId,
    );
    evidence.interactionCaptures.push(forcedFallbackCapture);
    if (!forcedFallbackCapture.passed) {
      throw new Error(
        `Visual QA checks failed for forced video quality fallback: ${JSON.stringify(forcedFallbackCapture.checks)}`,
      );
    }

    for (const surface of ['now', 'library', 'saved', 'settings']) {
      const capture = await captureSurface(page, surface, language);
      evidence.captures.push(capture);
      if (!capture.passed) {
        throw new Error(`Visual QA checks failed for ${surface}: ${JSON.stringify(capture.checks)}`);
      }
    }

    for (const spec of [
      { surface: 'now', selectId: 'now-qselect', filename: 'now-quality-open.png' },
      { surface: 'settings', selectId: 'set-quality', filename: 'settings-quality-open.png' },
    ]) {
      const capture = await captureOpenSelect(page, spec);
      evidence.interactionCaptures.push(capture);
      if (!capture.passed) {
        throw new Error(`Visual QA checks failed for open #${spec.selectId}: ${JSON.stringify(capture.checks)}`);
      }
    }

    const singleQualityCapture = await captureSingleQualityOption(page, fixture, evidence.seed.tabId);
    evidence.interactionCaptures.push(singleQualityCapture);
    if (!singleQualityCapture.passed) {
      throw new Error(
        `Visual QA checks failed for single-option video quality: ${JSON.stringify(singleQualityCapture.checks)}`,
      );
    }

    if (referencePath) {
      const referenceTarget = await openPageTarget(
        browser,
        port,
        evidence.referenceComparison.source.url,
        'the local FaceScrap reference page target',
        evidence,
        'reference',
      );
      referencePage = referenceTarget.client;
      evidence.referenceComparison.source.target = referenceTarget.target;
      await captureReferenceSurfaces(referencePage, evidence.referenceComparison);
      referencePage.close();
      referencePage = undefined;

      const comparisonTarget = await openPageTarget(
        browser,
        port,
        'about:blank',
        'the FaceScrap comparison page target',
        evidence,
        'comparison',
      );
      comparisonPage = comparisonTarget.client;
      evidence.referenceComparison.comparisonTarget = comparisonTarget.target;
      evidence.referenceComparison.viewport = COMPARISON_VIEWPORT;
      await captureComparisons(comparisonPage, evidence.referenceComparison);
      evidence.referenceComparison.status = 'capturedForManualReview';
      comparisonPage.close();
      comparisonPage = undefined;
    }

    if (browserName === 'edge') {
      const runtimeReloadRecovery = await verifyRuntimeReloadRecovery({
        browser,
        port,
        worker,
        facebookPage,
        executionContexts: syntheticFacebook.executionContexts,
        extensionId,
        facebookTarget: syntheticFacebook.target,
        facebookUrl: syntheticFacebook.url,
        tabId: evidence.seed.tabId,
        fixture,
        evidence,
      });
      worker = runtimeReloadRecovery.worker;
      evidence.runtimeReloadRecovery = runtimeReloadRecovery.evidence;
      if (!evidence.runtimeReloadRecovery.passed) {
        throw new Error(
          `Runtime reload recovery QA failed: ${JSON.stringify(evidence.runtimeReloadRecovery.checks)}`,
        );
      }
    } else {
      // Brave headless unloads this temporary unpacked extension on
      // chrome.runtime.reload() without re-registering its service worker. That
      // is a browser-harness limitation, not a public update path, so keep the
      // ordinary Brave capture matrix authoritative and record the gap instead
      // of turning it into a false product failure.
      evidence.runtimeReloadRecovery = {
        status: 'skipped',
        passed: null,
        browserName,
        reason: 'Brave headless does not restart the temporary unpacked extension after chrome.runtime.reload().',
      };
    }

    if (evidence.errors.length > 0) {
      const sources = [...new Set(evidence.errors.map((entry) => entry.source))].join(', ');
      throw new Error(
        `Visual QA captured ${evidence.errors.length} runtime or protocol error(s): ${sources}`,
      );
    }

    evidence.status = 'passed';
  } catch (error) {
    runError = error;
    evidence.status = 'failed';
    if (
      evidence.referenceComparison.enabled &&
      evidence.referenceComparison.status !== 'capturedForManualReview'
    ) {
      evidence.referenceComparison.status = 'failed';
    }
    evidence.failure = { message: errorText(error), stack: stackText(error) };
    evidence.errors.push({ context: 'harness', source: 'main', text: errorText(error) });
  } finally {
    comparisonPage?.close();
    referencePage?.close();
    facebookPage?.close();
    page?.close();
    worker?.close();
    const stopped = await stopBrowser(browser, child, browserExit).catch((error) => ({ stopped: false, error }));
    browser?.close();
    if (referenceServer) {
      try {
        await referenceServer.close();
        evidence.cleanup.referenceServerStopped = true;
      } catch (error) {
        evidence.cleanup.referenceServerStopped = false;
        evidence.errors.push({ context: 'cleanup', source: 'referenceServer', text: errorText(error) });
      }
    }
    evidence.cleanup.browserStopped = stopped.stopped;
    evidence.cleanup.browserExit = stopped.exit ?? null;
    if (stopped.error) evidence.errors.push({ context: 'cleanup', source: 'stopBrowser', text: errorText(stopped.error) });

    if (profileDir) {
      try {
        assertProfileIsOwned(profileDir);
        await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
        evidence.cleanup.profileRemoved = true;
      } catch (error) {
        evidence.errors.push({ context: 'cleanup', source: 'profileRemoval', text: errorText(error) });
        evidence.cleanup.profileRemovalError = errorText(error);
      }
    }
    evidence.diagnostics.browserStdout = browserStdout;
    evidence.diagnostics.browserStderr = browserStderr;
    if (!cleanupSucceeded(evidence.cleanup, Boolean(profileDir), Boolean(referenceServer)) && !runError) {
      evidence.status = 'failed';
      evidence.failure = {
        message: 'Visual captures passed, but browser/profile/reference-server cleanup did not complete.',
      };
    }
    evidence.endedAt = new Date().toISOString();

    if (await stat(QA_DIR).then((entry) => entry.isDirectory()).catch(() => false)) {
      await writeEvidence(evidence);
    }
  }

  if (runError) throw runError;
  if (!cleanupSucceeded(evidence.cleanup, Boolean(profileDir), Boolean(referenceServer))) {
    throw new Error(
      'Visual QA completed, but browser/profile/reference-server cleanup did not finish; inspect dist/qa/evidence.json',
    );
  }
  process.stdout.write(`FaceScrap visual QA passed: ${join(QA_DIR, 'evidence.json')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${errorText(error)}\n`);
  process.exitCode = 1;
});
