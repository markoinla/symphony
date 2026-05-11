// Domain tables for the linear-agent Worker. Keyed by Better Auth
// `organizations.id`. See migrations/0001_init.sql for the SQL.

import { blob, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { organizations, users } from "./auth.schema";

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
