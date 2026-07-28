// What the panel looks like: the accent palette, the panel tints, and the two
// shape/depth choices.
//
// The colours are Facebook's and Meta's own plus a neutral extension of them — the panel
// sits beside facebook.com all day, and a palette borrowed from the site it serves reads
// as part of the same product. Each entry therefore names a real surface of that palette
// or an obvious neighbour of one.
//
// Every entry carries its OWN `onAccent`. That is not a detail: the accent is what the
// primary button and the selection rings are filled with, so a light accent (the reaction
// yellow, the signup green, the lime) needs dark text on it or the button drops below
// WCAG AA. A single hardcoded white would have made several of these unreadable — see the
// contrast test, which computes the ratio for every entry rather than trusting this comment.
//
// Each entry also carries the two READABLE-ON-CANVAS steps the accent itself cannot be:
// `softDark` for the dark canvas and `softLight` for the light one. Those are what `--ach`
// resolves to — the only place an accent is ever allowed to be text.

import type { MsgKey } from './i18n';

export type AccentId =
  | 'brand'
  | 'alert'
  | 'sun'
  | 'violet'
  | 'indigo'
  | 'pink'
  | 'orange'
  | 'forest'
  | 'pine'
  | 'slate'
  | 'meta'
  | 'messenger'
  | 'story'
  | 'grow'
  | 'dusk'
  | 'ember'
  | 'teal'
  | 'midnight'
  | 'sunset'
  | 'lime'
  | 'copper'
  | 'ice'
  | 'steel';

/** Which labelled row of the Colour control a swatch is drawn in. */
export type AccentGroup = 'solid' | 'gradient';

interface Accent {
  id: AccentId;
  group: AccentGroup;
  /** The swatch has no text, so this is also its accessible name. Held here rather than
   *  derived as `accent_${id}` at the call site: a template literal needs an `as MsgKey`
   *  cast, and that cast is exactly what would let a new accent ship with no label at all. */
  label: MsgKey;
  /** The flat colour. Borders, 1px rings and focus outlines cannot take a gradient, and
   *  neither can an SVG `fill` — see the logo tile. */
  solid: string;
  /** What fills the primary button, the tray button and the swatch. Same as `solid` for
   *  the flat entries. */
  grad: string;
  /** Text and glyphs drawn ON the accent. */
  onAccent: string;
  /** The accent as TEXT on the dark canvas. */
  softDark: string;
  /** The accent as TEXT on the light canvas — a darker step than `solid`. */
  softLight: string;
  /** `r,g,b` of `solid`, for the glows and the active-nav wash. */
  rgb: string;
}

/** Ten flat, then thirteen gradients — the order the two swatch rows draw them in. */
export const ACCENTS: readonly Accent[] = [
  // ── Solid ───────────────────────────────────────────────────────────────────
  // Facebook's current brand blue.
  {
    id: 'brand',
    group: 'solid',
    label: 'accent_brand',
    solid: '#0866ff',
    grad: '#0866ff',
    onAccent: '#ffffff',
    softDark: '#4d93ff',
    softLight: '#0a5ae0',
    rgb: '8,102,255',
  },
  // The notification/badge red. #f02849 (Live) is the brighter sibling and lands at 4.1:1
  // against white, so this is the one that can carry white text.
  {
    id: 'alert',
    group: 'solid',
    label: 'accent_alert',
    solid: '#e41e3f',
    grad: '#e41e3f',
    onAccent: '#ffffff',
    softDark: '#ff8a97',
    softLight: '#b81a35',
    rgb: '228,30,63',
  },
  // The haha/wow reaction yellow. Dark text — white on this is 2:1.
  {
    id: 'sun',
    group: 'solid',
    label: 'accent_sun',
    solid: '#f7b125',
    grad: '#f7b125',
    onAccent: '#16181c',
    softDark: '#f8c65e',
    softLight: '#7a5300',
    rgb: '247,177,37',
  },
  {
    id: 'violet',
    group: 'solid',
    label: 'accent_violet',
    solid: '#7c3aed',
    grad: '#7c3aed',
    onAccent: '#ffffff',
    softDark: '#c4a4fb',
    softLight: '#5b21b6',
    rgb: '124,58,237',
  },
  {
    id: 'indigo',
    group: 'solid',
    label: 'accent_indigo',
    solid: '#4f46e5',
    grad: '#4f46e5',
    onAccent: '#ffffff',
    softDark: '#a5b4fc',
    softLight: '#3730a3',
    rgb: '79,70,229',
  },
  {
    id: 'pink',
    group: 'solid',
    label: 'accent_pink',
    solid: '#db2777',
    grad: '#db2777',
    onAccent: '#ffffff',
    softDark: '#f9a8d4',
    softLight: '#9d174d',
    rgb: '219,39,119',
  },
  {
    id: 'orange',
    group: 'solid',
    label: 'accent_orange',
    solid: '#ea580c',
    grad: '#ea580c',
    onAccent: '#1f0a02',
    softDark: '#fdba74',
    softLight: '#9a3412',
    rgb: '234,88,12',
  },
  {
    id: 'forest',
    group: 'solid',
    label: 'accent_forest',
    solid: '#1a7f37',
    grad: '#1a7f37',
    onAccent: '#ffffff',
    softDark: '#7ee2a8',
    softLight: '#116329',
    rgb: '26,127,55',
  },
  {
    id: 'pine',
    group: 'solid',
    label: 'accent_pine',
    solid: '#0f766e',
    grad: '#0f766e',
    onAccent: '#ffffff',
    softDark: '#5eead4',
    softLight: '#115e59',
    rgb: '15,118,110',
  },
  {
    id: 'slate',
    group: 'solid',
    label: 'accent_slate',
    solid: '#475569',
    grad: '#475569',
    onAccent: '#ffffff',
    softDark: '#cbd5e1',
    softLight: '#334155',
    rgb: '71,85,105',
  },

  // ── Gradient ────────────────────────────────────────────────────────────────
  // Meta's own blue ramp.
  {
    id: 'meta',
    group: 'gradient',
    label: 'accent_meta',
    solid: '#0064e0',
    grad: 'linear-gradient(180deg,#0082fb,#0064e0)',
    onAccent: '#ffffff',
    softDark: '#4d9bff',
    softLight: '#0056c2',
    rgb: '0,100,224',
  },
  // Messenger's four-stop ramp, in the order Messenger draws it.
  {
    id: 'messenger',
    group: 'gradient',
    label: 'accent_messenger',
    solid: '#006aff',
    grad: 'linear-gradient(135deg,#00b2ff,#006aff 38%,#a033ff 72%,#ff5c87)',
    onAccent: '#ffffff',
    softDark: '#4d97ff',
    softLight: '#0057cc',
    rgb: '0,106,255',
  },
  // The creative/story purple to pink.
  {
    id: 'story',
    group: 'gradient',
    label: 'accent_story',
    solid: '#a033ff',
    grad: 'linear-gradient(135deg,#a033ff,#ff5c87)',
    onAccent: '#ffffff',
    softDark: '#c489ff',
    softLight: '#7d1fd1',
    rgb: '160,51,255',
  },
  // The two greens Facebook uses for "online" and for its signup button. Dark text.
  {
    id: 'grow',
    group: 'gradient',
    label: 'accent_grow',
    solid: '#31a24c',
    grad: 'linear-gradient(180deg,#42b72a,#31a24c)',
    onAccent: '#16181c',
    softDark: '#62d67e',
    softLight: '#1b6b2f',
    rgb: '49,162,76',
  },
  {
    id: 'dusk',
    group: 'gradient',
    label: 'accent_dusk',
    solid: '#7b3ff2',
    grad: 'linear-gradient(135deg,#a033ff,#4d6bff)',
    onAccent: '#ffffff',
    softDark: '#c08cff',
    softLight: '#6428d4',
    rgb: '123,63,242',
  },
  {
    id: 'ember',
    group: 'gradient',
    label: 'accent_ember',
    solid: '#f2683c',
    grad: 'linear-gradient(135deg,#ff5c87,#f7b125)',
    onAccent: '#231007',
    softDark: '#ffa07a',
    softLight: '#9c3510',
    rgb: '242,104,60',
  },
  {
    id: 'teal',
    group: 'gradient',
    label: 'accent_teal',
    solid: '#00a58c',
    grad: 'linear-gradient(135deg,#00c6a7,#0082fb)',
    onAccent: '#04201b',
    softDark: '#4fd6c0',
    softLight: '#00695a',
    rgb: '0,165,140',
  },
  {
    id: 'midnight',
    group: 'gradient',
    label: 'accent_midnight',
    solid: '#3730a3',
    grad: 'linear-gradient(135deg,#1e3a8a,#4338ca)',
    onAccent: '#ffffff',
    softDark: '#a5b4fc',
    softLight: '#312e81',
    rgb: '55,48,163',
  },
  {
    id: 'sunset',
    group: 'gradient',
    label: 'accent_sunset',
    solid: '#ff4d3d',
    grad: 'linear-gradient(135deg,#ff7a18,#ff2d55)',
    onAccent: '#2a0a05',
    softDark: '#ff9a86',
    softLight: '#b3241d',
    rgb: '255,77,61',
  },
  {
    id: 'lime',
    group: 'gradient',
    label: 'accent_lime',
    solid: '#4d9a2a',
    grad: 'linear-gradient(135deg,#a3e635,#15803d)',
    onAccent: '#0f2009',
    softDark: '#9ae65f',
    softLight: '#2f6b17',
    rgb: '77,154,42',
  },
  {
    id: 'copper',
    group: 'gradient',
    label: 'accent_copper',
    solid: '#b45309',
    grad: 'linear-gradient(135deg,#f59e0b,#7c2d12)',
    onAccent: '#ffffff',
    softDark: '#f0b45f',
    softLight: '#8a3f06',
    rgb: '180,83,9',
  },
  {
    id: 'ice',
    group: 'gradient',
    label: 'accent_ice',
    solid: '#38a1f0',
    grad: 'linear-gradient(135deg,#7dd3fc,#2563eb)',
    onAccent: '#06131f',
    softDark: '#8ecdf7',
    softLight: '#1668b0',
    rgb: '56,161,240',
  },
  {
    id: 'steel',
    group: 'gradient',
    label: 'accent_steel',
    solid: '#64748b',
    grad: 'linear-gradient(135deg,#94a3b8,#334155)',
    onAccent: '#ffffff',
    softDark: '#cbd5e1',
    softLight: '#475569',
    rgb: '100,116,139',
  },
];

export const DEFAULT_ACCENT: AccentId = 'brand';

export function accentById(id: string): Accent {
  return ACCENTS.find((accent) => accent.id === id) ?? ACCENTS[0]!;
}

/** The panel's own background family. Each entry moves the canvas, the two surfaces and
 *  the hairline TOGETHER, so every surface stays in one hue family instead of a tinted
 *  canvas under neutral cards. Cards stay near-white in the light theme on purpose: there
 *  the tint reads as the field around them, not as the card. */
export type PanelTintId = 'slate' | 'graphite' | 'navy' | 'plum' | 'moss' | 'sand';

interface PanelTint {
  id: PanelTintId;
  label: MsgKey;
  /** `[canvas, surface, surface-2, line]`. */
  dark: readonly [string, string, string, string];
  light: readonly [string, string, string, string];
}

export const PANEL_TINTS: readonly PanelTint[] = [
  {
    id: 'slate',
    label: 'tint_slate',
    dark: ['#0a0c0f', '#141821', '#1b2029', '#242a34'],
    light: ['#e8ecf2', '#ffffff', '#f3f6fa', '#d7dee8'],
  },
  {
    id: 'graphite',
    label: 'tint_graphite',
    dark: ['#101214', '#1a1d21', '#212529', '#2c3138'],
    light: ['#eaebec', '#ffffff', '#f4f5f6', '#d9dbdd'],
  },
  {
    id: 'navy',
    label: 'tint_navy',
    dark: ['#080d18', '#111827', '#182030', '#232d40'],
    light: ['#dde6f5', '#ffffff', '#eef3fc', '#c5d4ec'],
  },
  {
    id: 'plum',
    label: 'tint_plum',
    dark: ['#0e0a12', '#1a1420', '#221a2a', '#2e2438'],
    light: ['#eee2f6', '#ffffff', '#f8f0fc', '#dbc7e9'],
  },
  {
    id: 'moss',
    label: 'tint_moss',
    dark: ['#080f0c', '#121b17', '#18231e', '#22302a'],
    light: ['#dcede3', '#ffffff', '#eef9f2', '#c3ddcf'],
  },
  {
    id: 'sand',
    label: 'tint_sand',
    dark: ['#100e0a', '#1c1913', '#241f18', '#302a20'],
    light: ['#f2e7d5', '#fffdfa', '#faf3e6', '#e0d2b6'],
  },
];

export const DEFAULT_TINT: PanelTintId = 'slate';

export function tintById(id: string): PanelTint {
  return PANEL_TINTS.find((tint) => tint.id === id) ?? PANEL_TINTS[0]!;
}

/** How much of a custom background shows through the panel's own surfaces. Inert without
 *  one: with no image behind them there is nothing for a translucent card to reveal. */
export type PanelBackdrop = 'solid' | 'frosted' | 'glass';
export const BACKDROPS: readonly PanelBackdrop[] = ['solid', 'frosted', 'glass'];

/** The corner radius family, applied over the radius scale. */
export type PanelCorners = 'sharp' | 'soft' | 'round';
export const CORNERS: readonly PanelCorners[] = ['sharp', 'soft', 'round'];
