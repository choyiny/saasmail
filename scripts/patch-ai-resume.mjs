import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_AI_VERSION = "7.0.109";
const EXPECTED_AI_REACT_VERSION = "4.0.112";
const ACTIVE_RESUME_ANCHOR =
  'const activeResumeRequest = trigger === "resume-stream"';
const ABORT_AND_ACTIVE =
  'const abortController = new AbortController();\n    const activeResumeRequest = trigger === "resume-stream"';
const SEED_LINE =
  'const seedToolContinuation = trigger === "resume-stream" && this.transport?._expectToolContinuation === true;';
const ORIGINAL_LAST_MESSAGE =
  'lastMessage: trigger === "resume-stream" || trigger === "regenerate-message" ? void 0 : this.state.snapshot(lastMessage),';
const PATCHED_LAST_MESSAGE =
  'lastMessage: trigger === "regenerate-message" || (trigger === "resume-stream" && !seedToolContinuation) ? void 0 : this.state.snapshot(lastMessage),';

// `useChat` hands the Chat a proxy transport instead of the transport it was
// given, so the seed check above can't see `_expectToolContinuation` on
// Cloudflare's WebSocketChatTransport unless the proxy forwards it.
const REACT_PROXY_ANCHOR =
  "reconnectToStream: (reconnectOptions) => getTransport().reconnectToStream(reconnectOptions)\n    },";
const REACT_PROXY_FORWARD =
  "get _expectToolContinuation() {\n        return getTransport()._expectToolContinuation;\n      }";
const PATCHED_REACT_PROXY = `reconnectToStream: (reconnectOptions) => getTransport().reconnectToStream(reconnectOptions),\n      ${REACT_PROXY_FORWARD}\n    },`;

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

export function transformAiResumeSource(source) {
  const activeCount = occurrences(source, ACTIVE_RESUME_ANCHOR);
  if (activeCount !== 1) {
    throw new Error(
      `Expected exactly one AI SDK resume anchor, found ${activeCount}. Re-check docs/updating.md before changing the pinned AI SDK version.`,
    );
  }

  const originalCount = occurrences(source, ORIGINAL_LAST_MESSAGE);
  const patchedCount = occurrences(source, PATCHED_LAST_MESSAGE);
  const seedCount = occurrences(source, SEED_LINE);

  if (originalCount === 0 && patchedCount === 1 && seedCount === 1) {
    return source;
  }

  if (originalCount !== 1 || patchedCount !== 0 || seedCount !== 0) {
    throw new Error(
      `AI SDK resume patch anchors are inconsistent (original=${originalCount}, patched=${patchedCount}, seed=${seedCount}). Re-check docs/updating.md before changing the pinned AI SDK version.`,
    );
  }

  const abortAnchorCount = occurrences(source, ABORT_AND_ACTIVE);
  if (abortAnchorCount !== 1) {
    throw new Error(
      `Expected exactly one AI SDK makeRequest abort/resume anchor, found ${abortAnchorCount}. Re-check docs/updating.md before changing the pinned AI SDK version.`,
    );
  }

  const withSeed = source.replace(
    ABORT_AND_ACTIVE,
    `const abortController = new AbortController();\n    ${SEED_LINE}\n    const activeResumeRequest = trigger === "resume-stream"`,
  );
  return withSeed.replace(ORIGINAL_LAST_MESSAGE, PATCHED_LAST_MESSAGE);
}

export function transformAiReactTransportSource(source) {
  const originalCount = occurrences(source, REACT_PROXY_ANCHOR);
  const forwardCount = occurrences(source, REACT_PROXY_FORWARD);

  if (originalCount === 0 && forwardCount === 1) {
    return source;
  }

  if (originalCount !== 1 || forwardCount !== 0) {
    throw new Error(
      `@ai-sdk/react transport proxy anchors are inconsistent (original=${originalCount}, forward=${forwardCount}). Re-check docs/updating.md before changing the pinned AI SDK version.`,
    );
  }

  return source.replace(REACT_PROXY_ANCHOR, PATCHED_REACT_PROXY);
}

async function patchPackage({ root, name, version, file, transform }) {
  const packagePath = resolve(root, "node_modules", name, "package.json");
  const distPath = resolve(root, "node_modules", name, file);

  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${packagePath}. Re-check docs/updating.md before changing the pinned AI SDK version.`,
      { cause: error },
    );
  }

  if (packageJson.version !== version) {
    throw new Error(
      `Expected ${name}@${version}, found ${name}@${String(packageJson.version)}. Re-check docs/updating.md before changing the pinned AI SDK version.`,
    );
  }

  const source = await readFile(distPath, "utf8");
  const patched = transform(source);
  if (patched === source) {
    console.log(`[patch-ai-resume] ${name}@${version} already patched`);
    return false;
  }
  await writeFile(distPath, patched, "utf8");
  console.log(`[patch-ai-resume] patched ${name}@${version}`);
  return true;
}

export async function patchInstalledAi({ root = process.cwd() } = {}) {
  const changed = [
    await patchPackage({
      root,
      name: "ai",
      version: EXPECTED_AI_VERSION,
      file: "dist/index.js",
      transform: transformAiResumeSource,
    }),
    await patchPackage({
      root,
      name: "@ai-sdk/react",
      version: EXPECTED_AI_REACT_VERSION,
      file: "dist/index.js",
      transform: transformAiReactTransportSource,
    }),
  ];

  // Vite's dependency pre-bundle cache is keyed on the lockfile, not on file
  // contents, so `yarn dev` would keep serving the unpatched copies.
  if (changed.some(Boolean)) {
    await rm(resolve(root, "node_modules/.vite"), {
      recursive: true,
      force: true,
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  patchInstalledAi().catch((error) => {
    console.error(
      `[patch-ai-resume] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
