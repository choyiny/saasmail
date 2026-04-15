import { defineConfig } from "drizzle-kit";
import fs from "fs";
import path from "path";

function getLocalD1DB(): string {
  const wranglerDir = path.resolve(".wrangler");
  const d1Dir = path.join(
    wranglerDir,
    "state",
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
  );
  if (!fs.existsSync(d1Dir)) {
    throw new Error(
      `D1 directory not found at ${d1Dir}. Run 'wrangler dev' first.`,
    );
  }
  const files = fs.readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (files.length === 0) {
    throw new Error("No SQLite files found. Run 'wrangler dev' first.");
  }
  return path.join(d1Dir, files[0]);
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./worker/src/db/index.ts",
  out: "./migrations",
  ...(process.env.NODE_ENV === "production"
    ? {
        driver: "d1-http",
        dbCredentials: {
          accountId: process.env.CLOUDFLARE_D1_ACCOUNT_ID!,
          databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
          token: process.env.CLOUDFLARE_D1_API_TOKEN!,
        },
      }
    : {
        dbCredentials: {
          url: getLocalD1DB(),
        },
      }),
});
