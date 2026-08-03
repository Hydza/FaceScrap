// The in-page download button's two messages.
//
// The MIRROR IMAGE of the panel's own download requests: those carry a URL and are
// refused when sender.tab is set, because a page sharing a process with a content
// script must never aim the downloader at a URL of its choosing. These carry no URL at
// all — the tab comes from sender.tab, which the page cannot forge, and every URL is
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
import { belowMinResolution, isDownloadable, optionForLabel, playingItems, videoGroupOf, videoOptions } from '../shared/video-options';
import { downloadFilename, itemCardId, savedEntryForItem, videoCardId } from '../shared/download-naming';
import type { PlayingDownloadOptionsResponse, RequestPlayingDownloadMsg, RequestPlayingDownloadResponse } from '../shared/messages';
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
        // The switch is read first, alone, ahead of the four capture-state reads: the
        // overlay polls this every 750ms, so a switched-off button must not pay five
        // storage reads to learn it has nothing to show.
        //
        // Answered here, not in the content script: the overlay only asks, and "nothing"
        // is a reply it already handles — it hides BEFORE build(), so with the button off
        // no node is injected into the page at all.
        //
        // Gate only the OPTIONS query. Sender validation remains the security boundary
        // for download requests shared with the global shortcut.
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
          if (options.length === 0 || belowMinResolution(group, settings.minResolution)) {
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
          let wrote = true;
          if (target.audioUrl != null) {
            if (!hasOffscreen()) {
              sendResponse({ ok: false, error: 'This browser can\'t merge audio and video.' });
              return;
            }
            wrote = await downloadDash({
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
          // A deduped call wrote no file, so it must not rewrite the Saved receipt
          // either — the rule download-handler.ts already holds for the panel's own
          // requests, on the same downloadDash. Only the DASH branch dedupes; a direct
          // download always wrote, so its receipt always stands.
          if (wrote) await deps.persistReceipt(tid, receipt);
          // Flagged only when TRUE, exactly as the panel's path answers: an ordinary
          // success keeps the bare { ok: true } the overlay and the shortcut expect.
          sendResponse((wrote ? { ok: true } : { ok: true, deduped: true }) satisfies RequestPlayingDownloadResponse);
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
