import { describe, expect, it } from "vitest";
import { installationIdOf, resourceNames, validateName } from "../names.ts";

describe("names", () => {
  it("default name reproduces the documented names", () => {
    expect(resourceNames("saasmail")).toEqual({
      worker: "saasmail",
      d1: "saasmail-db",
      attachments: "saasmail-attachments",
      queue: "saasmail-sequence-emails",
      workflow: "saasmail-gmail-backfill",
    });
  });

  it("validateName rejects bad names and accepts good ones", () => {
    for (const bad of ["ab", "a".repeat(31), "-x1", "x1-", "Mail", "a_b"]) {
      expect(validateName(bad), bad).toEqual(expect.any(String));
    }
    expect(validateName("saasmail")).toBeNull();
    expect(validateName("mail-1")).toBeNull();
    expect(validateName("a".repeat(30))).toBeNull();
  });

  it("installationIdOf is stable and depends on the hostname", () => {
    const a = installationIdOf("acct", "saasmail", "workers.dev");
    expect(a).toMatch(/^saasmail-[0-9a-f]{12}$/);
    expect(installationIdOf("acct", "saasmail", "workers.dev")).toBe(a);
    expect(installationIdOf("acct", "saasmail", "mail.example.com")).not.toBe(
      a,
    );
    expect(installationIdOf("other", "saasmail", "workers.dev")).not.toBe(a);
  });
});
