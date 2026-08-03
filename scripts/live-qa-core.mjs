const DEFAULT_FACEBOOK_URL = 'https://www.facebook.com/';
const SUPPORTED_BROWSERS = new Set(['cft', 'edge', 'brave']);
const MAX_TEXT_LENGTH = 2_000;

function parseBrowserName(value) {
  if (value === 'chrome') {
    throw new Error(
      'Branded Chrome cannot load unpacked extensions from launch flags; use Chrome for Testing with --browser=cft',
    );
  }
  if (!SUPPORTED_BROWSERS.has(value)) {
    throw new Error('--browser must be cft, edge, or brave');
  }
  return value;
}

function parseFacebookUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--url must be an absolute facebook.com URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    (parsed.hostname !== 'facebook.com' && !parsed.hostname.endsWith('.facebook.com'))
  ) {
    throw new Error('--url must use https on facebook.com');
  }
  return parsed.href;
}

export function parseArguments(argv) {
  let browserName = 'cft';
  let startUrl = DEFAULT_FACEBOOK_URL;
  let browserProvided = false;
  let urlProvided = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--browser') {
      if (browserProvided) throw new Error('--browser may only be provided once');
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--browser requires a value');
      browserName = parseBrowserName(value);
      browserProvided = true;
      continue;
    }
    if (argument.startsWith('--browser=')) {
      if (browserProvided) throw new Error('--browser may only be provided once');
      browserName = parseBrowserName(argument.slice('--browser='.length));
      browserProvided = true;
      continue;
    }
    if (argument === '--url') {
      if (urlProvided) throw new Error('--url may only be provided once');
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--url requires a value');
      startUrl = parseFacebookUrl(value);
      urlProvided = true;
      continue;
    }
    if (argument.startsWith('--url=')) {
      if (urlProvided) throw new Error('--url may only be provided once');
      startUrl = parseFacebookUrl(argument.slice('--url='.length));
      urlProvided = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { browserName, startUrl };
}

export function classifyTarget(target, extensionId) {
  const url = target.url ?? '';
  const extensionRoot = `chrome-extension://${extensionId}/`;
  if (url.startsWith(extensionRoot)) {
    const path = url.slice(extensionRoot.length);
    if (target.type === 'service_worker' || path.startsWith('service-worker.js')) {
      return 'service-worker';
    }
    if (path.startsWith('offscreen/')) return 'offscreen';
    if (path.startsWith('sidepanel/')) return 'sidepanel';
    return 'extension-page';
  }
  if (target.type !== 'page') return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'facebook.com' || parsed.hostname.endsWith('.facebook.com')) {
      return 'facebook';
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function shouldRecordRuntimeEvent(event, extensionId) {
  if (event.context !== 'facebook') return true;
  if (event.kind === 'exception' || event.level === 'error') return true;
  if (event.text.includes('[FaceScrap]')) return true;
  const extensionRoot = `chrome-extension://${extensionId}/`;
  return event.urls.some((url) => url.startsWith(extensionRoot));
}

export function redactUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return String(raw).split(/[?#]/, 1)[0].slice(0, MAX_TEXT_LENGTH);
  }
  if (parsed.protocol === 'chrome-extension:') {
    return `chrome-extension://<extension>${parsed.pathname}`;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const path = parsed.pathname === '/' ? '/' : '/…';
    return `${parsed.protocol}//${parsed.host}${path}`;
  }
  return `${parsed.protocol}…`;
}

export function sanitizeText(raw) {
  return String(raw)
    .replace(/(?:https?|chrome-extension):\/\/[^\s"'<>()[\]]+/g, (url) => redactUrl(url))
    .slice(0, MAX_TEXT_LENGTH);
}

export function sanitizeData(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const clean = {};
  for (const [key, value] of Object.entries(raw).slice(0, 12)) {
    const safeKey = key.slice(0, 40);
    if (typeof value === 'string') clean[safeKey] = sanitizeText(value);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[safeKey] = value;
    else if (typeof value === 'boolean') clean[safeKey] = value;
  }
  return Object.keys(clean).length === 0 ? undefined : clean;
}
