// API token schemas — bodies and response shapes for /api/v1/api-tokens.
//
// Plaintext token format: `tok_<43 char base64url>` (32 random bytes).
// The server stores only the SHA-256 hash; plaintext is returned once
// on the create response and never again.
//
// Scope set is closed — coarse management scopes plus narrow direct
// invocation scopes from docs/linear_agent_api_v1.md ("Auth → Scope matrix").

import { z } from "zod";

export const apiTokenScopeSchema = z.enum([
  "read",
  "write",
  "admin",
  "triggers:invoke",
]);
export type ApiTokenScope = z.infer<typeof apiTokenScopeSchema>;

export const ApiTokenCreateSchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(apiTokenScopeSchema).min(1),
});
export type ApiTokenCreateInput = z.infer<typeof ApiTokenCreateSchema>;

// Listed token — never includes plaintext or the hash.
export const ApiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(apiTokenScopeSchema),
  created_at: z.number().int(),
  last_used_at: z.number().int().nullable(),
});
export type ApiTokenView = z.infer<typeof ApiTokenSchema>;
