import { z } from "zod";

import type { EventTuple } from "../schemas/event";
import type { WebhookSourceRecord } from "./store";

const SENTRY_LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;
type SentryLevel = (typeof SENTRY_LEVELS)[number];

export async function computeSentrySignature(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifySentrySignature(
  secret: string,
  body: string,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header) return false;
  const expected = await computeSentrySignature(secret, body);
  const given = header.trim();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

const AnyRecord = z.record(z.string(), z.unknown());

export interface NormalizedSentryEvent {
  eventType: "sentry.alert.fired" | "sentry.issue.created" | "sentry.issue.resolved";
  subject: Extract<EventTuple["subject"], { kind: "sentry_event" }>;
  context: Record<string, unknown>;
  webhookId: string | null;
  summary: string;
}

export function normalizeSentryWebhook(
  payload: unknown,
  source: WebhookSourceRecord,
): NormalizedSentryEvent {
  const root = AnyRecord.parse(payload);
  const action = str(root.action) ?? str(root["action"]);
  const installation = asRecord(root.installation);
  const data = asRecord(root.data) ?? root;
  const event = asRecord(data.event) ?? asRecord(root.event) ?? data;
  const issue = asRecord(data.issue) ?? asRecord(root.issue) ?? asRecord(event.issue);

  const eventType = inferEventType(action, data, issue);
  const project =
    slug(asRecord(data.project)) ??
    slug(asRecord(root.project)) ??
    slug(asRecord(event.project)) ??
    str(event.project) ??
    str(issue?.project) ??
    str(source.config_project_slug) ??
    "unknown";
  const eventId =
    str(event.event_id) ?? str(event.eventID) ?? str(event.id) ?? str(issue?.id) ?? crypto.randomUUID();
  const level = normalizeLevel(str(event.level) ?? str(issue?.level));
  const fingerprint = normalizeFingerprint(event.fingerprint ?? issue?.fingerprint);
  const message =
    str(event.message) ??
    str(event.title) ??
    str(issue?.title) ??
    str(issue?.shortId) ??
    "Sentry event";
  const relatedIssueUrl =
    str(issue?.permalink) ??
    str(issue?.web_url) ??
    str(event.web_url) ??
    str(event.url) ??
    str(root.url) ??
    str(installation?.web_url) ??
    "";

  const subject = {
    kind: "sentry_event" as const,
    project,
    event_id: eventId,
    level,
    fingerprint,
    message,
    stacktrace: extractStacktrace(event),
    breadcrumbs: extractBreadcrumbs(event),
    related_issue_url: relatedIssueUrl,
    environment: str(event.environment) ?? undefined,
    release: str(event.release) ?? undefined,
  };

  return {
    eventType,
    subject,
    context: { sentry: { action, data, installation }, subject, raw: root },
    webhookId: str(root.webhookId) ?? str(root.id) ?? eventId,
    summary: `${eventType}: ${project} ${level} ${message}`,
  };
}

export function buildSentryEventTuple(args: {
  orgId: string;
  source: WebhookSourceRecord;
  normalized: NormalizedSentryEvent;
}): EventTuple {
  const { orgId, source, normalized } = args;
  const subject = normalized.subject;
  return {
    event_type: normalized.eventType,
    organization_id: orgId,
    project_id: source.project_id,
    team_id: null,
    user_id: null,
    assignee_id: null,
    labels: [],
    subject,
    issue: null,
    context: normalized.context,
    sentry_project: subject.project,
    sentry_level: subject.level,
    sentry_fingerprint: subject.fingerprint,
    sentry_environment: subject.environment ?? null,
    sentry_release: subject.release ?? null,
  } as EventTuple;
}

function inferEventType(
  action: string | null,
  data: Record<string, unknown>,
  issue: Record<string, unknown> | null,
): NormalizedSentryEvent["eventType"] {
  if (action === "event.alert") return "sentry.alert.fired";
  if (action === "issue.resolved") return "sentry.issue.resolved";
  if (action === "issue.created") return "sentry.issue.created";
  const status = str(issue?.status) ?? str(data.status);
  if (status === "resolved") return "sentry.issue.resolved";
  return "sentry.issue.created";
}

function extractStacktrace(event: Record<string, unknown>): NormalizedSentryEvent["subject"]["stacktrace"] {
  const entries = Array.isArray(event.entries) ? event.entries : [];
  const frames: unknown[] = [];
  for (const entry of entries) {
    const e = asRecord(entry);
    if (!e || e.type !== "exception") continue;
    const values = Array.isArray(asRecord(e.data)?.values) ? asRecord(e.data)!.values as unknown[] : [];
    for (const value of values) {
      const stacktrace = asRecord(value)?.stacktrace;
      const fs = asRecord(stacktrace)?.frames;
      if (Array.isArray(fs)) frames.push(...fs);
    }
  }
  const directFrames = asRecord(event.stacktrace)?.frames;
  if (Array.isArray(directFrames)) frames.push(...directFrames);
  return frames.map((frame) => {
    const f = asRecord(frame) ?? {};
    return {
      filename: str(f.filename) ?? str(f.abs_path) ?? "",
      function: str(f.function) ?? "",
      lineno: num(f.lineno),
      colno: num(f.colno),
      in_app: bool(f.in_app),
      context_line: str(f.context_line) ?? "",
    };
  });
}

function extractBreadcrumbs(event: Record<string, unknown>): NormalizedSentryEvent["subject"]["breadcrumbs"] {
  const crumbs = asRecord(event.breadcrumbs)?.values ?? asRecord(event.breadcrumbs)?.breadcrumbs ?? event.breadcrumbs;
  const values = Array.isArray(crumbs) ? crumbs : [];
  return values.map((crumb) => {
    const c = asRecord(crumb) ?? {};
    return {
      timestamp: str(c.timestamp) ?? (typeof c.timestamp === "number" ? String(c.timestamp) : ""),
      category: str(c.category) ?? "",
      level: str(c.level) ?? "info",
      message: str(c.message) ?? "",
      data: asRecord(c.data) ?? {},
    };
  });
}

function normalizeLevel(value: string | null | undefined): SentryLevel {
  return SENTRY_LEVELS.includes(value as SentryLevel) ? (value as SentryLevel) : "error";
}

function normalizeFingerprint(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") return [value];
  return [];
}

function slug(record: Record<string, unknown> | null): string | null {
  return str(record?.slug) ?? str(record?.name) ?? str(record?.id);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function str(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function num(value: unknown): number | null { return typeof value === "number" ? value : null; }
function bool(value: unknown): boolean { return value === true; }
