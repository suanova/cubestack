// Rules for the custom sidebar logo, shared by the settings page (which checks
// a file before reading it) and the API route (which re-checks the data URL it
// is asked to store). The logo lives in a ConfigMap, whose per-object limit is
// 1 MiB, so the decoded image is capped well below it.

/** Image types the picker accepts and the API stores. */
export const LOGO_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
] as const;

/** `accept` attribute for the file picker. */
export const LOGO_ACCEPT = LOGO_MIME_TYPES.join(",");

/** Largest decoded image we store (base64 inflates by 4/3). */
export const MAX_LOGO_BYTES = 256 * 1024;

/** Upload cap before decoding; a bigger file is rejected without reading it. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Longest edge (px) a raster logo is downscaled to before storing. */
export const MAX_LOGO_EDGE = 512;

/**
 * Scale width/height to fit within `maxEdge`, preserving aspect ratio. Returns
 * the input unchanged when it already fits.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = MAX_LOGO_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const LOGO_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte length of a base64 data URL. */
export function logoBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

/**
 * Whether a value is a data URL holding one of the accepted image types within
 * the size cap. The prefix is pinned to the type list so a `data:text/html`
 * payload can never be stored and later rendered as the brand.
 */
export function isValidLogo(dataUrl: string): boolean {
  return LOGO_DATA_URL_RE.test(dataUrl) && logoBytes(dataUrl) <= MAX_LOGO_BYTES;
}
