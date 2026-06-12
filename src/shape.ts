import type { SearchAnalyticsRow } from "./types.js";

/** Recursively drop null, undefined, and empty-string fields to save tokens. */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined || v === "") continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Project a raw Search Console analytics row into a compact, agent-friendly
 * shape. `dimensions` names the keys so the caller sees `query`/`page`/etc.
 * instead of an opaque positional `keys` array. Rates are rounded to keep the
 * response small and readable.
 */
export function shapeRow(
  row: SearchAnalyticsRow,
  dimensions: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = row.keys ?? [];
  dimensions.forEach((dim, i) => {
    out[dim] = keys[i];
  });
  out.clicks = row.clicks ?? 0;
  out.impressions = row.impressions ?? 0;
  out.ctr = round(row.ctr ?? 0, 4);
  out.position = round(row.position ?? 0, 1);
  return out;
}

export function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
