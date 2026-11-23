/**
 * Removes query strings (signatures), token path segments, bearer values and service keys from
 * text before it reaches an error message.
 *
 * @internal
 */
export function redactText(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, "$1?<redacted>")
    .replace(/\/(media-uploads|media-files)\/[^/\s?"']+/g, "/$1/<redacted>")
    .replace(/bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/ocr_[A-Za-z0-9_-]+/g, "ocr_<redacted>");
}

/** A URL without its query string and with token path segments removed. @internal */
export function redactUrl(url: string): string {
  return redactText(url.split("?", 1)[0] ?? "");
}
