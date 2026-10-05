import type { Context, Next } from "hono";
import { createDb } from "./client";

export async function injectDb(c: Context, next: Next) {
  const db = createDb(c.env);
  c.set("db", db);
  return await next();
}
