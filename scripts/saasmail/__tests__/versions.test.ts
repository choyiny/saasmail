import { describe, expect, it } from "vitest";
import { compareRunning, compareSemver, latestOnNpm } from "../versions.ts";

const pkg = { version: "1.2.0", commit: "abcdef1234567" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;
const never = (async () => {
  throw new Error("must not fetch");
}) as unknown as typeof fetch;

describe("compareRunning", () => {
  it("semver older is upgrade", async () =>
    expect(await compareRunning("1.1.9", pkg, never)).toEqual({
      kind: "upgrade",
    }));
  it("semver equal is same", async () =>
    expect(await compareRunning("v1.2.0", pkg, never)).toEqual({
      kind: "same",
    }));
  it("semver newer is downgrade", async () =>
    expect(await compareRunning("1.10.0", pkg, never)).toEqual({
      kind: "downgrade",
    }));
  it("1.2.0-rc.1 < 1.2.0", () => {
    expect(compareSemver("1.2.0-rc.1", "1.2.0")).toBe(-1);
    expect(compareSemver("1.2.0", "1.2.0-rc.1")).toBe(1);
    expect(compareSemver("1.2.0-rc.2", "1.2.0-rc.10")).toBe(-1);
  });
  it("commit behind release is upgrade", async () => {
    const f = fakeFetch(200, { status: "ahead" });
    expect(await compareRunning("abc1234", pkg, f.fn)).toEqual({
      kind: "upgrade",
    });
    expect(f.calls[0]!.url).toBe(
      "https://api.github.com/repos/choyiny/saasmail/compare/abc1234...abcdef1234567",
    );
    const h = f.calls[0]!.init!.headers as Record<string, string>;
    expect(h.Accept).toBe("application/vnd.github+json");
    expect(h["User-Agent"]).toBe("saasmail-cli");
  });
  it("identical", async () =>
    expect(
      await compareRunning(
        "abc1234",
        pkg,
        fakeFetch(200, { status: "identical" }).fn,
      ),
    ).toEqual({ kind: "same" }));
  it("commit ahead is downgrade", async () =>
    expect(
      await compareRunning(
        "abc1234",
        pkg,
        fakeFetch(200, { status: "behind" }).fn,
      ),
    ).toEqual({ kind: "downgrade" }));
  it("diverged is custom", async () =>
    expect(
      await compareRunning(
        "abc1234",
        pkg,
        fakeFetch(200, { status: "diverged" }).fn,
      ),
    ).toEqual({
      kind: "custom",
      reason: "commits that are not in the release",
    }));
  it("dirty is custom", async () =>
    expect(await compareRunning("abc1234-dirty", pkg, never)).toEqual({
      kind: "custom",
      reason: "uncommitted changes",
    }));
  it("unknown commit (404) is custom", async () =>
    expect(await compareRunning("abc1234", pkg, fakeFetch(404, {}).fn)).toEqual(
      {
        kind: "custom",
        reason: "could not check commit abc1234 against choyiny/saasmail",
      },
    ));
  it("offline is custom", async () =>
    expect(await compareRunning("abc1234", pkg, offline)).toEqual({
      kind: "custom",
      reason: "could not check commit abc1234 against choyiny/saasmail",
    }));
  it("null is custom", async () =>
    expect(await compareRunning(null, pkg, never)).toEqual({
      kind: "custom",
      reason: "the running version is unknown",
    }));
  it("an empty package commit is custom without fetching", async () =>
    expect(
      await compareRunning("abc1234", { version: "1.2.0", commit: "" }, never),
    ).toEqual({
      kind: "custom",
      reason: "could not check commit abc1234 against choyiny/saasmail",
    }));
  it("a value that is neither release nor commit is custom", async () =>
    expect(await compareRunning("banana", pkg, never)).toEqual({
      kind: "custom",
      reason: 'the running version "banana" is not a release or a commit',
    }));
});

describe("latestOnNpm", () => {
  it("reads dist-tags.latest", async () => {
    const f = fakeFetch(200, { "dist-tags": { latest: "1.4.0" } });
    expect(await latestOnNpm(f.fn)).toBe("1.4.0");
    expect(f.calls[0]!.url).toBe("https://registry.npmjs.org/saasmail");
  });
  it("offline is null", async () =>
    expect(await latestOnNpm(offline)).toBeNull());
});
