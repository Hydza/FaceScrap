/** Matches a Facebook media ID containing 5 to 20 digits. */
export const NUMERIC_MEDIA_ID_SOURCE = '\\d{5,20}';
export const NUMERIC_MEDIA_ID_RE = new RegExp(`^${NUMERIC_MEDIA_ID_SOURCE}$`);

export function isNumericMediaId(value: unknown): value is string {
  return typeof value === 'string' && NUMERIC_MEDIA_ID_RE.test(value);
}
