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

/**
 * A copy of a decoded JSON value with every string redacted, for structured error fields such as
 * `details` (a free-form `reason` can carry a signed URL).
 *
 * @internal
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)]));
  }
  return value;
}

/** A URL without its query string and with token path segments removed. @internal */
export function redactUrl(url: string): string {
  return redactText(url.split("?", 1)[0] ?? "");
}
