export type Comparison =
  | { kind: "upgrade" | "same" | "downgrade" }
  | { kind: "custom"; reason: string };

const GITHUB_REPO = "choyiny/saasmail";
const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{7,40}(-dirty)?$/;

function parse(v: string) {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : null,
  };
}

function comparePre(a: string[], b: string[]): -1 | 0 | 1 {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** x.y.z numeric; a prerelease sorts before its release. A non-semver string is not comparable: 0. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! < pb.nums[i]! ? -1 : 1;
  }
  if (pa.pre && pb.pre) return comparePre(pa.pre, pb.pre);
  if (pa.pre) return -1;
  if (pb.pre) return 1;
  return 0;
}

export async function compareRunning(
  running: string | null,
  pkg: { version: string; commit: string },
  fetchImpl: typeof fetch,
): Promise<Comparison> {
  if (running === null)
    return { kind: "custom", reason: "the running version is unknown" };
  if (parse(running) && parse(pkg.version)) {
    const c = compareSemver(running, pkg.version);
    return { kind: c < 0 ? "upgrade" : c > 0 ? "downgrade" : "same" };
  }
  if (!COMMIT.test(running))
    return {
      kind: "custom",
      reason: `the running version "${running}" is not a release or a commit`,
    };
  if (running.endsWith("-dirty"))
    return { kind: "custom", reason: "uncommitted changes" };
  const unchecked: Comparison = {
    kind: "custom",
    reason: `could not check commit ${running} against ${GITHUB_REPO}`,
  };
  if (!pkg.commit) return unchecked;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${GITHUB_REPO}/compare/${running}...${pkg.commit}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "saasmail-cli",
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return unchecked;
    const body = (await res.json()) as { status?: string };
    switch (body.status) {
      case "ahead":
        return { kind: "upgrade" };
      case "identical":
        return { kind: "same" };
      case "behind":
        return { kind: "downgrade" };
      case "diverged":
        return {
          kind: "custom",
          reason: "commits that are not in the release",
        };
      default:
        return unchecked;
    }
  } catch {
    return unchecked;
  }
}

/** dist-tags.latest from the npm registry; null on any failure. */
export async function latestOnNpm(
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl("https://registry.npmjs.org/saasmail", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      "dist-tags"?: { latest?: unknown };
    };
    const latest = body["dist-tags"]?.latest;
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
}
