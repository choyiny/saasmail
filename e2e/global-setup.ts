// e2e/global-setup.ts
// NOTE: DB wipe/migration is done by e2e/scripts/wipe-db.mjs BEFORE
// `playwright test` runs (via the test:e2e script in package.json).
// By the time globalSetup is called the webServer is already up and healthy,
// so wiping the D1 file here would corrupt the running server's SQLite handle.
import { request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  BASE_URL,
  ADMIN,
  MEMBER,
  createAdmin,
  loginViaApi,
  createAndAcceptInvite,
} from "./support/login";

const AUTH_DIR = resolve(process.cwd(), "e2e", ".auth");

export default async function globalSetup(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });

  // Playwright has already confirmed the webServer is healthy before calling
  // globalSetup, so we can talk to the API immediately.

  // 1. Create admin via setup API.
  const adminCtx = await request.newContext();
  await createAdmin(adminCtx);

  // 2. Log admin in; save storageState.
  await loginViaApi(adminCtx, ADMIN.email, ADMIN.password);
  await adminCtx.storageState({ path: resolve(AUTH_DIR, "admin.json") });

  // 3. Create seeded member via invite flow. No inbox assignments at invite time.
  const memberCtx = await request.newContext();
  await createAndAcceptInvite(adminCtx, memberCtx, {
    email: MEMBER.email,
    password: MEMBER.password,
    name: MEMBER.name,
    role: "member",
    inboxEmails: [],
  });
  await memberCtx.storageState({ path: resolve(AUTH_DIR, "member.json") });

  await adminCtx.dispose();
  await memberCtx.dispose();
}
