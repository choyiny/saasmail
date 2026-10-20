import { describe, expect, it } from "vitest";
import { collect, type Io } from "../collect.ts";

function io(
  tty: boolean,
  answer: string | null = "prompted",
): Io & { asked: number } {
  const o = {
    tty,
    asked: 0,
    async prompt() {
      o.asked++;
      return answer;
    },
    async select<T>(_m: string, options: { value: T }[]) {
      return options[0]!.value;
    },
    async confirm(_m: string, initial: boolean) {
      return initial;
    },
    print() {},
  };
  return o;
}
const base = { message: "Name?", flagName: "--name" };

describe("collect", () => {
  it("prefers flag, then env, then draft, then prompt", async () => {
    const i = io(true);
    expect(await collect(i, { ...base, flag: "f", env: "e", draft: "d" })).toBe(
      "f",
    );
    expect(await collect(i, { ...base, env: "e", draft: "d" })).toBe("e");
    expect(await collect(i, { ...base, draft: "d" })).toBe("d");
    expect(i.asked).toBe(0);
    expect(await collect(i, base)).toBe("prompted");
    expect(i.asked).toBe(1);
  });
  it("treats empty strings as undefined", async () => {
    expect(
      await collect(io(true), { ...base, flag: "", env: "", draft: "d" }),
    ).toBe("d");
  });
  it("fails naming the flag without a terminal", async () => {
    await expect(collect(io(false), base)).rejects.toThrow(
      "--name is required when not running in a terminal.",
    );
  });
  it("throws the validator message for a bad flag or env value", async () => {
    const validate = (v: string) => (v === "bad" ? "nope" : undefined);
    await expect(
      collect(io(true), { ...base, flag: "bad", validate }),
    ).rejects.toThrow("nope");
    await expect(
      collect(io(true), { ...base, env: "bad", validate }),
    ).rejects.toThrow("nope");
  });
  it("ignores an invalid draft: prompts in a terminal, fails otherwise", async () => {
    const validate = (v: string) => (v === "bad" ? "nope" : undefined);
    expect(await collect(io(true), { ...base, draft: "bad", validate })).toBe(
      "prompted",
    );
    await expect(
      collect(io(false), { ...base, draft: "bad", validate }),
    ).rejects.toThrow("--name is required");
  });
  it("without a terminal, returns the fallback instead of failing", async () => {
    expect(await collect(io(false), { ...base, fallback: "saasmail" })).toBe(
      "saasmail",
    );
  });
  it("passes the initial value to the prompt", async () => {
    let seen: string | undefined;
    const i = io(true);
    i.prompt = async (_m, opts) => {
      seen = opts.initial;
      return "x";
    };
    expect(await collect(i, { ...base, initial: "saasmail" })).toBe("x");
    expect(seen).toBe("saasmail");
  });
  it("a cancelled prompt throws", async () => {
    await expect(collect(io(true, null), base)).rejects.toThrow("Cancelled.");
  });
});
