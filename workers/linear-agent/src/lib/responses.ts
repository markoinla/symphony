// Standardized error envelope for the v1 REST surface.
//
// Every v1 handler funnels failures through `respondError(c, code, message?, issues?)`
// so MCP clients (and the dashboard) see one consistent shape:
//
//   { error: "<code>", message: "<human-readable>", issues?: [...] }
//
// HTTP status is derived from the code, not chosen at the call site —
// that keeps the taxonomy authoritative and the codes ↔ status mapping
// in one place.
//
// Full spec: docs/linear_agent_api_v1.md ("Errors").

import type { Context } from "hono";

export const ERROR_STATUS = {
  unauthorized:       401,
  forbidden:          403,
  not_found:          404,
  validation_failed:  400,
  invalid_state:      409,
  conflict:           409,
  rate_limited:       429,
  not_implemented:    501,
  dispatcher_error:   502,
  internal_error:     500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  unauthorized:       "Authentication required.",
  forbidden:          "Authenticated but missing required scope or wrong org.",
  not_found:          "Resource not found.",
  validation_failed:  "Request body failed validation.",
  invalid_state:      "Resource is in an invalid state for this operation.",
  conflict:           "Resource conflict.",
  rate_limited:       "Rate limit exceeded.",
  not_implemented:    "Not implemented.",
  dispatcher_error:   "Downstream dispatcher returned an error.",
  internal_error:     "Internal server error.",
};

export function respondError(
  c: Context,
  code: ErrorCode,
  message?: string,
  issues?: unknown,
): Response {
  const body: Record<string, unknown> = {
    error: code,
    message: message ?? DEFAULT_MESSAGE[code],
  };
  if (issues !== undefined) body.issues = issues;
  return c.json(body, ERROR_STATUS[code]);
}
