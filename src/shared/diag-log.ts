// Diagnostic event log (opt-in — it shares diag.ts's flag and its threat model).
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
// facebook.com URL can carry ids in its query. Redacting on the way in means a
// log that is never written cannot leak them, and there is exactly one function
// to audit rather than one per call site. Response BODIES are never recorded at
// all: only their size, their query name and what was extracted from them. The
// point of this log is that a user can read it before handing it to anyone.

/** Which extension context recorded the event. Not exported: every caller passes
 *  a literal, so nothing outside this file needs to name the type — and an export
 *  with no importer is what fix-surplus-exports.test.ts exists to reject. */
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

let context: DiagContext = 'content';
let enabled = false;
const ring: DiagEvent[] = [];
/** Events the ring dropped since the last drain. Reported rather than hidden:
 *  a truncated trace that does not say it was truncated reads as a complete one,
 *  and a gap is the first thing that misleads someone debugging from it. */
let dropped = 0;

/** Name this context once, at its entry point. */
export function setDiagContext(ctx: DiagContext): void {
  context = ctx;
}

/** Shares diag.ts's switch deliberately: one user-facing "diagnostics" toggle,
 *  not two. Kept as its own flag here rather than importing diag.ts's, so the
 *  page hook's hot path (diagBump) has no reason to reach into this module. */
export function setDiagLogEnabled(on: boolean): void {
  enabled = on;
  ring.length = 0;
  dropped = 0;
}

export function diagLogEnabled(): boolean {
  return enabled;
}

function clampString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Reduce a URL to what identifies it without what authorizes it: host and path,
 *  plus the DASH byte range when present (which is the whole point of an fbcdn
 *  track line). Every other query parameter is dropped — that is where `oh`,
 *  `oe`, `_nc_sid` and friends live. */
export function redactUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  // Cheap, total fallback for anything URL() cannot parse (a blob: handle, a
  // relative path, a truncated string): cut at the query and keep the head.
  const bare = (): string => clampString(raw.split('?')[0] ?? '', MAX_URL);
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
  return clampString(`${parsed.host}${parsed.pathname}${range}`, MAX_URL);
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

function push(event: DiagEvent): void {
  ring.push(event);
  if (ring.length > DIAG_EVENT_MAX) {
    ring.shift();
    dropped += 1;
  }
}

/** Record one event. The enabled check lives HERE, not at the call sites, for the
 *  same reason diagBump's does — instrumenting a new path stays a one-line edit.
 *  Disabled cost is one boolean compare, so a call site may sit anywhere except
 *  inside harvest()'s per-node success path. */
export function diagLog(ev: string, data?: Record<string, DiagValue>, lvl?: 'warn' | 'error'): void {
  if (!enabled) return;
  const event: DiagEvent = { at: Date.now(), ctx: context, ev: clampString(ev, MAX_EV_NAME) };
  if (lvl != null) event.lvl = lvl;
  const clean = clampData(data);
  if (clean != null) event.data = clean;
  push(event);
}

/** One line of text for an unknown throwable, bounded. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return clampString(`${error.name}: ${error.message}`, MAX_STRING);
  if (typeof error === 'string') return clampString(error, MAX_STRING);
  try {
    return clampString(String(error), MAX_STRING);
  } catch {
    return 'unknown error';
  }
}

/** Report a failure to BOTH the console and the log. The console call is
 *  unconditional: someone watching the worker console live must not need
 *  diagnostics on to see it. The log copy is what makes the same failure readable
 *  afterwards, from an export, by someone who was not watching. */
export function diagError(ev: string, error: unknown, data?: Record<string, DiagValue>): void {
  console.error(`[FaceScrap] ${ev}`, error);
  diagLog(ev, { ...data, error: errorText(error) }, 'error');
}

/** Read and reset. Called at each context's flush point, so an event is reported
 *  exactly once even though several contexts report independently. */
export function diagLogDrain(): DiagEvent[] {
  if (ring.length === 0 && dropped === 0) return [];
  const out = ring.splice(0, ring.length);
  if (dropped > 0) {
    // Prepended, not appended: the drop happened at the OLD end of the window,
    // so the gap belongs before the events that survived it.
    out.unshift({ at: Date.now(), ctx: context, ev: 'logOverflow', lvl: 'warn', data: { dropped } });
    dropped = 0;
  }
  return out;
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
