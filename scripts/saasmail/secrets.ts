// Secrets and the setup code for the installer. Nothing here puts a secret into a returned message.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomInt,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function generateHexSecret(): string {
  return randomBytes(32).toString("hex");
}

/** `TOKEN_ENCRYPTION_KEY`: 32 random bytes, standard base64 (worker/src/lib/crypto.ts decodes it with atob). */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

/** Same encoding as scripts/generate-vapid.ts: base64url of the 65-byte point and of the 32-byte scalar. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pub = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const priv = privateKey.export({ format: "jwk" }) as { d: string };
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pub.x, "base64url"),
    Buffer.from(pub.y, "base64url"),
  ]);
  return {
    publicKey: raw.toString("base64url"),
    privateKey: Buffer.from(priv.d, "base64url").toString("base64url"),
  };
}

// No I, L or O. 20 characters of 31 is about 99 bits.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateSetupCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    let group = "";
    for (let i = 0; i < 4; i++)
      group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}

/** Same as worker/src/lib/setup-code.ts: strip dashes and whitespace, upper-case, SHA-256, lowercase hex. */
export function setupCodeHash(code: string): string {
  return createHash("sha256")
    .update(code.replace(/[\s-]/g, "").toUpperCase())
    .digest("hex");
}

/**
 * Hands `fn` the path of a 0600 JSON file for `wrangler deploy --secrets-file`. Wrangler tries
 * JSON first whatever the extension, and the flag is additive: secrets left out are not deleted.
 * The whole directory is removed afterwards.
 */
export async function withSecretsFile<T>(
  secrets: Record<string, string>,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "saasmail-"));
  try {
    const path = join(dir, "secrets.json");
    writeFileSync(path, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
