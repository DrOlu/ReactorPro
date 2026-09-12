/**
 * Intl formatter cache.
 *
 * Constructing an `Intl.*Format` goes through ICU initialization (`udat_open` ->
 * `icu::SimpleDateFormat`) and is a notoriously expensive operation. Calling `new` once per render
 * body or timer callback is equivalent to doing an ICU initialization every tick: measured on long
 * conversations, this path pushes the render process CPU to 100%+, and the hot stack captured by
 * `sample` is exactly
 * `timerFired → JSEventListener::handleEvent → constructIntlDateTimeFormat →
 * udat_open`. A single formatter's lifetime should be process-level -- the locale set is tiny and
 * the option shapes are literal constants at the call sites.
 *
 * The cache key is `${variant}|${locale}` rather than serializing the options in: callers give
 * each call site a stable variant name, so the key is just short string concatenation; using
 * `JSON.stringify(options)` as the key would pay a serialization cost on every call, effectively
 * trading the saved ICU overhead for string overhead -- and that is precisely the source of hot
 * spots like `WTF::findCommon` in the same sample.
 *
 * Usage: the same call site must always use the same variant name and always pass the same set of
 * options. A mismatch between variant and options would make the cache return wrong formatting
 * results, so no runtime validation is done here -- call sites are written adjacently and are
 * visible at a glance during review.
 */

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

function cacheKey(variant: string, locale: string | undefined): string {
  return `${variant}|${locale ?? ""}`;
}

export function cachedNumberFormat(
  locale: string | undefined,
  variant: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = cacheKey(variant, locale);
  const cached = numberFormats.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(locale, options);
  numberFormats.set(key, formatter);
  return formatter;
}

export function cachedDateTimeFormat(
  locale: string | undefined,
  variant: string,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = cacheKey(variant, locale);
  const cached = dateTimeFormats.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  dateTimeFormats.set(key, formatter);
  return formatter;
}

export function cachedRelativeTimeFormat(
  locale: string | undefined,
  variant: string,
  options?: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  const key = cacheKey(variant, locale);
  const cached = relativeTimeFormats.get(key);
  if (cached) return cached;
  const formatter = new Intl.RelativeTimeFormat(locale, options);
  relativeTimeFormats.set(key, formatter);
  return formatter;
}

/** For tests: clear the cache (omitting the argument clears everything). */
export function clearIntlFormatterCaches(kind?: "number" | "dateTime" | "relativeTime"): void {
  if (kind === undefined || kind === "number") numberFormats.clear();
  if (kind === undefined || kind === "dateTime") dateTimeFormats.clear();
  if (kind === undefined || kind === "relativeTime") relativeTimeFormats.clear();
}
