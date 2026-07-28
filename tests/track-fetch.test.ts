import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchDashTracks, fetchTrack } from '../src/shared/track-fetch';

const URL_OK = 'https://video.xx.fbcdn.net/v/track.mp4';

/** A body that yields `chunks`, then optionally drops the connection. */
function body(chunks: string[], failAfter?: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (failAfter !== undefined && i === failAfter) {
        c.error(new Error('network dropped'));
        return;
      }
      if (i >= chunks.length) {
        c.close();
        return;
      }
      c.enqueue(enc.encode(chunks[i++]));
    },
  });
}

/** Records the Range header of every attempt so tests can assert on resumption. */
function fakeFetch(responses: (() => Response)[]): { fetch: typeof globalThis.fetch; ranges: (string | null)[] } {
  const ranges: (string | null)[] = [];
  let call = 0;
  const fetch = ((_url: string, init?: RequestInit) => {
    ranges.push(new Headers(init?.headers).get('Range'));
    const make = responses[Math.min(call++, responses.length - 1)];
    return Promise.resolve(make());
  }) as typeof globalThis.fetch;
  return { fetch, ranges };
}

async function textOf(b: Blob): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await b.arrayBuffer()));
}

test('refuses a track URL outside fbcdn', async () => {
  const { fetch } = fakeFetch([() => new Response('nope')]);

  await assert.rejects(fetchTrack('https://evil.example.com/v.mp4', () => {}, { fetch }), {
    message: 'Track URL not allowed.',
  });
});

test('returns the whole body when the read succeeds first time', async () => {
  const { fetch, ranges } = fakeFetch([() => new Response(body(['abc', 'def']))]);

  const blob = await fetchTrack(URL_OK, () => {}, { fetch });

  assert.equal(await textOf(blob), 'abcdef');
  assert.deepEqual(ranges, [null]); // no Range header on a fresh read
});

test('resumes from the bytes already held after a mid-body drop', async () => {
  const { fetch, ranges } = fakeFetch([
    () => new Response(body(['abc', 'def'], 2)), // 6 bytes, then drops
    () => new Response(body(['ghi']), { status: 206 }),
  ]);

  const blob = await fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0 });

  assert.equal(await textOf(blob), 'abcdefghi');
  assert.deepEqual(ranges, [null, 'bytes=6-']);
});

test('does not stitch a 206 that starts somewhere other than where it resumed', async () => {
  // A 206 says "here is A range", not "here is the range you asked for". Appending a
  // body that starts at the wrong offset makes the file LONGER than the source, and
  // the remuxer's bounds check only catches files that are too SHORT — so this used
  // to ship as a successful download of a broken track.
  const { fetch, ranges } = fakeFetch([
    () => new Response(body(['abc', 'def'], 2)), // 6 bytes, then drops
    () =>
      new Response(body(['XYZ']), {
        status: 206,
        headers: { 'Content-Range': 'bytes 99-101/200' }, // not byte 6
      }),
    () => new Response(body(['abcdefghi'])), // clean restart from zero
  ]);

  const blob = await fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0 });

  assert.equal(await textOf(blob), 'abcdefghi', 'the mismatched range must not be stitched in');
  assert.deepEqual(ranges, [null, 'bytes=6-', null], 'the third attempt restarts from zero');
});

test('takes a 206 that carries the whole file as the whole file', async () => {
  // Content-Range starting at 0 means the head we hold is already in this body;
  // keeping both would duplicate it.
  const { fetch } = fakeFetch([
    () => new Response(body(['abc'], 1)), // 3 bytes, then drops
    () =>
      new Response(body(['abcdef']), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-5/6' },
      }),
  ]);

  assert.equal(await textOf(await fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0 })), 'abcdef');
});

test('keeps every byte in order across the seal boundary', async () => {
  // Chunks are sealed into Blobs every 16 MB so they can leave the JS heap instead
  // of all staying resident until the end. Sealing must not reorder or lose bytes,
  // and the tail after the last seal must still make it out.
  const oneMb = 'x'.repeat(1024 * 1024);
  const chunks = [...Array.from({ length: 17 }, () => oneMb), 'TAIL'];
  const { fetch } = fakeFetch([() => new Response(body(chunks))]);

  const blob = await fetchTrack(URL_OK, () => {}, { fetch });

  assert.equal(blob.size, 17 * 1024 * 1024 + 4, 'every byte must survive sealing');
  const text = await textOf(blob);
  assert.ok(text.endsWith('TAIL'), 'the unsealed tail must be appended last');
  assert.equal(text.indexOf('TAIL'), 17 * 1024 * 1024, 'and nothing may be reordered before it');
});

test('restarts from scratch when the server ignores the Range request', async () => {
  const { fetch } = fakeFetch([
    () => new Response(body(['abc'], 1)), // 3 bytes, then drops
    // 200, not 206: this body is the WHOLE file, so keeping the first 3 bytes
    // would duplicate them and corrupt the track.
    () => new Response(body(['abcdef']), { status: 200 }),
  ]);

  const blob = await fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0 });

  assert.equal(await textOf(blob), 'abcdef');
});

test('gives up after the attempt limit and surfaces the failure', async () => {
  const { fetch, ranges } = fakeFetch([() => new Response(body(['ab'], 1))]);

  await assert.rejects(fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0, attempts: 3 }));
  assert.equal(ranges.length, 3);
});

test('does not retry a hard HTTP failure', async () => {
  // An expired fbcdn URL answers 403 every time; retrying only delays the error
  // the user needs to see (reload the page to get fresh URLs).
  const { fetch, ranges } = fakeFetch([() => new Response('gone', { status: 403 })]);

  await assert.rejects(fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0 }), /403/);
  assert.equal(ranges.length, 1);
});

test('reports progress as bytes arrive, and rewinds when a restart discards them', async () => {
  const seen: number[] = [];
  const { fetch } = fakeFetch([
    () => new Response(body(['abc'], 1)),
    () => new Response(body(['abcdef']), { status: 200 }),
  ]);

  await fetchTrack(URL_OK, (total) => seen.push(total), { fetch, retryDelayMs: 0 });

  // Cumulative totals, and the restart must report the drop rather than letting
  // the worker's progress run past the real byte count.
  assert.deepEqual(seen, [3, 0, 6]);
});

test('rejects an advertised response that exceeds the track ceiling before reading it', async () => {
  const seen: number[] = [];
  // The Response constructor itself may prime a stream, so progress (rather
  // than pull()) is the reliable proof that fetchTrack accepted no body bytes.
  const stream = new ReadableStream<Uint8Array>({ pull() {} });
  const { fetch } = fakeFetch([() => new Response(stream, { headers: { 'Content-Length': '6' } })]);

  await assert.rejects(fetchTrack(URL_OK, (bytes) => seen.push(bytes), { fetch, maxBytes: 5 }), /track exceeds the 5-byte safety limit/);
  assert.deepEqual(seen, []);
});

test('enforces the track ceiling while streaming without Content-Length', async () => {
  const { fetch } = fakeFetch([() => new Response(body(['abc', 'def']))]);

  await assert.rejects(fetchTrack(URL_OK, () => {}, { fetch, maxBytes: 5 }), /track exceeds the 5-byte safety limit/);
});

test('enforces one combined budget across both parallel track fetches', async () => {
  const { fetch } = fakeFetch([
    () => new Response(body(['abc'])),
    () => new Response(body(['def'])),
  ]);

  await assert.rejects(
    fetchDashTracks(URL_OK, URL_OK, () => {}, () => {}, { fetch, maxBytes: 10, maxTotalBytes: 5 }),
    /combined exceeds the 5-byte safety limit/,
  );
});

test('aborts the sibling request when one advertised track is oversized', async () => {
  let siblingAborted = false;
  let call = 0;
  const fetch = ((_url: string, init?: RequestInit) => {
    if (call++ === 0) {
      return Promise.resolve(new Response(body([]), { headers: { 'Content-Length': '11' } }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        siblingAborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }) as typeof globalThis.fetch;

  await assert.rejects(
    fetchDashTracks(URL_OK, URL_OK, () => {}, () => {}, { fetch, maxBytes: 10 }),
    /track exceeds the 10-byte safety limit/,
  );
  assert.equal(siblingAborted, true);
});

test('propagates a caller-supplied abort signal into the in-flight fetches', async () => {
  // childOpts replaces opts.signal with the internal controller's own signal,
  // so without linking the two, aborting the caller's signal did nothing and
  // the fetch ran to completion (or hung) regardless.
  const fetch = ((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }) as typeof globalThis.fetch;

  const external = new AbortController();
  const cancelReason = new Error('caller cancelled');
  // attempts: 1 and a short stallMs bound the failure mode where propagation
  // is broken: the internal idle-stall timer still ends the hang quickly
  // instead of the test running for the default 60s STALL_MS.
  const promise = fetchDashTracks(URL_OK, URL_OK, () => {}, () => {}, {
    fetch,
    signal: external.signal,
    attempts: 1,
    stallMs: 30,
  });

  external.abort(cancelReason);

  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  // Identity, not just "it rejected": a stall-timeout rejection would also
  // make the promise reject, but with a different error, so this is the only
  // outcome that proves the caller's own signal actually reached the fetch.
  assert.equal(caught, cancelReason);
});
