import { z } from "zod";

export const webhookSourceKindSchema = z.enum(["github"]);
export type WebhookSourceKind = z.infer<typeof webhookSourceKindSchema>;

export const WebhookSourceSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  kind: webhookSourceKindSchema,
  name: z.string(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type WebhookSource = z.infer<typeof WebhookSourceSchema>;

export const WebhookSourceCreateSchema = z.object({
  kind: webhookSourceKindSchema,
  name: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()).optional().default({}),
});
export type WebhookSourceCreateInput = z.infer<typeof WebhookSourceCreateSchema>;

export const WebhookSourceUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  rotate_secret: z.boolean().optional().default(false),
});
export type WebhookSourceUpdateInput = z.infer<typeof WebhookSourceUpdateSchema>;
