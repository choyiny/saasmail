/**
 * Which build this Worker runs: version, commit, whether the tree was dirty,
 * when it was built, and the migration files it ships. Admin-only: the doctor
 * returns it (docs/doctor.md). Never put it on a public route.
 */
export type BuildStamp = NonNullable<typeof __SAASMAIL_BUILD__>;

/** The stamp without the migration list, as the doctor reports it. */
export type BuildSummary = Omit<BuildStamp, "migrations">;

const UNKNOWN: BuildStamp = {
  version: "unknown",
  commit: "unknown",
  commitShort: "unknown",
  commitTime: null,
  dirty: false,
  dirtyFiles: [],
  dirtyCount: 0,
  builtAt: "unknown",
  migrations: [],
};

export function buildInfo(): BuildStamp {
  // Undefined when the Worker was bundled without Vite (plain `wrangler dev`).
  return typeof __SAASMAIL_BUILD__ === "undefined"
    ? UNKNOWN
    : __SAASMAIL_BUILD__;
}

export function buildSummary(stamp: BuildStamp = buildInfo()): BuildSummary {
  const { migrations: _migrations, ...summary } = stamp;
  return summary;
}
