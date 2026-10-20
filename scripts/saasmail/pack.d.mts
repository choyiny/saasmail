// Types for pack.mjs (plain JavaScript so it runs on any Node 22), for its tests.
export function npmManifest(o: {
  version: string;
  commit: string;
  wranglerVersion: string;
}): object;
export function pack(argv: string[]): Promise<void>;
