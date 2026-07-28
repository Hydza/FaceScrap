// What the panel looks like: the accent palette, and the two shape/depth choices.
//
// The colours are Facebook's and Meta's own, not invented ones — the panel sits beside
// facebook.com all day, and a palette borrowed from the site it serves reads as part of
// the same product. Each entry therefore names a real surface of that palette.
//
// Every entry carries its OWN `onAccent`. That is not a detail: the accent is what the
// primary button and the selection rings are filled with, so a light accent (the reaction
// yellow, the signup green) needs dark text on it or the button drops below WCAG AA. A
// single hardcoded white would have made two of these seven unreadable — see the contrast
// test, which computes the ratio for every entry rather than trusting this comment.

import type { MsgKey } from './i18n';

export type AccentId = 'brand' | 'alert' | 'sun' | 'meta' | 'messenger' | 'story' | 'grow';

interface Accent {
  id: AccentId;
  /** The swatch has no text, so this is also its accessible name. Held here rather than
   *  derived as `accent_${id}` at the call site: a template literal needs an `as MsgKey`
   *  cast, and that cast is exactly what would let a new accent ship with no label at all. */
  label: MsgKey;
  /** The flat colour. Borders, 1px rings and focus outlines cannot take a gradient. */
  solid: string;
  /** What fills the primary button and the tray. Same as `solid` for the flat entries. */
  grad: string;
  /** Text and glyphs drawn ON the accent. */
  onAccent: string;
}

/** Three flat, then four gradients — the order the swatch row draws them in. */
export const ACCENTS: readonly Accent[] = [
  // Facebook's current brand blue.
  { id: 'brand', label: 'accent_brand', solid: '#0866ff', grad: '#0866ff', onAccent: '#ffffff' },
  // The notification/badge red. #f02849 (Live) is the brighter sibling and lands at 4.1:1
  // against white, so this is the one that can carry white text.
  { id: 'alert', label: 'accent_alert', solid: '#e41e3f', grad: '#e41e3f', onAccent: '#ffffff' },
  // The haha/wow reaction yellow. Dark text — white on this is 2:1.
  { id: 'sun', label: 'accent_sun', solid: '#f7b125', grad: '#f7b125', onAccent: '#16181c' },
  // Meta's own blue ramp.
  {
    id: 'meta',
    label: 'accent_meta',
    solid: '#0064e0',
    grad: 'linear-gradient(180deg, #0082fb, #0064e0)',
    onAccent: '#ffffff',
  },
  // Messenger's four-stop ramp, in the order Messenger draws it.
  {
    id: 'messenger',
    label: 'accent_messenger',
    solid: '#006aff',
    grad: 'linear-gradient(135deg, #00b2ff, #006aff 38%, #a033ff 72%, #ff5c87)',
    onAccent: '#ffffff',
  },
  // The creative/story purple to pink.
  {
    id: 'story',
    label: 'accent_story',
    solid: '#a033ff',
    grad: 'linear-gradient(135deg, #a033ff, #ff5c87)',
    onAccent: '#ffffff',
  },
  // The two greens Facebook uses for "online" and for its signup button. Dark text.
  {
    id: 'grow',
    label: 'accent_grow',
    solid: '#31a24c',
    grad: 'linear-gradient(180deg, #42b72a, #31a24c)',
    onAccent: '#16181c',
  },
];

export const DEFAULT_ACCENT: AccentId = 'brand';

export function accentById(id: string): Accent {
  return ACCENTS.find((accent) => accent.id === id) ?? ACCENTS[0]!;
}

/** How much of a custom background shows through the panel's own surfaces. Inert without
 *  one: with no image behind them there is nothing for a translucent card to reveal. */
export type PanelBackdrop = 'solid' | 'frosted' | 'glass';
export const BACKDROPS: readonly PanelBackdrop[] = ['solid', 'frosted', 'glass'];

/** The corner radius family, applied over --r-lg/--r-md/--r-sm. */
export type PanelCorners = 'sharp' | 'soft' | 'round';
export const CORNERS: readonly PanelCorners[] = ['sharp', 'soft', 'round'];
