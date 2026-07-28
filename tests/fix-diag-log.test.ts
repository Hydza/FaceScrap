// The diagnostic event log: what it records, what it refuses to record, and what it
// throws away when it fills up.
//
// The redaction cases are the ones worth reading first. Every URL in this log comes
// from Facebook, and an fbcdn URL is signed — `oh` and `oe` are a capability, not an
// id. The log exists to be exported and handed to someone, so a token surviving
// redaction is not a cosmetic bug: it hands over a working link to media the user
// may not have meant to share. The bounds tests matter for a duller reason —
// storage.local is shared with the settings and the language key.

import assert from 'node:assert/strict';
import test from 'node:test';

import './chrome-fake';
import { resetChromeStorage } from './chrome-fake';
import { createDiagObserver } from '../src/background/diag-observer';
import {
  DIAG_EVENT_MAX,
  diagLog,
  diagLogDrain,
  diagLogEnabled,
  errorText,
  formatDiagEvent,
  redactUrl,
  sanitizeDiagEvents,
  setDiagContext,
  setDiagLogEnabled,
  type DiagEvent,
} from '../src/shared/diag-log';
import {
  addDiagEvents,
  DIAG_LOG_MAX_EVENTS,
  getDiagEvents,
  resetDiagLog,
  trimDiagLog,
} from '../src/shared/diag-store';

// A real fbcdn video URL shape: a signed link with an expiry, a session id and a
// byte range. Only the range and the path may survive.
const FBCDN =
  'https://scontent-mad1-1.xx.fbcdn.net/v/t42.1790-2/487321_1234567890_n.mp4' +
  '?_nc_cat=108&_nc_sid=5e9851&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZSJ9' +
  '&_nc_ohc=AbCdEf&oh=00_AfDeadBeefCafe&oe=68A1B2C3&bytestart=0&byteend=524287';

test('strips the signature, session and expiry from an fbcdn URL', () => {
  const redacted = redactUrl(FBCDN);

  // The filename is the third segment, so it leaves with the rest of the tail:
  // `487321_1234567890_n` names one asset, `/v/t42.1790-2` only names its kind.
  assert.equal(redacted, 'scontent-mad1-1.xx.fbcdn.net/v/t42.1790-2/…?bytestart=0&byteend=524287');
  for (const secret of ['oh=', 'oe=', '_nc_sid', '_nc_ohc', 'efg=']) {
    assert.ok(!redacted.includes(secret), `${secret} survived redaction`);
  }
  assert.ok(!redacted.includes('1234567890'), 'the asset id survived redaction');
});

test('keeps what a facebook.com path names, never which item it names', () => {
  // The surface is what makes a trace readable; the id is what makes the person in
  // it identifiable, and this log exists to be handed to someone.
  assert.equal(redactUrl('https://www.facebook.com/reel/1234567890?s=single_unit&t=6'), 'www.facebook.com/reel/<id>');
  assert.equal(redactUrl('https://www.facebook.com/stories/9876543210987/'), 'www.facebook.com/stories/<id>');
});

test('records nothing identifying for a blob or data URL', () => {
  // A data: URL would inline the media itself; a blob: handle names nothing useful.
  assert.equal(redactUrl('data:video/mp4;base64,AAAAIGZ0eXBpc29t'), 'data:…');
  assert.equal(redactUrl('blob:https://www.facebook.com/8f1c-4a2b'), 'blob:…');
});

test('falls back to the head of an unparseable URL, without its query', () => {
  assert.equal(redactUrl('/ajax/route?token=secret'), '/ajax/route');
  assert.equal(redactUrl(undefined), '');
  assert.equal(redactUrl(42), '');
});

test('records nothing while diagnostics are off', () => {
  setDiagLogEnabled(false);
  setDiagContext('worker');

  diagLog('graphql', { q: 'ReelsFeed' });

  assert.equal(diagLogEnabled(), false);
  assert.deepEqual(diagLogDrain(), []);
});

test('drains each event exactly once, stamped with its context', () => {
  setDiagLogEnabled(true);
  setDiagContext('hook');

  diagLog('graphql', { q: 'ReelsFeed', items: 12 });
  const first = diagLogDrain();

  assert.equal(first.length, 1);
  assert.equal(first[0]!.ctx, 'hook');
  assert.equal(first[0]!.ev, 'graphql');
  assert.deepEqual(first[0]!.data, { q: 'ReelsFeed', items: 12 });
  assert.deepEqual(diagLogDrain(), [], 'a drained event must not be reported twice');
});

test('reports the gap when the ring overflows instead of quietly narrowing the window', () => {
  setDiagLogEnabled(true);
  setDiagContext('worker');

  for (let i = 0; i < DIAG_EVENT_MAX + 5; i += 1) diagLog('net', { i });
  const events = diagLogDrain();

  assert.equal(events.length, DIAG_EVENT_MAX + 1, 'the ring keeps its cap, plus the overflow notice');
  assert.equal(events[0]!.ev, 'logOverflow');
  assert.deepEqual(events[0]!.data, { dropped: 5 });
  // The SURVIVORS are the newest: an overflowing log is being read for what just
  // happened, not for what happened first.
  assert.deepEqual(events[1]!.data, { i: 5 });
});

test('turning diagnostics off discards what was recorded under an unknown flag', () => {
  setDiagLogEnabled(true);
  setDiagContext('worker');
  diagLog('net', { url: 'x' });

  setDiagLogEnabled(false);

  assert.deepEqual(diagLogDrain(), []);
});

test('bounds an untrusted report by shape, context and size', () => {
  const bloated: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) bloated[`k${i}`] = 'v';

  const clean = sanitizeDiagEvents([
    { at: 1, ctx: 'hook', ev: 'graphql', data: { q: 'x'.repeat(500) } },
    { at: 2, ctx: 'renderer', ev: 'forged' }, // unknown context
    { at: 3, ctx: 'hook' }, // no event name
    { at: -1, ctx: 'hook', ev: 'negative' },
    { at: 'now', ctx: 'hook', ev: 'notANumber' },
    { at: 4, ctx: 'hook', ev: 'wide', data: bloated },
    { at: 5, ctx: 'hook', ev: 'nested', data: { child: { deep: true } } },
    'not an object',
  ]);

  assert.deepEqual(
    clean.map((e) => e.ev),
    ['graphql', 'wide', 'nested'],
  );
  assert.equal(clean[0]!.data!.q!.toString().length, 200, 'a long string is clamped, not dropped');
  assert.ok(Object.keys(clean[1]!.data!).length <= 12, 'the key budget bounds a wide payload');
  assert.equal(clean[2]!.data, undefined, 'a nested object is not a scalar, so nothing survives it');
  assert.deepEqual(sanitizeDiagEvents({ ev: 'notAnArray' }), []);
});

test('bounds how many untrusted events one report can carry', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ at: i, ctx: 'hook', ev: 'net' }));

  assert.equal(sanitizeDiagEvents(many, 10).length, 10);
});

test('keeps the newest events when the stored trace is over its count', () => {
  const events: DiagEvent[] = Array.from({ length: DIAG_LOG_MAX_EVENTS + 50 }, (_, i) => ({
    at: i,
    ctx: 'worker',
    ev: 'net',
  }));

  const trimmed = trimDiagLog(events);

  assert.equal(trimmed.length, DIAG_LOG_MAX_EVENTS);
  assert.equal(trimmed[trimmed.length - 1]!.at, DIAG_LOG_MAX_EVENTS + 49);
});

test('keeps the stored trace under its byte cap even when the count is legal', () => {
  // Under the count cap, but each event is near the per-event ceiling: the count
  // bound alone would let this through and it would land on storage.local at
  // roughly 900 KB, on a key space shared with the Saved ledger.
  const fat: DiagEvent[] = Array.from({ length: 1_500 }, (_, i) => ({
    at: i,
    ctx: 'worker',
    ev: 'net',
    data: { url: 'u'.repeat(160), file: 'f'.repeat(200), error: 'e'.repeat(200) },
  }));

  const trimmed = trimDiagLog(fat);

  assert.ok(trimmed.length < fat.length, 'the byte cap has to bite before the count does');
  assert.ok(JSON.stringify(trimmed).length <= 700 * 1024);
  assert.equal(trimmed[trimmed.length - 1]!.at, 1_499, 'and it drops the oldest, not the newest');
});

test('appends each context report to the stored trace instead of replacing it', async () => {
  await resetChromeStorage();

  await addDiagEvents([{ at: 2, ctx: 'worker', ev: 'net' }]);
  await addDiagEvents([{ at: 1, ctx: 'hook', ev: 'graphql' }]);

  const stored = await getDiagEvents();
  assert.deepEqual(
    stored.map((e) => e.ev),
    ['graphql', 'net'],
    'read back in time order, not arrival order',
  );

  await resetDiagLog();
  assert.deepEqual(await getDiagEvents(), []);
});

test('the worker observer coalesces renderer events into one write, stamped with the tab', async () => {
  const writes: DiagEvent[][] = [];
  const observer = createDiagObserver({
    write: async () => {},
    writeEvents: async (events) => {
      writes.push(events);
    },
    workerEvents: {
      drain: () => [{ at: 9, ctx: 'worker', ev: 'downloadFailed' }],
      setEnabled: () => {},
    },
    schedule: () => 1,
    cancel: () => {},
  });
  observer.setEnabled(true);

  observer.report(7, {}, [{ at: 1, ctx: 'hook', ev: 'graphql' }]);
  observer.report(8, {}, [{ at: 2, ctx: 'content', ev: 'domScan' }]);
  await observer.flush();

  assert.equal(writes.length, 1, 'two reports plus the worker drain must cost one storage write');
  assert.deepEqual(
    writes[0]!.map((e) => [e.ev, e.data?.tab]),
    [
      ['graphql', 7],
      ['domScan', 8],
      // The worker's own events carry no tab: they are not about one.
      ['downloadFailed', undefined],
    ],
  );
});

test('the observer drops renderer events while diagnostics are disabled', async () => {
  const writes: DiagEvent[][] = [];
  const observer = createDiagObserver({
    write: async () => {},
    writeEvents: async (events) => {
      writes.push(events);
    },
    schedule: () => 1,
    cancel: () => {},
  });

  assert.equal(observer.report(1, {}, [{ at: 1, ctx: 'hook', ev: 'graphql' }]), false);
  await observer.flush();

  assert.deepEqual(writes, []);
});

test('formats an event as one greppable line', () => {
  const line = formatDiagEvent({ at: 1_700_000_000_000, ctx: 'hook', ev: 'graphql', lvl: 'warn', data: { q: 'Reels', items: 3 } });

  assert.match(line, /^\d{2}:\d{2}:\d{2}\.\d{3} \[hook\] WARN graphql q=Reels items=3$/);
});

test('names an unknown throwable without letting it grow unbounded', () => {
  assert.equal(errorText(new TypeError('bad shape')), 'TypeError: bad shape');
  assert.equal(errorText({ toString: () => 'x'.repeat(500) }).length, 200);
  assert.equal(errorText(null), 'null');
});

test('the observer names its own ring when a burst outruns the pending bound', () => {
  // Three rings bound this path, and a gap in the exported trace is only readable if
  // it says which of them dropped the events. That `where` was the one thing the
  // three hand-copied rings did NOT have in common.
  const writes: DiagEvent[][] = [];
  const observer = createDiagObserver({
    write: async () => {},
    writeEvents: async (events) => {
      writes.push(events);
    },
    maxPendingEvents: 2,
    schedule: () => 1,
    cancel: () => {},
  });
  observer.setEnabled(true);

  for (let i = 1; i <= 4; i += 1) observer.report(7, {}, [{ at: i, ctx: 'hook', ev: `e${i}` }]);

  return observer.flush().then(() => {
    assert.deepEqual(
      writes[0]!.map((e) => e.ev),
      ['logOverflow', 'e3', 'e4'],
      'the survivors are the newest, and the gap is reported before them',
    );
    assert.deepEqual(writes[0]![0]!.data, { dropped: 2, where: 'observer' });
  });
});
