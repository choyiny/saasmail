// Input collection: flag -> env -> saved draft -> prompt (terminal only) -> fail naming the flag.
import * as clack from "@clack/prompts";

export type Io = {
  tty: boolean;
  prompt(
    msg: string,
    opts: {
      mask?: boolean;
      initial?: string;
      validate?: (v: string) => string | undefined;
    },
  ): Promise<string | null>;
  select<T>(msg: string, options: { value: T; label: string }[]): Promise<T>;
  confirm(msg: string, initial: boolean): Promise<boolean>;
  print(text: string): void;
};

export const clackIo: Io = {
  tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async prompt(msg, opts) {
    const options = {
      message: msg,
      validate: opts.validate
        ? (v?: string) => opts.validate!(v ?? "")
        : undefined,
    };
    const v = opts.mask
      ? await clack.password(options)
      : await clack.text({ ...options, initialValue: opts.initial });
    return clack.isCancel(v) ? null : v;
  },
  async select<T>(msg: string, options: { value: T; label: string }[]) {
    const v = await clack.select<T>({
      message: msg,
      options: options as clack.Option<T>[],
    });
    if (clack.isCancel(v)) throw new Error("Cancelled.");
    return v as T;
  },
  async confirm(msg, initial) {
    const v = await clack.confirm({ message: msg, initialValue: initial });
    if (clack.isCancel(v)) throw new Error("Cancelled.");
    return v;
  },
  print(text) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  },
};

export async function collect(
  io: Io,
  o: {
    flag?: string;
    env?: string;
    draft?: string;
    message: string;
    mask?: boolean;
    validate?: (v: string) => string | undefined;
    flagName: string;
    /** Prefilled in the prompt. */
    initial?: string;
    /** Used instead of failing when there is no terminal (a documented default, never a secret). */
    fallback?: string;
  },
): Promise<string> {
  for (const v of [o.flag, o.env]) {
    if (v === undefined || v === "") continue;
    const bad = o.validate?.(v);
    if (bad) throw new Error(bad);
    return v;
  }
  // A saved draft that no longer validates is ignored, not fatal.
  if (o.draft !== undefined && o.draft !== "" && !o.validate?.(o.draft))
    return o.draft;
  if (!io.tty) {
    if (o.fallback !== undefined) return o.fallback;
    throw new Error(
      `${o.flagName} is required when not running in a terminal.`,
    );
  }
  const v = await io.prompt(o.message, {
    mask: o.mask,
    validate: o.validate,
    initial: o.initial,
  });
  if (v === null) throw new Error("Cancelled.");
  return v;
}
