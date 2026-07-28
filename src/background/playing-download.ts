// The in-page download button's two messages.
//
// The MIRROR IMAGE of the panel's own download requests: those carry a URL and are
// refused when sender.tab is set, because a page sharing a process with a content
// script must never aim the downloader at a URL of its choosing. These carry no URL at
// all — the tab comes from , which the page cannot forge, and every URL is
// resolved from capture state the worker already owns for that tab. So the most a
// hostile facebook.com page can do is re-download what the user is watching.
//
// It answers a query and a download with the same resolution rules the panel uses, so
// the button can never offer what the Library and Now Playing hide.

import { diagBump } from '../shared/diag';
import { resolutionOf, videoGroupKey } from '../shared/media';
import { getBind, getMedia, getPlaying, getRecent, playingIdentity } from '../shared/storage';
import type { SavedEntry } from '../shared/saved';
import { playingVideoGroup, rememberedVideoGroup } from '../shared/now-playing';
import { isDownloadable, optionForLabel, playingItems, videoGroupOf, videoOptions } from '../shared/video-options';
import { downloadFilename, itemCardId, savedEntryForItem, videoCardId } from '../shared/download-naming';
import type { PlayingDownloadOptionsResponse, RequestPlayingDownloadMsg } from '../shared/messages';
import { hasOffscreen } from '../shared/capabilities';
import { loadSettings } from '../shared/settings';
import { downloadDash, downloadDirect } from './dash-download';

interface PlayingDownloadDeps {
  isDead: (tabId: number) => boolean;
  /** Only a facebook.com tab is a viewing surface; fbcdn is host-permitted but is not. */
  isFacebookUrl: (url: string | undefined) => boolean;
  /** Persist the Saved receipt. A failure here must never fail the DOWNLOAD. */
  persistReceipt: (tabId: number, receipt: SavedEntry) => Promise<void>;
}

export function createPlayingDownloadHandler(deps: PlayingDownloadDeps) {
  return (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): true | undefined => {
    const m = message as { type?: string } | undefined;
    if (m?.type !== 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS' && m?.type !== 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD') {
      return undefined;
    }
    const senderTab = sender.tab;
    // Must come FROM a tab (the inverse of the checks above), and only from a
    // Facebook one: fbcdn is host-permitted too but is not a viewing surface.
    if (
      senderTab?.id == null ||
      !Number.isInteger(senderTab.id) ||
      !deps.isFacebookUrl(senderTab.url) ||
      deps.isDead(senderTab.id)
    ) {
      sendResponse({ ok: false, error: 'Unauthorized request.' });
      return true;
    }
    const tid = senderTab.id;
    const wantsDownload = m.type === 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD';
    const requestedLabel = wantsDownload ? (message as Partial<RequestPlayingDownloadMsg>).label : undefined;
    // Every answer to the OPTIONS query goes through here so the shown/hidden split is
    // counted in one place. It is the denominator the playing* refusal counters need:
    // on its own, "the button is hidden" says nothing about how often it is hidden.
    // The switched-off early return below is deliberately not counted — the button is
    // not hidden there, it does not exist.
    const answerOptions = (media: Extract<PlayingDownloadOptionsResponse, { ok: true }>['media']): void => {
      diagBump(media != null ? 'buttonOffered' : 'buttonHidden');
      sendResponse({ ok: true, media } satisfies PlayingDownloadOptionsResponse);
    };

    void (async () => {
      try {
        // The switch is read FIRST and on its own, ahead of the four capture-state reads.
        // The overlay asks this question every 750ms for as long as any media is on screen,
        // so answering it after those reads meant a switched-off button still paid five
        // storage reads per poll to be told it has nothing to show. It now pays one.
        //
        // Answered here rather than in the content script for the same reason every other
        // "what can this tab download" question is: the overlay decides nothing, it asks.
        // "Nothing" is the reply it already handles — it hides, and hides BEFORE build(), so
        // with the button off no node is injected into the page at all.
        //
        // Only the OPTIONS query is gated. The download request is shared with the global
        // keyboard shortcut, which is configured separately and must keep working; and a UI
        // switch was never the security boundary here anyway — the sender checks above are
        // (see this file's header for what a compromised renderer can and cannot do).
        const settings = await loadSettings();
        if (!settings.inPageButton && !wantsDownload) {
          sendResponse({ ok: true, media: undefined });
          return;
        }
        const [items, ref, bind, recent] = await Promise.all([
          getMedia(tid),
          getPlaying(tid),
          // The panel's learned bindings and the tracks fbcdn actually streamed.
          // Both read, neither written: together they are what identifies an MSE
          // video, whose only id in the ref is its cover — see playingVideoGroup.
          getBind(tid),
          getRecent(tid),
        ]);
        // Both PURE reads. This handler polls, so it must not be a second writer on
        // the detector's learned state or its pin — playingEvidence, which the panel
        // now shares, writes nothing at all.
        const playing = playingItems(ref, items);
        // Held across ticks: the streamed-track evidence ages out while a short
        // reel loops in silence, and the button must not vanish under the user.
        const at = Date.now();
        const liveGroup = rememberedVideoGroup(
          tid,
          playingIdentity(ref),
          playingVideoGroup(tid, items, ref, recent, at, bind),
          at,
        );
        // stripAudio mirrors the panel's own rule: no offscreen API, or the user
        // asked for direct downloads, means a DASH pair cannot be remuxed.
        const context = { stripAudio: !hasOffscreen() || settings.directDownload };

        // The id match first — it is exact when it fires. The streamed-track group
        // is what covers MSE video, where no id ever names the file being played.
        const video =
          playing.find((i) => i.kind === 'video') ??
          (liveGroup != null ? items.find((i) => i.kind === 'video' && videoGroupKey(i) === liveGroup) : undefined);
        // videosOnly hides images from every view; this button is one of them.
        const image =
          video || settings.videosOnly
            ? undefined
            : playing.find((i) => i.kind === 'image' && isDownloadable(i));

        if (video) {
          const group = videoGroupOf(video, items);
          const { options, gkey, thumbUrl, durationSec } = videoOptions(group, context);
          // minResolution hides the whole card in the Library and in Now Playing.
          // Offering it here anyway would make the button contradict both.
          const maxHeight = Math.max(0, ...group.map((i) => i.height ?? 0));
          const decluttered =
            settings.minResolution > 0 && maxHeight > 0 && maxHeight < settings.minResolution;
          if (options.length === 0 || decluttered) {
            // For the options query "nothing to offer" is a normal answer and the
            // button hides. A download request must FAIL — answering ok would put
            // "Saved" on a button that saved nothing.
            if (wantsDownload) sendResponse({ ok: false, error: 'Nothing downloadable is playing.' });
            else answerOptions(undefined);
            return;
          }
          if (!wantsDownload) {
            answerOptions({ kind: 'video', labels: options.map((i) => resolutionOf(i).label) });
            return;
          }
          const target = optionForLabel(options, requestedLabel, settings.defaultQuality);
          if (!target) {
            sendResponse({ ok: false, error: 'Nothing downloadable is playing.' });
            return;
          }
          const cardId = videoCardId(gkey);
          const receipt = savedEntryForItem(cardId, target, { thumbUrl, durationSec });
          const filename = downloadFilename(target, settings);
          const saveAs = settings.defaultQuality === 'ask';
          if (target.audioUrl != null) {
            if (!hasOffscreen()) {
              sendResponse({ ok: false, error: 'This browser can\'t merge audio and video.' });
              return;
            }
            await downloadDash({
              tabId: tid,
              receiptId: receipt.id,
              videoUrl: target.url,
              audioUrl: target.audioUrl,
              filename,
              saveAs,
            });
          } else {
            await downloadDirect(target.url, filename, saveAs);
          }
          await deps.persistReceipt(tid, receipt);
          sendResponse({ ok: true });
          return;
        }

        if (image) {
          if (!wantsDownload) {
            // No resolutions to choose from — the overlay downloads on one click.
            answerOptions({ kind: 'image', labels: [] });
            return;
          }
          const cardId = itemCardId(image.id);
          const receipt = savedEntryForItem(cardId, image);
          await downloadDirect(image.url, downloadFilename(image, settings), settings.defaultQuality === 'ask');
          await deps.persistReceipt(tid, receipt);
          sendResponse({ ok: true });
          return;
        }

        // Nothing downloadable on screen. For the options query that is a normal
        // answer (the button hides); for a download request it is a real failure.
        if (wantsDownload) sendResponse({ ok: false, error: 'Nothing downloadable is playing.' });
        else answerOptions(undefined);
      } catch (error) {
        sendResponse({ ok: false, error: String((error as Error)?.message ?? error) });
      }
    })();
    return true; // async response
  };
}
