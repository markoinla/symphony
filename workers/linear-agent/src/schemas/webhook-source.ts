import { z } from "zod";

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
  name: z.string(),
  kind: z.literal("generic"),
  enabled: z.boolean(),
  config: WebhookSourceConfigSchema,
  webhook_url: z.string().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  last_used_at: z.number().int().nullable().optional(),
});
export type WebhookSource = z.infer<typeof WebhookSourceSchema>;

export const WebhookSourceCreateSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  config: WebhookSourceConfigSchema.partial().default({}),
});
export type WebhookSourceCreateInput = z.infer<typeof WebhookSourceCreateSchema>;

export const WebhookSourceUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: WebhookSourceConfigSchema.partial().optional(),
});
export type WebhookSourceUpdateInput = z.infer<typeof WebhookSourceUpdateSchema>;
