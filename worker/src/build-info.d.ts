/**
 * The build stamp, defined at build time in the Worker bundle only
 * (`scripts/build-stamp.mjs`). Read it through `lib/build-info.ts`.
 */
declare const __SAASMAIL_BUILD__:
  | {
      version: string;
      commit: string;
      commitShort: string;
      commitTime: string | null;
      dirty: boolean;
      dirtyFiles: string[];
      dirtyCount: number;
      builtAt: string;
      migrations: string[];
    }
  | undefined;
