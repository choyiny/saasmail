import { describe, expect, it } from "vitest";
import { drizzleOptions } from "../db/client";

describe("drizzleOptions", () => {
  it("disables query logging unless explicitly enabled", () => {
    expect(drizzleOptions({}).logger).toBe(false);
    expect(drizzleOptions({ DB_LOG_QUERIES: "false" }).logger).toBe(false);
    expect(drizzleOptions({ DB_LOG_QUERIES: "TRUE" }).logger).toBe(false);
    expect(drizzleOptions({ DB_LOG_QUERIES: "true" }).logger).toBe(true);
  });
});
