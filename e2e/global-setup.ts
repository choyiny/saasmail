// e2e/global-setup.ts
import { request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { wipeAndSeed } from "./support/reset-db";
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
  // 1. Fresh DB. Runs before webServer starts.
  wipeAndSeed();

  mkdirSync(AUTH_DIR, { recursive: true });

  // 2. Wait for the dev server to be up (webServer spawns it in parallel).
  await waitForServer();

  // 3. Create admin via setup API.
  const adminCtx = await request.newContext();
  await createAdmin(adminCtx);

  // 4. Log admin in; save storageState.
  await loginViaApi(adminCtx, ADMIN.email, ADMIN.password);
  await adminCtx.storageState({ path: resolve(AUTH_DIR, "admin.json") });

  // 5. Create seeded member via invite flow. No inbox assignments at invite time.
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

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not become ready at ${BASE_URL}/api/health`);
}
