// The in-page download button. The behavioural tests drive the overlay against
// a minimal DOM/window pair; the contract tests pin the trust boundary, which is
// the part of this feature that must not regress quietly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDownloadOverlay,
  pickAnchorElement,
  pickControlAnchor,
} from '../src/content/download-overlay';
import { optionForLabel, playingItems, videoGroupOf } from '../src/shared/video-options';
import { downloadFilename, itemCardId, videoCardId } from '../src/shared/download-naming';
import { mediaId, videoGroupKey, type MediaItem } from '../src/shared/media';

const ROOT = process.cwd();
const worker = readFileSync(join(ROOT, 'src', 'background', 'service-worker.ts'), 'utf8');
const overlaySource = readFileSync(join(ROOT, 'src', 'content', 'download-overlay.ts'), 'utf8');

// ── The trust boundary ──────────────────────────────────────────────────────
// FACESCRAP_DOWNLOAD_DASH/_DIRECT carry a URL, so they refuse a content script.
// The two in-page messages carry none and must therefore REQUIRE a tab. Getting
// either polarity backwards is the whole risk of this feature.

test('keeps refusing URL-carrying download messages from a content script', () => {
  for (const type of ['FACESCRAP_DOWNLOAD_DASH', 'FACESCRAP_DOWNLOAD_DIRECT']) {
    const at = worker.indexOf(`m?.type === '${type}'`);
    assert.ok(at >= 0, `missing the ${type} handler`);
    const body = worker.slice(at, at + 600);
    assert.match(
      body,
      /if \(sender\.tab\) \{[\s\S]*?Unauthorized request\./,
      `${type} must reject a sender that has a tab — it accepts a caller-supplied URL`,
    );
  }
});

test('the in-page messages require a Facebook tab and never trust a tab id from the page', () => {
  const at = worker.indexOf("m?.type === 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS'");
  assert.ok(at >= 0, 'missing the in-page download handler');
  const body = worker.slice(at, worker.indexOf('return undefined;', at));

  assert.match(body, /senderTab\?\.id == null/, 'must refuse a sender without a tab');
  assert.match(body, /FB_URL\.test\(senderTab\.url \?\? ''\)/, 'must refuse a non-Facebook tab');
  assert.match(body, /const tid = senderTab\.id;/, 'the tab must come from sender, not the message');
  // The message shape has no tabId at all, but assert the handler never reads one
  // even if somebody adds it later.
  assert.doesNotMatch(body, /msg as[^;]*tabId/, 'the handler must not read a tab id out of the message');
  assert.doesNotMatch(body, /request\.tabId|\.tabId as number/, 'no caller-supplied tab id in this path');
});

test('the options reply carries resolution labels only, never a URL', () => {
  const at = worker.indexOf("m?.type === 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS'");
  const body = worker.slice(at, worker.indexOf('return undefined;', at));
  // Every options response in this handler.
  const replies = [...body.matchAll(/sendResponse\(\{\s*ok: true,\s*media:[\s\S]*?\}\);/g)].map((m) => m[0]);
  assert.ok(replies.length >= 2, 'expected the video and image option replies');
  for (const reply of replies) {
    assert.doesNotMatch(reply, /\burl\b|videoUrl|audioUrl|thumbUrl/i, `an options reply leaks a URL: ${reply}`);
  }
  assert.match(body, /labels: options\.map\(\(i\) => resolutionOf\(i\)\.label\)/);
});

test('the overlay never sends a media URL — only a message type and a label', () => {
  // It may only ever send these two message types...
  const sent = [...overlaySource.matchAll(/type: '(FACESCRAP_[A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(sent)].sort(),
    ['FACESCRAP_PLAYING_DOWNLOAD_OPTIONS', 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD'],
    'the overlay must not reach for the URL-carrying download messages',
  );

  // ...carrying nothing but `type` and `label`.
  //
  // This replaces a blunt ban on the word "fbcdn" appearing in the file. That ban
  // was the wrong proxy: the anchor picker now READS the page's own
  // background-image to find photo stories painted as a <div>, so it legitimately
  // recognises an fbcdn URL that the page already had. The invariant is not "never
  // sees a URL" — it is "never TELLS the worker one", because that is what would
  // let a compromised page aim the downloader.
  const payloads = [...overlaySource.matchAll(/sendMessage\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]!);
  assert.ok(payloads.length >= 2, `expected both send sites, found ${payloads.length}`);
  for (const payload of payloads) {
    const keys = [...new Set([...payload.matchAll(/(\w+)\s*:/g)].map((m) => m[1]!))].sort();
    assert.deepEqual(keys.filter((key) => key !== 'type' && key !== 'label'), [], `extra key in ${payload}`);
  }

  // It hangs off documentElement, in a closed shadow root, so Facebook's
  // re-renders cannot drop it and neither side's CSS leaks.
  assert.match(overlaySource, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.match(overlaySource, /doc\.documentElement\.appendChild\(host\)/);
});

// ── Label resolution ────────────────────────────────────────────────────────

function video(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'fb:1',
    url: 'https://video.xx.fbcdn.net/v/t42/1_n.mp4',
    kind: 'video',
    source: 'highlight',
    origin: 'graphql',
    addedAt: 1,
    ...overrides,
  };
}

test('optionForLabel matches the requested resolution, and falls back rather than failing', () => {
  const hd = video({ id: 'fb:hd', url: 'https://video.xx.fbcdn.net/v/t42/hd_n.mp4', height: 1080 });
  const sd = video({ id: 'fb:sd', url: 'https://video.xx.fbcdn.net/v/t42/sd_n.mp4', height: 720 });
  const options = [hd, sd];

  assert.equal(optionForLabel(options, '720p', 'highest')?.id, 'fb:sd');
  assert.equal(optionForLabel(options, '1080p', 'highest')?.id, 'fb:hd');
  // A menu left open while the representations changed must still download
  // something sensible, not nothing.
  assert.equal(optionForLabel(options, '4320p', 'highest')?.id, 'fb:hd', 'unknown label → settings default');
  assert.equal(optionForLabel(options, undefined, 'lowest')?.id, 'fb:sd', 'no label → settings default');
  assert.equal(optionForLabel([], '720p', 'highest'), undefined);
});

// ── What the button is allowed to offer ─────────────────────────────────────
// The first version asked selectPlaying() — the DETECTOR, which endorses, learns
// durable bindings and writes the playing pin. A polling handler on that state is
// a second writer, and it broke detection and the downloads that follow from it.

test('resolves what is playing without running the detector', () => {
  assert.doesNotMatch(worker, /selectPlaying/, 'the worker must not run the detector at all');
  const at = worker.indexOf("m?.type === 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS'");
  const body = worker.slice(at, worker.indexOf('return undefined;', at));
  assert.match(body, /playingItems\(ref, items, bind\)/, 'must use the pure read');

  const shared = readFileSync(join(ROOT, 'src', 'shared', 'video-options.ts'), 'utf8');
  const selector = shared.slice(shared.indexOf('export function playingItems'));
  const end = selector.indexOf('\n}\n');
  // Nothing in the selector may write: no storage, no learning, no pin.
  assert.doesNotMatch(
    selector.slice(0, end),
    /persist|remember|\.set\(|scheduleBindFlush|endorse/,
    'playingItems must stay a pure read',
  );
});

test('offers video representations only — never the audio track of the same video', () => {
  // One asset id in the efg of every representation is what groups them, exactly
  // as fbcdn serves it: the audio track carries the SAME key as the video ones.
  const efg = Buffer.from(JSON.stringify({ xpv_asset_id: '9911' })).toString('base64url');
  const track = (name: string) => `https://video.xx.fbcdn.net/v/t42/${name}_n.mp4?efg=${efg}`;
  const audio = video({ id: 'fb:a', url: track('audio'), kind: 'audio' });
  const hd = video({ id: 'fb:hd', url: track('hd'), height: 1080 });
  assert.equal(videoGroupKey(audio), videoGroupKey(hd), 'the fixture must share one group key');
  const items = [hd, audio, video({ id: 'fb:img', url: track('cover'), kind: 'image' })];
  const group = videoGroupOf(hd, items);
  assert.deepEqual(
    group.map((i) => i.id),
    ['fb:hd'],
    'an audio representation shares the group key — letting it in is how the button downloaded audio',
  );
  for (const item of group) assert.equal(item.kind, 'video');

  // The helper being right is not enough — the wiring is what was wrong.
  const at = worker.indexOf("m?.type === 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS'");
  assert.match(worker.slice(at, worker.indexOf('return undefined;', at)), /videoGroupOf\(video, items\)/);
});

test('fails a download it cannot serve instead of reporting success', () => {
  const at = worker.indexOf("m?.type === 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS'");
  const body = worker.slice(at, worker.indexOf('return undefined;', at));
  // "Nothing to offer" is a normal answer to the query and a failure for a
  // download — answering ok would put "Saved" on a button that saved nothing.
  assert.match(
    body,
    /if \(wantsDownload\) sendResponse\(\{ ok: false[\s\S]{0,120}else sendResponse\(\{ ok: true, media: undefined \}\)/,
  );
});

test('a learned cover binding identifies an MSE video the ids alone cannot', () => {
  // A story or reel plays under MSE, so content.ts refuses to turn its blob:
  // currentSrc into an id (content.ts:973). The only thing naming the video in
  // ref.ids is its COVER — and when no captured item happens to carry that exact
  // cover as its thumbUrl, nothing matches and the button never appears on video.
  const efg = Buffer.from(JSON.stringify({ xpv_asset_id: '4242' })).toString('base64url');
  const track = (name: string) => `https://video.xx.fbcdn.net/v/t42/${name}_n.mp4?efg=${efg}`;
  const hd = video({ id: 'fb:hd', url: track('hd'), height: 1080 });
  const sd = video({ id: 'fb:sd', url: track('sd'), height: 720 });
  const unrelated = video({ id: 'fb:other', url: 'https://video.xx.fbcdn.net/v/t42/x_n.mp4' });
  const items = [hd, sd, unrelated];
  assert.notEqual(videoGroupKey(hd), videoGroupKey(unrelated), 'the fixture must not group everything');

  const coverId = 'story-cover-1';
  const ref = { ids: [coverId], hasVideo: true };
  assert.deepEqual(playingItems(ref, items), [], 'the cover alone matches nothing — that is the bug');

  const bindings = { coverBind: [[coverId, videoGroupKey(hd)]] as [string, string][] };
  assert.deepEqual(
    playingItems(ref, items, bindings).map((i) => i.id),
    ['fb:hd', 'fb:sd'],
    'the binding names the group, and the whole resolution ladder comes back with it',
  );
});

test('the cover binding is a fallback, never an override', () => {
  const efg = Buffer.from(JSON.stringify({ xpv_asset_id: '4242' })).toString('base64url');
  const hd = video({ id: 'fb:hd', url: `https://video.xx.fbcdn.net/v/t42/hd_n.mp4?efg=${efg}` });
  const other = video({ id: 'fb:other', url: 'https://video.xx.fbcdn.net/v/t42/x_n.mp4' });
  const photo = video({ id: 'fb:photo', kind: 'image', url: 'https://scontent.xx.fbcdn.net/v/t51/p.jpg' });
  const items = [hd, other, photo];
  const coverId = 'story-cover-1';
  const bindings = { coverBind: [[coverId, videoGroupKey(hd)]] as [string, string][] };

  // A photo story is not a video whose match failed — it matched nothing because
  // no video is playing. Forcing the binding here would offer the wrong media.
  assert.deepEqual(playingItems({ ids: [coverId], hasVideo: false }, items, bindings), []);

  // Live evidence outranks the binding: the cover is present AND bound to hd's
  // group, but a video already matched on its own id, so that match stands. The
  // binding is a FIFO cache that can hold a stale row — it is the last resort.
  assert.deepEqual(
    playingItems({ ids: ['fb:other', coverId], hasVideo: true }, items, bindings).map((i) => i.id),
    ['fb:other'],
  );
});

test('playingItems matches on the stored ids, on a cover, and on the URL video id', () => {
  const efg = (fields: Record<string, string>) =>
    Buffer.from(JSON.stringify(fields)).toString('base64url');
  const watched = video({
    id: 'fb:watched',
    url: `https://video.xx.fbcdn.net/v/t42/w_n.mp4?efg=${efg({ video_id: '555' })}`,
  });
  const byCover = video({ id: 'fb:cover', thumbUrl: 'https://scontent.xx.fbcdn.net/v/t51/c.jpg' });
  const other = video({ id: 'fb:other' });

  const items = [watched, byCover, other];
  assert.deepEqual(playingItems({ ids: ['fb:other'] }, items).map((i) => i.id), ['fb:other']);
  // A prefetched neighbour is not playing just because it was captured.
  assert.deepEqual(playingItems({ ids: [] }, items), []);
  assert.deepEqual(playingItems(null, items), []);
  // The page URL names the watched video: matches the efg vid: key of every one
  // of its representations, and nothing else.
  assert.deepEqual(playingItems({ ids: [], vid: '555' }, items).map((i) => i.id), ['fb:watched']);
  // A centred cover identifies the video it belongs to.
  const coverId = playingItems({ ids: [mediaId(byCover.thumbUrl!)] }, items).map((i) => i.id);
  assert.deepEqual(coverId, ['fb:cover']);
});

test('the worker builds the same card ids and filenames the panel would', () => {
  // A different card id here would write a SECOND Saved row for one download.
  assert.equal(videoCardId('gk'), 'v:gk');
  assert.equal(itemCardId('fb:1'), 'i:fb:1');
  const name = downloadFilename(video({ addedAt: Date.parse('2026-07-27T10:20:30Z') }), {
    filenameTemplate: '{source}-{id}',
    subfolder: true,
  });
  assert.match(name, /^FaceScrap\/highlight-/);
  assert.ok(name.endsWith('.mp4'), name);
});

// ── Anchoring ───────────────────────────────────────────────────────────────

const rect = (r: Partial<DOMRect>): DOMRect =>
  ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...r }) as DOMRect;

function fakeDoc(
  elements: Partial<Record<'video' | 'img' | 'control', Array<Partial<DOMRect>>>>,
): Document {
  const make = (tag: string, r: Partial<DOMRect>): Element =>
    ({ tagName: tag.toUpperCase(), getBoundingClientRect: () => rect(r) }) as unknown as Element;
  const videos = (elements.video ?? []).map((r) => make('video', r));
  const images = (elements.img ?? []).map((r) => make('img', r));
  const controls = (elements.control ?? []).map((r) => make('div', r));
  return {
    querySelectorAll: (sel: string) =>
      sel === 'video' ? videos : sel === 'img' ? images : controls,
  } as unknown as Document;
}

const win = { innerWidth: 1000, innerHeight: 800 } as unknown as Window;

/** Enough window for the factory's own listener registration. The two paths
 *  exercised below bail out before any element is built, so no DOM is needed —
 *  this repo ships no jsdom and takes no new dependencies. */
function stubWin(): Window {
  return {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  } as unknown as Window;
}
const stubDoc = (): Document => fakeDoc({ video: [], img: [] });

test('anchors to the media under the viewport centre, preferring video over its poster', () => {
  const centred = { left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 };
  const offscreen = { left: -900, top: 0, right: -100, bottom: 800, width: 800, height: 800 };

  // A story video and the poster <img> behind it both cover the centre: the
  // video must win, or the button would track a stale poster box.
  const doc = fakeDoc({ video: [centred], img: [{ ...centred, width: 500, height: 900 }] });
  assert.equal((pickAnchorElement(doc, win) as Element).tagName, 'VIDEO');

  // Fully offscreen candidates are ignored.
  assert.equal(pickAnchorElement(fakeDoc({ video: [offscreen], img: [] }), win), undefined);

  // Chrome-sized images (avatars, tray thumbs) never anchor the button.
  const small = { left: 480, top: 380, right: 520, bottom: 420, width: 40, height: 40 };
  assert.equal(pickAnchorElement(fakeDoc({ video: [], img: [small] }), win), undefined);

  // With no video, a large centred image does anchor it.
  assert.equal((pickAnchorElement(fakeDoc({ video: [], img: [centred] }), win) as Element).tagName, 'IMG');
});

test('anchors a photo story Facebook painted as a background-image div', () => {
  // The worker offers these for download — the detector reads the cover URL off a
  // background-image as readily as off an <img> — so a button that only knows how
  // to anchor to <img> is not intermittently missing on them, it never appears.
  const centred = { left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 };
  const full = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
  const div = (r: Partial<DOMRect>, backgroundImage: string): Element =>
    ({ tagName: 'DIV', backgroundImage, getBoundingClientRect: () => rect(r) }) as unknown as Element;

  const photo = div(centred, 'url("https://scontent-mad1-1.xx.fbcdn.net/v/t51.0-15/story.jpg")');
  // Top-first, the way elementsFromPoint returns them: the viewer's own scrim has
  // no image at all, and the sprite below it is fbcdn-hosted chrome, not media.
  const stack = [
    div(full, 'none'),
    div(centred, 'url("https://static.xx.fbcdn.net/rsrc.php/v3/sprite.png")'),
    photo,
  ];
  const doc = {
    querySelectorAll: () => [],
    elementsFromPoint: () => stack,
  } as unknown as Document;
  const styled = {
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: (el: Element) => ({
      backgroundImage: (el as unknown as { backgroundImage: string }).backgroundImage,
    }),
  } as unknown as Window;

  assert.equal(pickAnchorElement(doc, styled), photo);

  // A <video> or an <img> still wins outright — this pass is the last resort, and
  // running it first would anchor the button to a card behind the media.
  const withVideo = {
    querySelectorAll: (sel: string) =>
      sel === 'video' ? [{ tagName: 'VIDEO', getBoundingClientRect: () => rect(centred) }] : [],
    elementsFromPoint: () => stack,
  } as unknown as Document;
  assert.equal((pickAnchorElement(withVideo, styled) as Element).tagName, 'VIDEO');
});

// The first placement put the button in the media's top-right corner — which is
// exactly where Facebook's story controls live, so it covered the mute, play and
// more buttons. It now joins that row instead of landing on it.

/** A media element with a chain of ancestors, so the control search can walk up
 *  out of the media box the way it does in a real story viewer. */
function anchoredMedia(mediaRect: Partial<DOMRect>, ancestors: Array<Partial<DOMRect>>): Element {
  let parent: Element | null = null;
  for (const box of [...ancestors].reverse()) {
    const node: Element = {
      getBoundingClientRect: () => rect(box),
      parentElement: parent,
    } as unknown as Element;
    parent = node;
  }
  return { tagName: 'IMG', getBoundingClientRect: () => rect(mediaRect), parentElement: parent } as unknown as Element;
}

test('anchors to the left of the leftmost control in Facebook own row', () => {
  // A video story fills its card, so the row is inside the media's own rect.
  const filled = { left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 };
  const row = [
    { left: 570, top: 120, right: 602, bottom: 152, width: 32, height: 32 },
    { left: 606, top: 120, right: 638, bottom: 152, width: 32, height: 32 },
    { left: 642, top: 120, right: 674, bottom: 152, width: 32, height: 32 },
  ];
  const found = pickControlAnchor(fakeDoc({ control: row }), win, anchoredMedia(filled, [filled]));
  assert.equal(found?.left, 570, 'must pick the leftmost control, not the nearest edge');
  assert.equal(found?.height, 32, 'the row height is what sizes our button');

  // The author's avatar sits in the same band, on the left half.
  const avatar = { left: 312, top: 116, right: 352, bottom: 156, width: 40, height: 40 };
  assert.equal(
    pickControlAnchor(fakeDoc({ control: [avatar] }), win, anchoredMedia(filled, [filled])),
    undefined,
  );

  // A text button is too wide to be a control; the viewer's close button is
  // outside the card.
  const follow = { left: 560, top: 120, right: 680, bottom: 152, width: 120, height: 32 };
  const close = { left: 940, top: 24, right: 972, bottom: 56, width: 32, height: 32 };
  assert.equal(
    pickControlAnchor(fakeDoc({ control: [follow, close] }), win, anchoredMedia(filled, [filled])),
    undefined,
  );

  // Controls further down the card (a feed player's own bar) are not the row.
  const bottomBar = { left: 560, top: 640, right: 592, bottom: 672, width: 32, height: 32 };
  assert.equal(
    pickControlAnchor(fakeDoc({ control: [bottomBar] }), win, anchoredMedia(filled, [filled])),
    undefined,
  );
});

// The bug: on a photo story the image is letterboxed inside the card, so the
// control row sits ABOVE the image and a search bounded by the media rect found
// nothing. The button then fell back to the image's corner and drifted with it.
test('finds the row above a letterboxed photo, and refuses the page own top bar', () => {
  // The card, and the photo inside it — the geometry of the reported case.
  const card = { left: 12, top: 30, right: 500, bottom: 860, width: 488, height: 830 };
  const photo = { left: 12, top: 265, right: 500, bottom: 635, width: 488, height: 370 };
  const row = [
    { left: 415, top: 50, right: 447, bottom: 82, width: 32, height: 32 },
    { left: 451, top: 50, right: 483, bottom: 82, width: 32, height: 32 },
  ];
  const found = pickControlAnchor(fakeDoc({ control: row }), win, anchoredMedia(photo, [card, photo]));
  assert.equal(found?.left, 415, 'must walk up to the card and find the row above the photo');

  // Facebook's own top nav is also a row of icon buttons. The walk must stop
  // before any ancestor that wide, or the button lands in the navbar.
  const page = { left: 0, top: 0, right: 1000, bottom: 900, width: 1000, height: 900 };
  const navbar = [
    { left: 700, top: 8, right: 732, bottom: 40, width: 32, height: 32 },
    { left: 736, top: 8, right: 768, bottom: 40, width: 32, height: 32 },
  ];
  const feedVideo = { left: 300, top: 300, right: 700, bottom: 600, width: 400, height: 300 };
  assert.equal(
    pickControlAnchor(fakeDoc({ control: navbar }), win, anchoredMedia(feedVideo, [page, feedVideo])),
    undefined,
  );
});

test('renders an icon of the same family as the controls beside it', () => {
  // The whole point of joining the row: a "Download" pill next to three white
  // glyphs reads as a third-party graft.
  assert.doesNotMatch(overlaySource, /textContent = t\(/, 'the trigger must not carry copy');
  assert.match(overlaySource, /createElementNS\(SVG_NS, 'path'\)/, 'the glyph must be drawn as SVG');
  // Facebook's viewer controls are filled glyphs. An outlined one is the wrong
  // family however well it is placed, so nothing here may be stroked.
  assert.match(overlaySource, /fill:\s*#fff/);
  assert.doesNotMatch(overlaySource, /stroke-width|stroke:\s*#/, 'filled, not stroked');
  // No size assertion here on purpose. What makes the glyph belong is its INK over
  // the 24 grid — 16.3%, the measured figure for Facebook's own play, pause and
  // speaker — and that cannot be computed from path text without a rasteriser,
  // which this suite has no dependency for. A bound on the coordinates would look
  // like a check while proving nothing: these paths are relative, so their largest
  // literal is 16.9 whatever the glyph actually covers. The measurement and the
  // numbers to hold live in the GLYPHS comment.

  // The label still has to exist for anyone not looking at it.
  assert.match(overlaySource, /trigger\.setAttribute\('aria-label', label\)/);
  assert.match(overlaySource, /trigger\.title = label/);
  // Sized from the measured control, floored at the WCAG 2.5.8 target minimum.
  assert.match(overlaySource, /width: max\(28px, var\(--size/);
});

// ── Overlay behaviour ───────────────────────────────────────────────────────

/** A DOM double covering exactly the members the overlay touches. The repo ships
 *  no jsdom and takes no new dependencies, and the menu is worth driving for real:
 *  "one click opens the resolutions, one more downloads that resolution" is the
 *  whole feature. */
function fakeDom(media: Partial<DOMRect>, controls: Array<Partial<DOMRect>>) {
  const make = (tag: string, r: Partial<DOMRect> = {}): any => {
    const el: any = {
      tagName: tag.toUpperCase(),
      children: [] as any[],
      attrs: new Map<string, string>(),
      handlers: new Map<string, Array<(e: unknown) => void>>(),
      style: { setProperty: (k: string, v: string) => (el.style[k] = v) },
      get textContent(): string {
        return '';
      },
      set textContent(_value: string) {
        el.children.length = 0;
      },
      append: (...kids: any[]) => el.children.push(...kids),
      appendChild: (kid: any) => (el.children.push(kid), kid),
      setAttribute: (k: string, v: string) => el.attrs.set(k, v),
      getAttribute: (k: string) => el.attrs.get(k) ?? null,
      removeAttribute: (k: string) => el.attrs.delete(k),
      toggleAttribute: (k: string, on: boolean) => (on ? el.attrs.set(k, '') : el.attrs.delete(k)),
      addEventListener: (type: string, fn: (e: unknown) => void) =>
        el.handlers.set(type, [...(el.handlers.get(type) ?? []), fn]),
      querySelector: (sel: string) => el.children.find((k: any) => k.tagName === sel.toUpperCase()),
      getBoundingClientRect: () => rect(r),
      attachShadow: () => (el.shadow = make('shadow-root')),
      focus: () => {},
      remove: () => {},
      click: () => {
        for (const fn of el.handlers.get('click') ?? []) fn({ preventDefault() {}, stopPropagation() {} });
      },
    };
    return el;
  };

  const video = make('video', media);
  // A video story fills its card, so the card's rect is the media's rect. The
  // control search walks up from the media, so the chain has to exist.
  video.parentElement = make('div', media);
  const controlEls = controls.map((r) => make('div', r));
  const documentElement = make('html');
  const doc = {
    documentElement,
    createElement: (tag: string) => make(tag),
    createElementNS: (_ns: string, tag: string) => make(tag),
    querySelectorAll: (sel: string) => (sel === 'video' ? [video] : sel === 'img' ? [] : controlEls),
  } as unknown as Document;
  const win = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  } as unknown as Window;
  return { doc, win, host: () => documentElement.children[0] };
}

test('offers the resolutions on click and downloads the one picked', async () => {
  const sent: any[] = [];
  const { doc, win, host } = fakeDom(
    { left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 },
    [{ left: 570, top: 120, right: 602, bottom: 152, width: 32, height: 32 }],
  );
  const overlay = createDownloadOverlay({
    sendMessage: async (message: any) => {
      sent.push(message);
      return message.type === 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS'
        ? { ok: true, media: { kind: 'video', labels: ['1080p', '720p'] } }
        : { ok: true };
    },
    isAlive: () => true,
    doc,
    win,
  });
  await overlay.refresh();

  const [, wrap] = host().shadow.children;
  const [trigger, menu] = wrap.children;
  assert.equal(wrap.getAttribute('data-show'), '1', 'the button must be visible');

  // Placed beside Facebook's own control, at its size — not on top of it.
  assert.equal(wrap.style.left, '566px', 'must sit GAP_PX left of the control at 570');
  assert.equal(wrap.style.top, '120px', 'must align with the control row');
  assert.equal(wrap.style['--size'], '32px', 'must adopt the row size');

  // Icon only: one <svg>, no copy, and the name carried by aria-label.
  assert.equal(trigger.children.length, 1);
  assert.equal(trigger.children[0].tagName, 'SVG');
  assert.equal(trigger.getAttribute('aria-label'), 'Download');

  // One menu item per resolution, and the menu opens on the first click.
  assert.deepEqual(
    menu.children.map((b: any) => b.tagName),
    ['BUTTON', 'BUTTON'],
  );
  assert.equal(menu.getAttribute('data-open'), null);
  trigger.click();
  assert.equal(menu.getAttribute('data-open'), '1');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');

  // Picking one sends that label — and only the label.
  menu.children[1].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent.at(-1), { type: 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD', label: '720p' });
  assert.equal(menu.getAttribute('data-open'), null, 'picking a resolution closes the menu');
  assert.equal(trigger.getAttribute('aria-label'), 'Saved', 'the result shows on the button');
  overlay.dispose();
});

test('closes an open menu when the slide moves on, but not while the same one plays', async () => {
  const { doc, win, host } = fakeDom(
    { left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 },
    [{ left: 570, top: 120, right: 602, bottom: 152, width: 32, height: 32 }],
  );
  const overlay = createDownloadOverlay({
    sendMessage: async () => ({ ok: true, media: { kind: 'video', labels: ['1080p', '720p'] } }),
    isAlive: () => true,
    doc,
    win,
  });
  await overlay.refresh();
  const [, wrap] = host().shadow.children;
  const [trigger, menu] = wrap.children;

  trigger.click();
  assert.equal(menu.getAttribute('data-open'), '1');
  // A poll while the same story plays must not fight the user mid-pick — the ids
  // keep growing as more representations are captured.
  await overlay.refresh();
  assert.equal(menu.getAttribute('data-open'), '1', 'a plain poll must leave the menu open');

  // Advancing the story invalidates it: those labels belong to the video that left.
  await overlay.refresh({ mediaChanged: true });
  assert.equal(menu.getAttribute('data-open'), null);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  overlay.dispose();
});

test('renders the resolutions as options, on a backdrop you can see the frame through', () => {
  const menu = overlaySource.match(/\.menu \{([^}]*)\}/)?.[1];
  assert.ok(menu, 'missing the .menu block');
  // Chips that wrap into rows, not a column tall enough to cover the story.
  assert.match(menu, /flex-wrap:\s*wrap/);
  assert.doesNotMatch(menu, /flex-direction:\s*column/);
  const alpha = Number(menu.match(/background: rgba\(\d+, \d+, \d+, ([\d.]+)\)/)?.[1]);
  assert.ok(alpha > 0 && alpha <= 0.6, `the menu backdrop is too opaque: ${alpha}`);
  // Each option is a pill, not a row.
  const item = overlaySource.match(/\.menu button \{([^}]*)\}/)?.[1];
  assert.match(item!, /border-radius:\s*999px/);
  assert.match(item!, /text-align:\s*center/);
});

test('re-asks what is playing only once the new slide has reached the worker', () => {
  const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');
  // Refreshing before the delivery commits would read the PREVIOUS slide's
  // resolutions out of the worker, and a click would download that video.
  assert.match(
    content,
    /playingDelivery\.pump\(deliverPlaying\)\.then\(\(\) => downloadOverlay\?\.refresh\(\{ mediaChanged \}\)\)/,
    'the slide change must drive the refresh, after the delivery lands',
  );
  // That mediaChanged excludes the id set (which grows while one video plays) is
  // covered by the behavioural test above: a plain poll must leave the menu open.
  const interval = Number(content.match(/const OVERLAY_REFRESH_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ''));
  assert.ok(interval > 0 && interval <= 1000, `the catch-up poll must stay under a second, got ${interval}`);
});

test('the overlay hides itself when nothing downloadable is playing, and on a dead context', async () => {
  const calls: unknown[] = [];
  // Nothing on screen can anchor the button, so the answer is already known here.
  // Waiting for a round trip to act on it is what left the button up for a beat
  // after a viewer closed: the message costs a service-worker wake-up, and the
  // worker still holds the slide that just left.
  const overlay = createDownloadOverlay({
    sendMessage: async (message) => {
      calls.push(message);
      return { ok: true, media: undefined };
    },
    isAlive: () => true,
    doc: stubDoc(),
    win: stubWin(),
  });
  await overlay.refresh();
  // Not deepEqual against []: node's typings narrow `actual` to the expected type,
  // which would make calls never[] for the second half of this test.
  assert.equal(calls.length, 0, 'the local DOM answered; the worker must not be woken to confirm it');

  // With something anchorable on screen the question is real, and gets asked.
  const anchored = createDownloadOverlay({
    sendMessage: async (message) => {
      calls.push(message);
      return { ok: true, media: undefined };
    },
    isAlive: () => true,
    doc: fakeDoc({ video: [{ left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 }] }),
    win: stubWin(),
  });
  await anchored.refresh();
  assert.deepEqual(calls, [{ type: 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS' }]);
  anchored.dispose();

  const dead = createDownloadOverlay({
    sendMessage: async () => {
      throw new Error('should not be called on a dead context');
    },
    isAlive: () => false,
    doc: stubDoc(),
    win: stubWin(),
  });
  await dead.refresh(); // must not throw
  dead.dispose();
  overlay.dispose();
});

test('a failed options query is counted and hides the button instead of throwing', async () => {
  const errors: unknown[] = [];
  const overlay = createDownloadOverlay({
    sendMessage: async () => {
      throw new Error('Extension context invalidated');
    },
    isAlive: () => true,
    onError: (error) => errors.push(error),
    // Anchorable media, or the refresh answers from the DOM and never asks.
    doc: fakeDoc({ video: [{ left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 }] }),
    win: stubWin(),
  });
  await overlay.refresh();
  assert.equal(errors.length, 1);
  overlay.dispose();
});

test('a late answer never overrides the refresh that started after it', async () => {
  const answer: Array<(response: unknown) => void> = [];
  const { doc, win, host } = fakeDom(
    { left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 },
    [{ left: 570, top: 120, right: 602, bottom: 152, width: 32, height: 32 }],
  );
  const overlay = createDownloadOverlay({
    sendMessage: () => new Promise<unknown>((resolve) => answer.push(resolve)),
    isAlive: () => true,
    doc,
    win,
  });
  // Two refreshes in flight at once is the normal case, not a corner one: the
  // 750ms catch-up poll and the one a slide change fires overlap constantly. Their
  // promises resolve in either order — a message to a sleeping worker pays a
  // wake-up, one to a warm worker does not.
  const stale = overlay.refresh();
  const fresh = overlay.refresh();
  assert.equal(answer.length, 2);

  answer[1]({ ok: true, media: { kind: 'video', labels: ['1080p'] } });
  await fresh;
  const [, wrap] = host().shadow.children;
  assert.equal(wrap.getAttribute('data-show'), '1');

  // The older query answers last, and it answers about the media that already left.
  answer[0]({ ok: true, media: undefined });
  await stale;
  assert.equal(
    wrap.getAttribute('data-show'),
    '1',
    'a stale answer must not take down the button a newer refresh just placed',
  );
  overlay.dispose();
});

test('an answer still paints when a newer refresh has only started, not decided', async () => {
  // A slide's first second fires refreshes faster than the worker answers: the
  // 750ms poll overlaps the one each slide change schedules. Vetoing every response
  // that merely had a newer refresh START behind it means none of them ever paints,
  // and the button never appears on video at all.
  const answer: Array<(response: unknown) => void> = [];
  const { doc, win, host } = fakeDom(
    { left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 },
    [{ left: 570, top: 120, right: 602, bottom: 152, width: 32, height: 32 }],
  );
  const overlay = createDownloadOverlay({
    sendMessage: () => new Promise<unknown>((resolve) => answer.push(resolve)),
    isAlive: () => true,
    doc,
    win,
  });

  const first = overlay.refresh();
  void overlay.refresh(); // the poll comes round again, and stays unanswered
  answer[0]({ ok: true, media: { kind: 'video', labels: ['1080p'] } });
  await first;

  const [, wrap] = host().shadow.children;
  assert.equal(wrap.getAttribute('data-show'), '1', 'a newer refresh only vetoes once it has decided');
  overlay.dispose();
});

test('a query still in flight cannot put the button back once the media is gone', async () => {
  const answer: Array<(response: unknown) => void> = [];
  const { doc, win, host } = fakeDom(
    { left: 300, top: 100, right: 700, bottom: 700, width: 400, height: 600 },
    [{ left: 570, top: 120, right: 602, bottom: 152, width: 32, height: 32 }],
  );
  let onScreen = true;
  const closing = {
    ...doc,
    querySelectorAll: (sel: string) => (onScreen ? doc.querySelectorAll(sel) : []),
  } as unknown as Document;
  const overlay = createDownloadOverlay({
    sendMessage: () => new Promise<unknown>((resolve) => answer.push(resolve)),
    isAlive: () => true,
    doc: closing,
    win,
  });

  const shown = overlay.refresh();
  answer[0]({ ok: true, media: { kind: 'video', labels: ['1080p'] } });
  await shown;
  const [, wrap] = host().shadow.children;
  assert.equal(wrap.getAttribute('data-show'), '1');

  // The poll asks again, and the viewer closes while that question is unanswered.
  const inFlight = overlay.refresh();
  onScreen = false;
  await overlay.refresh(); // sees the empty DOM and hides without asking anyone
  assert.equal(wrap.getAttribute('data-show'), null);

  // Closing a story drops you back onto the feed, so a beat later there IS media
  // to anchor to again — just not the media the pending query is about. That is
  // what makes this the closing case and not the empty-page one: the anchor check
  // after the response passes, and only the hide having claimed a generation stops
  // the answer about the story from putting the button back over the feed.
  onScreen = true;
  answer[1]({ ok: true, media: { kind: 'video', labels: ['1080p'] } });
  await inFlight;
  assert.equal(wrap.getAttribute('data-show'), null, 'an answer about media that is gone must not show it');
  overlay.dispose();
});

test('the content script tears the overlay down with everything else', () => {
  const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');
  const teardown = content.slice(content.indexOf('function teardown(): void {'));
  const end = teardown.indexOf('\n}\n');
  const body = teardown.slice(0, end);
  assert.match(body, /clearInterval\(overlayTimer\)/, 'the refresh interval must be cleared');
  assert.match(body, /downloadOverlay\?\.dispose\(\)/, 'the overlay must be disposed');
});
