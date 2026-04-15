import { relations, sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .default(false)
    .notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [index("sessions_userId_idx").on(table.userId)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("accounts_userId_idx").on(table.userId)],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    aaguid: text("aaguid"),
  },
  (table) => [
    index("passkeys_userId_idx").on(table.userId),
    index("passkeys_credentialID_idx").on(table.credentialID),
  ],
);

export const jwkss = sqliteTable("jwkss", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  skipConsent: integer("skip_consent", { mode: "boolean" }),
  enableEndSession: integer("enable_end_session", { mode: "boolean" }),
  subjectType: text("subject_type"),
  scopes: text("scopes", { mode: "json" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts", { mode: "json" }),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: text("redirect_uris", { mode: "json" }).notNull(),
  postLogoutRedirectUris: text("post_logout_redirect_uris", { mode: "json" }),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  grantTypes: text("grant_types", { mode: "json" }),
  responseTypes: text("response_types", { mode: "json" }),
  public: integer("public", { mode: "boolean" }),
  type: text("type"),
  requirePKCE: integer("require_pkce", { mode: "boolean" }),
  referenceId: text("reference_id"),
  metadata: text("metadata", { mode: "json" }),
});

export const oauthRefreshTokens = sqliteTable("oauth_refresh_tokens", {
  id: text("id").primaryKey(),
  token: text("token").notNull(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, {
    onDelete: "set null",
  }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  revoked: integer("revoked", { mode: "timestamp_ms" }),
  authTime: integer("auth_time", { mode: "timestamp_ms" }),
  scopes: text("scopes", { mode: "json" }).notNull(),
});

export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
  id: text("id").primaryKey(),
  token: text("token").unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, {
    onDelete: "set null",
  }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, {
    onDelete: "cascade",
  }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  scopes: text("scopes", { mode: "json" }).notNull(),
});

export const oauthConsents = sqliteTable("oauth_consents", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  referenceId: text("reference_id"),
  scopes: text("scopes", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  passkeys: many(passkeys),
  oauthClients: many(oauthClients),
  oauthRefreshTokens: many(oauthRefreshTokens),
  oauthAccessTokens: many(oauthAccessTokens),
  oauthConsents: many(oauthConsents),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  users: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
  oauthRefreshTokens: many(oauthRefreshTokens),
  oauthAccessTokens: many(oauthAccessTokens),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  users: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  users: one(users, {
    fields: [passkeys.userId],
    references: [users.id],
  }),
}));

export const oauthClientsRelations = relations(
  oauthClients,
  ({ one, many }) => ({
    users: one(users, {
      fields: [oauthClients.userId],
      references: [users.id],
    }),
    oauthRefreshTokens: many(oauthRefreshTokens),
    oauthAccessTokens: many(oauthAccessTokens),
    oauthConsents: many(oauthConsents),
  }),
);

export const oauthRefreshTokensRelations = relations(
  oauthRefreshTokens,
  ({ one, many }) => ({
    oauthClients: one(oauthClients, {
      fields: [oauthRefreshTokens.clientId],
      references: [oauthClients.clientId],
    }),
    sessions: one(sessions, {
      fields: [oauthRefreshTokens.sessionId],
      references: [sessions.id],
    }),
    users: one(users, {
      fields: [oauthRefreshTokens.userId],
      references: [users.id],
    }),
    oauthAccessTokens: many(oauthAccessTokens),
  }),
);

export const oauthAccessTokensRelations = relations(
  oauthAccessTokens,
  ({ one }) => ({
    oauthClients: one(oauthClients, {
      fields: [oauthAccessTokens.clientId],
      references: [oauthClients.clientId],
    }),
    sessions: one(sessions, {
      fields: [oauthAccessTokens.sessionId],
      references: [sessions.id],
    }),
    users: one(users, {
      fields: [oauthAccessTokens.userId],
      references: [users.id],
    }),
    oauthRefreshTokens: one(oauthRefreshTokens, {
      fields: [oauthAccessTokens.refreshId],
      references: [oauthRefreshTokens.id],
    }),
  }),
);

export const oauthConsentsRelations = relations(oauthConsents, ({ one }) => ({
  oauthClients: one(oauthClients, {
    fields: [oauthConsents.clientId],
    references: [oauthClients.clientId],
  }),
  users: one(users, {
    fields: [oauthConsents.userId],
    references: [users.id],
  }),
}));
