import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchDashTracks, fetchTrack } from '../src/shared/track-fetch';

const URL_OK = 'https://video.xx.fbcdn.net/v/track.mp4';

/** Yield chunks and optionally drop the connection. */
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

/** Record the Range header for each attempt. */
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
  assert.deepEqual(ranges, [null]); // A fresh read has no Range header.
});

test('resumes from the bytes already held after a mid-body drop', async () => {
  const { fetch, ranges } = fakeFetch([
    () => new Response(body(['abc', 'def'], 2)), // Drop after six bytes.
    () => new Response(body(['ghi']), { status: 206 }),
  ]);

  const blob = await fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0 });

  assert.equal(await textOf(blob), 'abcdefghi');
  assert.deepEqual(ranges, [null, 'bytes=6-']);
});

test('does not stitch a 206 that starts somewhere other than where it resumed', async () => {
  // Restart when a partial response begins at the wrong offset.
  const { fetch, ranges } = fakeFetch([
    () => new Response(body(['abc', 'def'], 2)), // Drop after six bytes.
    () =>
      new Response(body(['XYZ']), {
        status: 206,
        headers: { 'Content-Range': 'bytes 99-101/200' }, // Starts at the wrong byte.
      }),
    () => new Response(body(['abcdefghi'])), // Restart from zero.
  ]);

  const blob = await fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0 });

  assert.equal(await textOf(blob), 'abcdefghi', 'the mismatched range must not be stitched in');
  assert.deepEqual(ranges, [null, 'bytes=6-', null], 'the third attempt restarts from zero');
});

test('takes a 206 that carries the whole file as the whole file', async () => {
  // Replace buffered bytes when a partial response restarts at zero.
  const { fetch } = fakeFetch([
    () => new Response(body(['abc'], 1)), // Drop after three bytes.
    () =>
      new Response(body(['abcdef']), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-5/6' },
      }),
  ]);

  assert.equal(await textOf(await fetchTrack(URL_OK, () => {}, { fetch, retryDelayMs: 0 })), 'abcdef');
});

test('keeps every byte in order across the seal boundary', async () => {
  // Blob sealing must preserve chunk order and the final unsealed tail.
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
    () => new Response(body(['abc'], 1)), // Drop after three bytes.
    // A full response replaces the three buffered bytes.
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
  // Do not retry a terminal 403 response.
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

  // A restart must reset cumulative progress to the real byte count.
  assert.deepEqual(seen, [3, 0, 6]);
});

test('rejects an advertised response that exceeds the track ceiling before reading it', async () => {
  const seen: number[] = [];
  // Use progress to confirm that no body bytes were accepted.
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
  // Propagate the caller's abort signal to the internal request controller.
  const fetch = ((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  }) as typeof globalThis.fetch;

  const external = new AbortController();
  const cancelReason = new Error('caller cancelled');
  // Bound the test with one attempt and a short stall timeout.
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
  // Error identity proves that the caller's signal reached the fetch.
  assert.equal(caught, cancelReason);
});
