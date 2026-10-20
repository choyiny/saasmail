import { describe, expect, it } from "vitest";
import { npmManifest } from "../pack.mjs";

describe("npmManifest", () => {
  it("describes the published package", () => {
    expect(
      npmManifest({
        version: "1.2.0",
        commit: "abc",
        wranglerVersion: "4.127.0",
      }),
    ).toEqual({
      name: "saasmail",
      version: "1.2.0",
      description:
        "Install, upgrade and adopt a saasmail deployment on Cloudflare.",
      license: "Apache-2.0",
      type: "module",
      bin: { saasmail: "bin/saasmail.js" },
      engines: { node: ">=22.0.0" },
      dependencies: { wrangler: "4.127.0" },
      saasmailCommit: "abc",
      repository: {
        type: "git",
        url: "git+https://github.com/choyiny/saasmail.git",
      },
      files: [
        "bin",
        "worker",
        "client",
        "migrations",
        "wrangler.jsonc.example",
        "README.md",
        "LICENSE",
      ],
    });
  });
});
