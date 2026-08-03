// Diagnostic event log, always on — it shares diag.ts's threat model and its bounds.
//
// diag.ts answers "how many captures were discarded, and why". This answers the
// question a counter cannot: WHAT happened, in order, in this tab — which GraphQL
// response carried which ladder, which fbcdn track streamed, which download failed
// and with what error. A counter is only readable by someone who already knows
// which counter to suspect; a trace is what you read when every counter is zero
// and the panel is still empty.
//
// No chrome.* here, for the same reason as diag.ts: this file is bundled into the
// MAIN-world page hook, which has no extension APIs. Events ride the same channel
// the counters already use (hook -> content script -> worker).
//
// URLs are redacted HERE, at the moment they are recorded — never later, at
// export time. An fbcdn URL carries signed `oh`/`oe` tokens and `_nc_sid`; a
// facebook.com URL carries story, reel and asset ids in its PATH as well as its
// query, so both are cut back. Redacting on the way in means a log that is never
// written cannot leak them, and there is exactly one function to audit rather
// than one per call site. Response BODIES are never recorded at all: only their
// size, their query name and what was extracted from them. The point of this log
// is that a user can read it before handing it to anyone.

/** Extension context that recorded the event. Callers pass literals, so the type
 *  remains private to this module. */
type DiagContext = 'hook' | 'content' | 'worker' | 'panel' | 'offscreen';

// Keyed off a Record for the same reason DIAG_REASONS is (see diag.ts): the
// COMPILER rejects a context the union declares and this list omits, so a new
// context cannot be silently dropped by the sanitizer at every boundary.
const CONTEXTS: Record<DiagContext, true> = {
  hook: true,
  content: true,
  worker: true,
  panel: true,
  offscreen: true,
};

/** Flat scalars only. A nested object would be one refactor away from carrying a
 *  whole GraphQL node — which is exactly what must never reach this log. */
type DiagValue = string | number | boolean;

export interface DiagEvent {
  /** ms since epoch, taken in the recording context. */
  at: number;
  ctx: DiagContext;
  /** Short slug naming what happened: `graphql`, `net`, `download`, `mux`. */
  ev: string;
  /** Present only for warnings and errors, so a reader can filter to trouble. */
  lvl?: 'warn' | 'error';
  data?: Record<string, DiagValue>;
}

/** Ring size per context, in memory. Drained on the same schedule as the
 *  counters, so this only has to survive one flush interval of a burst. */
export const DIAG_EVENT_MAX = 400;
const MAX_DATA_KEYS = 12;
const MAX_STRING = 200;
const MAX_EV_NAME = 48;
const MAX_URL = 160;

/** Not exported, for the same reason DiagContext is not: every caller gets one of
 *  these from createEventRing and never has to name the type. */
interface EventRing {
  readonly length: number;
  push(event: DiagEvent): void;
  requeue(retained: readonly DiagEvent[]): void;
  clear(): void;
  drain(ctx: DiagContext, extra?: Record<string, DiagValue>): DiagEvent[];
}

/** A bounded ring that drops the OLDEST event and counts what it dropped. Reported
 *  rather than hidden: a truncated trace that does not say it was truncated reads as
 *  a complete one, and a gap is the first thing that misleads someone debugging from
 *  it.
 *
 *  A factory because three contexts keep one of these — this module, the worker's
 *  observer and the content script — and the three hand-written copies had already
 *  drifted apart. What legitimately differs stays per caller: the bound, the `ctx`
 *  the overflow marker is stamped with, and any extra field naming WHICH ring lost
 *  the events. */
export function createEventRing(max: number): EventRing {
  const events: DiagEvent[] = [];
  let dropped = 0;
  return {
    get length(): number {
      return events.length;
    },
    push(event: DiagEvent): void {
      events.push(event);
      if (events.length > max) {
        events.shift();
        dropped += 1;
      }
    },
    /** Put already-drained events back at the front after a failed write, so the
     *  retained trace keeps its order. Not re-bounded here: the next push trims, and
     *  it trims the old end — which is the right one to lose. */
    requeue(retained: readonly DiagEvent[]): void {
      events.unshift(...retained.slice(-max));
    },
    clear(): void {
      events.length = 0;
      dropped = 0;
    },
    drain(ctx: DiagContext, extra?: Record<string, DiagValue>): DiagEvent[] {
      const out = events.splice(0, events.length);
      if (dropped > 0) {
        // Prepended, not appended: the drop happened at the OLD end of the window,
        // so the gap belongs before the events that survived it.
        out.unshift({ at: Date.now(), ctx, ev: 'logOverflow', lvl: 'warn', data: { dropped, ...extra } });
        dropped = 0;
      }
      return out;
    },
  };
}

let context: DiagContext = 'content';
const ring = createEventRing(DIAG_EVENT_MAX);

/** Name this context once, at its entry point. */
export function setDiagContext(ctx: DiagContext): void {
  context = ctx;
}

function clampString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Cut a path down to what names the KIND of resource, never which one. A story
 *  id, a reel id or an fbcdn filename is what makes an exported trace point back
 *  at a person; `/reel`, `/stories` and `/v/t42.1790-2` are what make it readable.
 *  Long digit runs go first, because one hides inside a filename as readily as it
 *  fills a whole segment; then everything past the second segment goes. */
function redactPath(path: string): string {
  const lead = path.startsWith('/') ? '/' : '';
  const segments = path.split('/').filter((part) => part.length > 0);
  if (segments.length === 0) return lead;
  const kept = segments.slice(0, 2).map((part) => part.replace(/\d{6,}/g, '<id>'));
  // Marked when it was cut, for the same reason logOverflow is: a path silently
  // shortened reads as the whole path.
  return `${lead}${kept.join('/')}${segments.length > 2 ? '/…' : ''}`;
}

/** Reduce a URL to what identifies it without what authorizes it: host and a
 *  trimmed path, plus the DASH byte range when present (which is the whole point
 *  of an fbcdn track line). Every other query parameter is dropped — that is where
 *  `oh`, `oe`, `_nc_sid` and friends live. */
export function redactUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  // Cheap, total fallback for anything URL() cannot parse (a blob: handle, a
  // relative path, a truncated string): cut at the query, then trim what is left —
  // a relative Facebook path carries the same ids an absolute one does.
  const bare = (): string => clampString(redactPath(raw.split('?')[0] ?? ''), MAX_URL);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return bare();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // blob:, data: and friends: the opaque part identifies nothing useful and
    // a data: URL would inline the media itself.
    return clampString(`${parsed.protocol}…`, MAX_URL);
  }
  const start = parsed.searchParams.get('bytestart');
  const end = parsed.searchParams.get('byteend');
  const range =
    start != null && end != null && /^\d{1,15}$/.test(start) && /^\d{1,15}$/.test(end)
      ? `?bytestart=${start}&byteend=${end}`
      : '';
  return clampString(`${parsed.host}${redactPath(parsed.pathname)}${range}`, MAX_URL);
}

/** Bound one payload: a fixed key budget, scalars only, strings clamped. */
function clampData(raw: Record<string, DiagValue> | undefined): Record<string, DiagValue> | undefined {
  if (raw == null) return undefined;
  const out: Record<string, DiagValue> = {};
  let keys = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (keys >= MAX_DATA_KEYS) break;
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') out[clampString(key, 32)] = clampString(value, MAX_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) out[clampString(key, 32)] = value;
    else if (typeof value === 'boolean') out[clampString(key, 32)] = value;
    else continue;
    keys += 1;
  }
  return keys > 0 ? out : undefined;
}

/** Record one event. What bounds this is the ring, not a flag: a call site costs one
 *  clamped object and one push, and the oldest event leaves when the ring is full. So
 *  a call site may sit anywhere a burst is already bounded — never inside harvest()'s
 *  per-node success path, and never once per DASH segment. */
export function diagLog(ev: string, data?: Record<string, DiagValue>, lvl?: 'warn' | 'error'): void {
  const event: DiagEvent = { at: Date.now(), ctx: context, ev: clampString(ev, MAX_EV_NAME) };
  if (lvl != null) event.lvl = lvl;
  const clean = clampData(data);
  if (clean != null) event.data = clean;
  ring.push(event);
}

/** Any http(s) URL embedded in free text, so an error message that quotes one is
 *  redacted the same way a URL field is. Facebook's own errors quote signed fbcdn
 *  URLs, and the log is meant to be handed to someone. */
const EMBEDDED_URL = /https?:\/\/[^\s"'<>)\]]+/g;

/** Bound throwable text and reduce embedded URLs to host plus trimmed path. */
export function errorText(error: unknown): string {
  const redactEmbedded = (text: string): string =>
    clampString(text.replace(EMBEDDED_URL, (url) => redactUrl(url)), MAX_STRING);
  if (error instanceof Error) return redactEmbedded(`${error.name}: ${error.message}`);
  if (typeof error === 'string') return redactEmbedded(error);
  try {
    return redactEmbedded(String(error));
  } catch {
    return 'unknown error';
  }
}

/** Report a failure to BOTH the console and the log. The console is for someone
 *  watching the worker live; the log copy is what makes the same failure readable
 *  afterwards, from an export, by someone who was not watching. */
export function diagError(ev: string, error: unknown, data?: Record<string, DiagValue>): void {
  console.error(`[FaceScrap] ${ev}`, error);
  diagLog(ev, { ...data, error: errorText(error) }, 'error');
}

/** Read and reset. Called at each context's flush point, so an event is reported
 *  exactly once even though several contexts report independently. */
export function diagLogDrain(): DiagEvent[] {
  return ring.drain(context);
}

/** Re-validate events crossing a world or context boundary, same defence-in-depth
 *  as sanitizeDiagCounters: the page hook shares a process with Facebook, so a
 *  compromised renderer can post anything on this channel. Bounds the count, the
 *  key budget and every string, and drops an unknown context outright. */
export function sanitizeDiagEvents(raw: unknown, max = DIAG_EVENT_MAX): DiagEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: DiagEvent[] = [];
  for (const entry of raw) {
    if (out.length >= max) break;
    if (entry == null || typeof entry !== 'object') continue;
    const candidate = entry as Partial<DiagEvent>;
    if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at) || candidate.at < 0) continue;
    if (typeof candidate.ctx !== 'string' || !(candidate.ctx in CONTEXTS)) continue;
    if (typeof candidate.ev !== 'string' || candidate.ev.length === 0) continue;
    const event: DiagEvent = {
      at: Math.floor(candidate.at),
      ctx: candidate.ctx as DiagContext,
      ev: clampString(candidate.ev, MAX_EV_NAME),
    };
    if (candidate.lvl === 'warn' || candidate.lvl === 'error') event.lvl = candidate.lvl;
    const data =
      candidate.data != null && typeof candidate.data === 'object' && !Array.isArray(candidate.data)
        ? clampData(candidate.data as Record<string, DiagValue>)
        : undefined;
    if (data != null) event.data = data;
    out.push(event);
  }
  return out;
}

/** One event as a log line, oldest field first. Used by the export and by the
 *  worker console dump, so both read identically. */
export function formatDiagEvent(event: DiagEvent): string {
  const time = new Date(event.at).toISOString().slice(11, 23);
  const level = event.lvl != null ? ` ${event.lvl.toUpperCase()}` : '';
  const data =
    event.data == null
      ? ''
      : ` ${Object.entries(event.data)
          .map(([key, value]) => `${key}=${typeof value === 'string' ? value : String(value)}`)
          .join(' ')}`;
  return `${time} [${event.ctx}]${level} ${event.ev}${data}`;
}
