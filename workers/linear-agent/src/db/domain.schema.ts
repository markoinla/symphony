// Domain tables for the linear-agent Worker. Keyed by Better Auth
// `organizations.id`. See migrations/0001_init.sql for the SQL.

import {
  blob,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { organizations, teams, users } from "./auth.schema";

// One row per Linear workspace that has installed the Linear Agent
// (actor=app OAuth flow). The `linear_organization_id` is the GraphQL
// id of the Linear Organization — used to resolve a tenant when a
// Linear webhook arrives.
export const linearAgentInstalls = sqliteTable(
  "linear_agent_installs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    linearOrganizationId: text("linear_organization_id").notNull().unique(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    scopes: text("scopes").notNull(),
    installedByUserId: text("installed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"),
    installedAt: integer("installed_at", { mode: "timestamp" }).notNull(),
    refreshedAt: integer("refreshed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    linearOrgIdx: uniqueIndex("idx_linear_agent_installs_linear_org").on(
      table.linearOrganizationId,
    ),
  }),
);

export const githubInstalls = sqliteTable("github_installs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  installId: integer("install_id").notNull().unique(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull().default("Organization"),
  repoSelection: text("repo_selection").notNull().default("all"),
  selectedRepos: text("selected_repos"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    linearTeamId: text("linear_team_id").notNull(),
    linearTeamName: text("linear_team_name").notNull().default(""),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    engine: text("engine").notNull().default("pi"),
    model: text("model"),
    maxTurns: integer("max_turns").notNull().default(10),
    scope: text("scope"),
    systemPromptOverride: text("system_prompt_override"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    orgTeamUnique: uniqueIndex("idx_projects_org_team_unique").on(
      table.organizationId,
      table.linearTeamId,
    ),
  }),
);

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, {
    onDelete: "set null",
  }),
  linearIssueId: text("linear_issue_id"),
  linearIssueIdentifier: text("linear_issue_identifier"),
  linearIssueTitle: text("linear_issue_title"),
  status: text("status").notNull().default("running"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  triggeredBy: text("triggered_by"),
  team: text("team"),
  repo: text("repo"),
  prompt: text("prompt"),
  configSnapshot: text("config_snapshot"),
  stderr: text("stderr"),
  dispatcherLogs: text("dispatcher_logs"),
  messages: text("messages"),
  error: text("error"),
});

export const orgCredentials = sqliteTable(
  "org_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    ciphertext: blob("ciphertext").notNull(),
    dekCiphertext: blob("dek_ciphertext").notNull(),
    kekVersion: integer("kek_version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    orgKindUnique: uniqueIndex("idx_org_credentials_org_kind").on(
      table.organizationId,
      table.kind,
    ),
  }),
);

// ── Workflows + triggers (SYM-295) ─────────────────────────────────
//
// See migrations/0002_workflows.sql. JSON-array columns are stored as
// TEXT and parsed by callers; Drizzle's `text()` matches the SQL type.
// The single-scope CHECK constraint is enforced in SQL, not here.

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    // Exactly one of these three is non-null. The CHECK constraint in
    // the migration enforces this at write time.
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    description: text("description"),

    engine: text("engine").notNull().default("pi"),
    model: text("model"),
    maxTurns: integer("max_turns").notNull().default(10),
    maxContinuations: integer("max_continuations"),

    allowedTools: text("allowed_tools"),
    disallowedTools: text("disallowed_tools"),
    allowedDomains: text("allowed_domains"),
    mcpServers: text("mcp_servers"),
    permissionMode: text("permission_mode"),
    additionalReadPaths: text("additional_read_paths"),
    additionalWritePaths: text("additional_write_paths"),

    hookAfterCreate: text("hook_after_create"),
    hookBeforeRemove: text("hook_before_remove"),
    hookTimeoutMs: integer("hook_timeout_ms").notNull().default(300000),

    promptTemplate: text("prompt_template").notNull(),

    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    orgIdx: index("idx_workflows_org").on(table.organizationId),
    teamIdx: index("idx_workflows_team").on(table.teamId),
    userIdx: index("idx_workflows_user").on(table.userId),
    statusIdx: index("idx_workflows_status").on(table.status),
  }),
);

export const workflowVersions = sqliteTable(
  "workflow_versions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: text("snapshot").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    workflowVersionUnique: uniqueIndex("idx_workflow_versions_workflow_version")
      .on(table.workflowId, table.version),
  }),
);

export const workflowTriggers = sqliteTable(
  "workflow_triggers",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),

    eventType: text("event_type").notNull(),

    toState: text("to_state"),
    fromState: text("from_state"),
    labelName: text("label_name"),
    commentMatch: text("comment_match"),

    teamFilter: text("team_filter"),
    projectFilter: text("project_filter"),
    labelFilter: text("label_filter"),
    skipLabelFilter: text("skip_label_filter"),
    assigneeFilter: text("assignee_filter"),

    action: text("action").notNull(),
    actionParams: text("action_params"),

    priority: integer("priority").notNull().default(0),
    enabled: integer("enabled").notNull().default(1),

    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    eventIdx: index("idx_workflow_triggers_event").on(
      table.eventType,
      table.enabled,
    ),
    workflowIdx: index("idx_workflow_triggers_workflow").on(table.workflowId),
  }),
);

// Org-scoped key/value settings. Backs the Agent settings page.
// See migrations/0004_settings.sql.
export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    orgKeyUnique: uniqueIndex("idx_settings_org_key").on(
      table.organizationId,
      table.key,
    ),
  }),
);

// Stub — issued + consumed in SYM-296. No Worker code reads from this
// table yet; the Track 2 bearer middleware will return 401 for any
// presented token until issuance ships.
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (table) => ({
    orgIdx: index("idx_api_tokens_org").on(table.organizationId),
  }),
);
