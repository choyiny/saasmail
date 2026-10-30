import type { DrizzleD1Database } from "drizzle-orm/d1";
import { hardBouncedAmong } from "../suppressions";

export const RECIPIENT_HARD_BOUNCED = "RECIPIENT_HARD_BOUNCED";

/** A send refused because a recipient hard-bounced. Nothing was sent or stored. */
export type HardBouncedRefusal = {
  ok: false;
  code: typeof RECIPIENT_HARD_BOUNCED;
  message: string;
  addresses: string[];
};

export function hardBouncedMessage(addresses: readonly string[]): string {
  return `${addresses.join(", ")} hard-bounced and cannot receive mail. Remove the address on the Suppressions page if it works again.`;
}

/**
 * The refusal for a transactional send to `recipients`, or null when none of
 * them hard-bounced (docs/suppressions.md).
 */
export async function refuseHardBounced(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  recipients: readonly string[],
): Promise<HardBouncedRefusal | null> {
  const addresses = await hardBouncedAmong(db, recipients);
  if (addresses.length === 0) return null;
  return {
    ok: false,
    code: RECIPIENT_HARD_BOUNCED,
    message: hardBouncedMessage(addresses),
    addresses,
  };
}
