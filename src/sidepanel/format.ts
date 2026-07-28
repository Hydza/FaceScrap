// Presentation vocabulary and the small DOM helpers every panel view needs.
//
// A leaf: reads no panel state, imports no other panel module. Keep it that way and
// any view can import it without risking a cycle.

import { fmt, t, type MsgKey } from '../shared/i18n';
import type { MediaKind, MediaSource } from '../shared/media';

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

export const KIND_KEY: Record<MediaKind, MsgKey> = {
  video: 'kindVideo',
  image: 'kindImage',
  audio: 'kindAudio',
};

export const KIND_ICON: Record<MediaKind, string> = {
  video: 'icons/nav-now.svg',
  image: 'icons/nav-library.svg',
  audio: 'icons/nav-saved.svg',
};

// Composition words for the tray's "video + image" line.
const COMPOSE_KEY: Record<MediaKind, MsgKey> = {
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
