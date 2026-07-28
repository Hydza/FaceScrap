// Presentation vocabulary and the small DOM helpers every panel view needs.
//
// A leaf: reads no panel state, imports no other panel module. Keep it that way and
// any view can import it without risking a cycle.

import { fmt, t, type MsgKey } from '../shared/i18n';
import type { MediaItem, MediaKind, MediaSource } from '../shared/media';
import { bitrate } from '../shared/video-options';

/** What a captured item is CALLED in the UI, by the surface it came from. */
export const SOURCE_KEY: Record<MediaSource, MsgKey> = {
  reel: 'sourceReel',
  story: 'sourceStory',
  highlight: 'sourceHighlight',
  video: 'sourceVideo',
  page: 'sourcePage',
};

/** An image inside a video post is still an Image; every other kind takes the name of
 *  its surface. One resolver, so the three places that print it cannot disagree. */
export function presentationKey(kind: MediaKind, source: MediaSource): MsgKey {
  return kind === 'image' && source === 'video' ? 'kindImage' : SOURCE_KEY[source];
}

export const KIND_ICON: Record<MediaKind, string> = {
  video: 'icons/nav-now.svg',
  image: 'icons/nav-library.svg',
  audio: 'icons/nav-saved.svg',
};

/** Composition words: the tray's "video + image" line, and the noun the Now Playing
 *  button says it is saving. Lowercase and singular — they are always joined into a
 *  phrase, never shown alone. */
export const COMPOSE_KEY: Record<MediaKind, MsgKey> = {
  video: 'composeVideo',
  image: 'composeImage',
  audio: 'composeAudio',
};

/** A count string. One is its own message, not `many` with a stripped suffix. */
export function tn(one: MsgKey, many: MsgKey, n: number): string {
  return fmt(n === 1 ? one : many, { n });
}

/** "video + image" — only the kinds actually present, in a fixed order so the line
 *  doesn't reshuffle as items arrive. */
export function composeLine(kinds: Iterable<MediaKind>): string {
  const present = new Set(kinds);
  return (['video', 'image', 'audio'] as const)
    .filter((k) => present.has(k))
    .map((k) => t(COMPOSE_KEY[k]))
    .join(' + ');
}

/**
 * What a representation will land on disk as, in bytes — from what the URL Facebook
 * already signed carries: its `bitrate=` parameter, read as bits per second, over the
 * manifest's duration. 0 when either input is missing or the answer is implausibly
 * small, so a caller can print nothing rather than a number nobody should act on.
 *
 * Deliberately an ESTIMATE, and every caller prefixes it with "~". Nothing in the
 * capture path knows a real content length: a HEAD request for one would be the
 * extension ORIGINATING a request for media, which is exactly what ARCHITECTURE.md's
 * passive-hook invariant forbids.
 */
export function estimatedBytes(item: MediaItem, durationSec: number | undefined): number {
  if (durationSec == null || durationSec <= 0) return 0;
  const bytes = (bitrate(item.url) / 8) * durationSec;
  return Number.isFinite(bytes) && bytes >= 65_536 ? bytes : 0;
}

/** "~18 MB" for an estimate, "18.4 MB" for a counted one. Empty for 0, so a missing
 *  estimate leaves its column blank rather than printing a confident zero. */
export function formatBytes(bytes: number, exact = false): string {
  if (bytes <= 0) return '';
  const mb = bytes / 1_048_576;
  if (exact) return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
  return mb >= 1024 ? `~${(mb / 1024).toFixed(1)} GB` : `~${Math.round(mb)} MB`;
}

/** Seconds → "M:SS" (or "H:MM:SS" past an hour). */
export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

/** Append " · tag" to a card's meta line. */
export function appendTag(meta: HTMLElement, text: string, cls?: string, title?: string): void {
  const s = document.createElement('span');
  s.className = cls ? `tag ${cls}` : 'tag';
  s.textContent = text;
  if (title) s.title = title;
  meta.append(' · ', s);
}

/** Mark exactly one control in a nav as pressed. */
export function pressOnly(nav: HTMLElement, active: HTMLElement): void {
  nav.querySelectorAll<HTMLButtonElement>('[aria-pressed]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b === active));
  });
}
