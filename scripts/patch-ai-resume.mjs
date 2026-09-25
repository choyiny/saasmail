import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_AI_VERSION = "7.0.109";
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

export async function patchInstalledAi({ root = process.cwd() } = {}) {
  const packagePath = resolve(root, "node_modules/ai/package.json");
  const distPath = resolve(root, "node_modules/ai/dist/index.js");

  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${packagePath}. Re-check docs/updating.md before changing the pinned AI SDK version.`,
      { cause: error },
    );
  }

  if (packageJson.version !== EXPECTED_AI_VERSION) {
    throw new Error(
      `Expected ai@${EXPECTED_AI_VERSION}, found ai@${String(packageJson.version)}. Re-check docs/updating.md before changing the pinned AI SDK version.`,
    );
  }

  const source = await readFile(distPath, "utf8");
  const patched = transformAiResumeSource(source);
  if (patched !== source) {
    await writeFile(distPath, patched, "utf8");
    console.log(`[patch-ai-resume] patched ai@${EXPECTED_AI_VERSION}`);
  } else {
    console.log(`[patch-ai-resume] ai@${EXPECTED_AI_VERSION} already patched`);
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
