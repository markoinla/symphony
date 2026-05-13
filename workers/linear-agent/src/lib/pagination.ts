// Cursor pagination helpers for v1 list endpoints.
//
// Cursor model — never offset:
//   ?limit=<n>          (default 50, capped at 200)
//   ?before_id=<uuid>   returns rows created strictly before this id
//
// The actual `WHERE (created_at, id) < (?, ?)` cursor condition lives
// in each route's SQL because the column shape differs per resource.
// This module only parses query params and computes `next_cursor`
// from the returned page.
//
// Full spec: docs/linear_agent_api_v1.md ("Conventions → Pagination").

import type { Context } from "hono";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface Pagination {
  limit: number;
  beforeId: string | null;
}

export function parsePagination(
  c: Context,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): Pagination {
  const def = opts.defaultLimit ?? DEFAULT_LIMIT;
  const max = opts.maxLimit ?? MAX_LIMIT;

  const rawLimit = c.req.query("limit");
  let limit = def;
  if (rawLimit !== undefined) {
    const n = parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, max);
  }

  const beforeId = c.req.query("before_id") ?? null;
  return { limit, beforeId };
}

// Compute the next cursor from a returned page. Convention: page is
// "full" (size === limit) → there *may* be more rows, so emit the last
// row's id. Page is short → no more rows, emit null.
//
// False positives are fine: a follow-up GET with that cursor returns
// an empty page and a null cursor, which is the standard "end of list"
// signal.
export function nextCursorFrom<T extends { id: string }>(
  items: T[],
  limit: number,
): string | null {
  if (items.length < limit) return null;
  return items[items.length - 1]?.id ?? null;
}
