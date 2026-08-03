// Provide the DOMParser surface required to test MPD content protection.

import assert from 'node:assert/strict';
import test from 'node:test';

import { fromMpdXml } from '../src/shared/dash';
import { diagDrain } from '../src/shared/diag';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (value: string): string =>
  value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name]!);

/** Search descendants with the same scope as `getElementsByTagName`. */
function collect(nodes: readonly FakeElement[], tagName: string, out: FakeElement[] = []): FakeElement[] {
  for (const node of nodes) {
    if (node.tagName === tagName) out.push(node);
    collect(node.children, tagName, out);
  }
  return out;
}

class FakeElement {
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | FakeDocument | null = null;
  private text = '';

  constructor(
    readonly tagName: string,
    private readonly attrs: ReadonlyMap<string, string>,
  ) {}

  // BaseURL is a leaf in every test fixture.
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  addText(value: string): void {
    this.text += value;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  getElementsByTagName(tagName: string): FakeElement[] {
    return collect(this.children, tagName);
  }
}

class FakeDocument {
  readonly children: FakeElement[] = [];

  getElementsByTagName(tagName: string): FakeElement[] {
    return collect(this.children, tagName);
  }
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;

// Model only the well-formed XML used by this suite.
function parseXml(xml: string): FakeDocument {
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const doc = new FakeDocument();
  const stack: (FakeDocument | FakeElement)[] = [doc];
  let last = 0;
  for (let match = TAG.exec(body); match != null; match = TAG.exec(body)) {
    const parent = stack[stack.length - 1]!;
    const text = body.slice(last, match.index);
    last = TAG.lastIndex;
    if (parent instanceof FakeElement && text.trim() !== '') parent.addText(decode(text));
    if (match[1] === '/') {
      stack.pop();
      continue;
    }
    const attrs = new Map<string, string>();
    for (const attr of match[3]!.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) {
      attrs.set(attr[1]!, decode(attr[2]!));
    }
    const el = new FakeElement(match[2]!, attrs);
    el.parentNode = parent;
    parent.children.push(el);
    if (match[4] !== '/') stack.push(el);
  }
  return doc;
}

class FakeDOMParser {
  parseFromString(xml: string, _type: string): FakeDocument {
    return parseXml(xml);
  }
}

// Install the parser before `fromMpdXml` runs.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = FakeDOMParser;

const HD = 'https://video.xx.fbcdn.net/v/t2/1080.mp4?efg=a&amp;oh=1';
const SD = 'https://video.xx.fbcdn.net/v/t2/480.mp4?efg=b&amp;oh=2';
const AUDIO = 'https://video.xx.fbcdn.net/v/t2/audio.mp4?efg=c&amp;oh=3';
const plain = (url: string): string => decode(url);

const DRM = '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>';

const video = (inner: string): string => `<AdaptationSet mimeType="video/mp4">${inner}</AdaptationSet>`;
const rep = (attrs: string, base: string, inner = ''): string =>
  `<Representation ${attrs}>${inner}<BaseURL>${base}</BaseURL></Representation>`;
const HD_REP = 'codecs="avc1.4d401f" bandwidth="2500000" width="1080" height="1920"';
const SD_REP = 'codecs="avc1.4d401e" bandwidth="800000" width="480" height="854"';
const AUDIO_SET = `<AdaptationSet mimeType="audio/mp4">${rep('codecs="mp4a.40.2" bandwidth="128000"', AUDIO)}</AdaptationSet>`;

const mpd = (periodInner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<MPD mediaPresentationDuration="PT1M23S"><Period>${periodInner}</Period></MPD>`;

test('a clean MPD yields one pair per video representation, highest first', () => {
  diagDrain();
  const pairs = fromMpdXml(mpd(video(rep(SD_REP, SD) + rep(HD_REP, HD)) + AUDIO_SET));

  assert.equal(pairs.length, 2);
  assert.deepEqual(
    pairs.map((p) => [p.height, p.width, p.videoUrl]),
    [
      [1920, 1080, plain(HD)],
      [854, 480, plain(SD)],
    ],
  );
  // Every video rung must link the audio track and the complete track URL set.
  for (const pair of pairs) {
    assert.equal(pair.audioUrl, plain(AUDIO));
    assert.equal(pair.durationSec, 83);
    assert.deepEqual(pair.trackUrls, [plain(SD), plain(HD), plain(AUDIO)]);
  }
  assert.deepEqual(diagDrain(), {}, 'nothing was discarded');
});

test('a ContentProtection directly on the AdaptationSet drops the whole set', () => {
  diagDrain();
  const pairs = fromMpdXml(mpd(video(DRM + rep(HD_REP, HD) + rep(SD_REP, SD)) + AUDIO_SET));

  assert.deepEqual(pairs, [], 'a Widevine ladder must not reach the quality menu');
  assert.deepEqual(diagDrain(), { drmSkipped: 1 }, 'skipped as DRM, not as an unreadable representation');
});

test('a ContentProtection nested in one Representation drops only that rung', () => {
  const xml = mpd(video(rep(HD_REP, HD, DRM) + rep(SD_REP, SD)) + AUDIO_SET);

  // Nested protection must not mark clear sibling representations as protected.
  const set = parseXml(xml).getElementsByTagName('AdaptationSet')[0]!;
  assert.equal(set.getElementsByTagName('ContentProtection').length, 1);

  diagDrain();
  const pairs = fromMpdXml(xml);
  assert.deepEqual(
    pairs.map((p) => p.videoUrl),
    [plain(SD)],
  );
  assert.equal(pairs[0]!.audioUrl, plain(AUDIO));
  assert.deepEqual(pairs[0]!.trackUrls, [plain(SD), plain(AUDIO)], 'the DRM track is not offered anywhere');
  assert.deepEqual(diagDrain(), { drmSkipped: 1 });
});
