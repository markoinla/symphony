import { z } from "zod";

export const webhookSourceKindSchema = z.enum(["github", "generic", "sentry"]);
export type WebhookSourceKind = z.infer<typeof webhookSourceKindSchema>;

export const signatureAlgorithmSchema = z.enum(["sha1", "sha256"]);
export type SignatureAlgorithm = z.infer<typeof signatureAlgorithmSchema>;

export const PayloadMatchSchema = z.object({
  path: z.string().min(1),
  equals: z.unknown(),
});
export type PayloadMatch = z.infer<typeof PayloadMatchSchema>;

export const WebhookSourceConfigSchema = z.object({
  external_id_path: z.string().default("$.id"),
  signature_header: z.string().min(1).default("X-Webhook-Signature"),
  signature_algorithm: signatureAlgorithmSchema.default("sha256"),
});
export type WebhookSourceConfig = z.infer<typeof WebhookSourceConfigSchema>;

export const WebhookSourceSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  kind: webhookSourceKindSchema,
  name: z.string(),
  enabled: z.boolean(),
  project_id: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  webhook_url: z.string().optional(),
  inbound_url: z.string().optional(),
  secret: z.string().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  last_used_at: z.number().int().nullable().optional(),
});
export type WebhookSource = z.infer<typeof WebhookSourceSchema>;

export const WebhookSourceCreateSchema = z.object({
  kind: webhookSourceKindSchema.default("generic"),
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  project_id: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional().default({}),
});
export type WebhookSourceCreateInput = z.infer<typeof WebhookSourceCreateSchema>;

export const WebhookSourceUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  project_id: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  rotate_secret: z.boolean().optional().default(false),
});
export type WebhookSourceUpdateInput = z.infer<typeof WebhookSourceUpdateSchema>;
