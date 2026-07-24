export type ThemePreference = 'auto' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export interface FacebookThemeRef {
  theme: EffectiveTheme;
  at: number;
}

export interface ParsedCssColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export function facebookThemeKey(tabId: number): string {
  return `facebook_theme_${tabId}`;
}

function parseChannel(raw: string): number | undefined {
  const percent = raw.endsWith('%');
  const numeric = Number(percent ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(numeric)) return undefined;
  const channel = percent ? numeric * 2.55 : numeric;
  return channel >= 0 && channel <= 255 ? channel : undefined;
}

function parseAlpha(raw: string | undefined): number | undefined {
  if (raw == null) return 1;
  const percent = raw.endsWith('%');
  const numeric = Number(percent ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(numeric)) return undefined;
  const alpha = percent ? numeric / 100 : numeric;
  return alpha >= 0 && alpha <= 1 ? alpha : undefined;
}

/** Parses the rgb()/rgba() forms returned by getComputedStyle(). */
export function parseCssColor(raw: unknown): ParsedCssColor | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'transparent') return undefined;
  const match = value.match(/^rgba?\((.*)\)$/);
  if (match == null) return undefined;

  const body = match[1].trim();
  const slash = body.split('/');
  if (slash.length > 2) return undefined;
  const channels = (slash[0].includes(',') ? slash[0].split(',') : slash[0].split(/\s+/))
    .map((part) => part.trim())
    .filter(Boolean);
  let alphaRaw: string | undefined = slash.length === 2 ? slash[1].trim() : undefined;
  if (channels.length === 4 && alphaRaw == null) alphaRaw = channels.pop();
  if (channels.length !== 3) return undefined;

  const red = parseChannel(channels[0]);
  const green = parseChannel(channels[1]);
  const blue = parseChannel(channels[2]);
  const alpha = parseAlpha(alphaRaw);
  // A translucent root cannot be classified without composing every surface
  // beneath it. Treat it as ambiguous instead of guessing the wrong theme.
  if (red == null || green == null || blue == null || alpha == null || alpha < 1) return undefined;
  return { red, green, blue, alpha };
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  // 0.04045 is the sRGB piecewise transfer threshold. The theme-contrast test
  // uses the WCAG 2.x figure (0.03928) for its literal contrast formula; both are
  // correct for their own purpose, so they are intentionally NOT reconciled.
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function inferCssTheme(raw: unknown): EffectiveTheme | undefined {
  const color = parseCssColor(raw);
  if (color == null) return undefined;
  const luminance =
    0.2126 * linearChannel(color.red) +
    0.7152 * linearChannel(color.green) +
    0.0722 * linearChannel(color.blue);
  if (luminance <= 0.18) return 'dark';
  if (luminance >= 0.7) return 'light';
  return undefined;
}

/** Prefer html/body surfaces when their usable signals agree. If they conflict
 * during a Facebook transition, consult one semantic main surface rather than
 * letting whichever root happened to paint first win. */
export function inferFacebookTheme(
  documentColors: readonly unknown[],
  mainSurfaceColor?: unknown,
): EffectiveTheme | undefined {
  const documentThemes = documentColors
    .map(inferCssTheme)
    .filter((theme): theme is EffectiveTheme => theme != null);
  const distinctThemes = new Set(documentThemes);
  // One agreeing document theme wins; a conflict (size > 1) or no usable document
  // signal (size 0) both defer to the semantic main surface.
  if (distinctThemes.size === 1) return documentThemes[0];
  return inferCssTheme(mainSurfaceColor);
}

export function normalizeFacebookThemeRef(raw: unknown): FacebookThemeRef | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;
  if (candidate.theme !== 'light' && candidate.theme !== 'dark') return undefined;
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at) || candidate.at < 0) return undefined;
  return { theme: candidate.theme, at: candidate.at };
}

/** Validate the renderer's shape but establish ordering from the trusted worker
 * clock. A forged future renderer timestamp can therefore never block later
 * observations through storage's monotonic guard. */
export function facebookThemeRefAtReceipt(
  raw: unknown,
  receivedAt: number,
): FacebookThemeRef | undefined {
  if (!Number.isFinite(receivedAt) || receivedAt < 0) return undefined;
  const candidate = normalizeFacebookThemeRef(raw);
  return candidate == null ? undefined : { theme: candidate.theme, at: receivedAt };
}

export function resolveEffectiveTheme(
  preference: ThemePreference,
  facebookTheme: EffectiveTheme | undefined,
  systemTheme: EffectiveTheme,
): EffectiveTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return facebookTheme ?? systemTheme;
}
