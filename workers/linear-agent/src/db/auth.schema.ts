// Drizzle table definitions for Better Auth (with `usePlural: true`)
// and the organization plugin (teams enabled).
//
// Keep this file in sync with migrations/0001_init.sql. If we add or
// remove a Better Auth plugin that changes the schema, regenerate via:
//   npx @better-auth/cli generate --config src/lib/auth.ts \
//       --output src/db/auth.schema.ts -y
// then port the diff into migrations/.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ── Core ───────────────────────────────────────────────────────────

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  // Nullable on create — Better Auth's org plugin only fills this on
  // subsequent updates.
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  activeOrganizationId: text("activeOrganizationId").references(
    () => organizations.id,
    { onDelete: "set null" },
  ),
  activeTeamId: text("activeTeamId").references(() => teams.id, {
    onDelete: "set null",
  }),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

// ── Organization plugin (teams enabled) ────────────────────────────

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  teamId: text("teamId").references(() => teams.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  inviterId: text("inviterId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const teamMembers = sqliteTable("teamMembers", {
  id: text("id").primaryKey(),
  teamId: text("teamId")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});
