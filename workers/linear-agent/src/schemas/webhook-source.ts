import { z } from "zod";

export const webhookSourceProviderSchema = z.enum(["sentry"]);

export const WebhookSourceSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  provider: webhookSourceProviderSchema,
  name: z.string(),
  enabled: z.boolean(),
  project_id: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  inbound_url: z.string().optional(),
  secret: z.string().optional(),
  last_received_at: z.number().int().nullable().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type WebhookSource = z.infer<typeof WebhookSourceSchema>;

export const WebhookSourceCreateSchema = z.object({
  provider: webhookSourceProviderSchema.default("sentry"),
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(true),
  project_id: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type WebhookSourceCreateInput = z.infer<typeof WebhookSourceCreateSchema>;

export const WebhookSourceUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  project_id: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  rotate_secret: z.boolean().optional(),
});
export type WebhookSourceUpdateInput = z.infer<typeof WebhookSourceUpdateSchema>;
