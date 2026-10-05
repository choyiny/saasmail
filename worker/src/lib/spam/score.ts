/** Counts the filter keeps for one token. */
export interface TokenCounts {
  spamCount: number;
  hamCount: number;
}

/** How many junk and not-junk messages an inbox's filter was trained on. */
export interface ModelCounts {
  spamMessages: number;
  hamMessages: number;
}

/** Messages of each label a filter needs before it scores. */
export const MIN_TRAINING_MESSAGES = 20;
/** Tokens that decide a score: the most telling ones. */
const INTERESTING_TOKENS = 15;
/** Below this many known tokens there is not enough evidence. */
const MIN_KNOWN_TOKENS = 5;
/**
 * Robinson's smoothing: a token seen n times moves from the neutral 0.5
 * towards its observed probability only as n grows (strength s = 1).
 */
const STRENGTH = 1;
const NEUTRAL = 0.5;
/** Tokens this close to neutral say nothing and are left out. */
const MIN_DEVIATION = 0.1;

/** Whether a filter has enough training to score new mail. */
export function modelReady(model: ModelCounts): boolean {
  return (
    model.spamMessages >= MIN_TRAINING_MESSAGES &&
    model.hamMessages >= MIN_TRAINING_MESSAGES
  );
}

/**
 * One token's junk probability: Graham's ratio of its junk and not-junk
 * frequencies (not-junk counted double, against false positives), smoothed
 * towards 0.5 by how often it was seen (Robinson), clamped to [0.01, 0.99].
 */
export function tokenProbability(
  count: TokenCounts,
  model: ModelCounts,
): number {
  const bad = Math.min(1, count.spamCount / model.spamMessages);
  const good = Math.min(1, (2 * count.hamCount) / model.hamMessages);
  const observed = bad + good === 0 ? NEUTRAL : bad / (bad + good);
  const seen = count.spamCount + count.hamCount;
  const smoothed = (STRENGTH * NEUTRAL + seen * observed) / (STRENGTH + seen);
  return Math.min(0.99, Math.max(0.01, smoothed));
}

/**
 * The probability that a message is junk, from its tokens' counts: the 15
 * telling tokens (farthest from 0.5, at least 0.1 away) combined as
 * Π p / (Π p + Π (1 − p)). Null with fewer than five known tokens; 0.5 when
 * none of them tells either way. Pure.
 */
export function score(
  tokens: string[],
  counts: Map<string, TokenCounts>,
  model: ModelCounts,
): number | null {
  if (model.spamMessages === 0 || model.hamMessages === 0) return null;
  const probabilities: number[] = [];
  for (const token of tokens) {
    const count = counts.get(token);
    if (!count || count.spamCount + count.hamCount < 1) continue;
    probabilities.push(tokenProbability(count, model));
  }
  if (probabilities.length < MIN_KNOWN_TOKENS) return null;

  const telling = probabilities
    .filter((p) => Math.abs(p - NEUTRAL) >= MIN_DEVIATION)
    .sort((a, b) => Math.abs(b - NEUTRAL) - Math.abs(a - NEUTRAL))
    .slice(0, INTERESTING_TOKENS);
  if (telling.length === 0) return NEUTRAL;
  // In log space, so many small factors stay exact.
  let logSpam = 0;
  let logHam = 0;
  for (const p of telling) {
    logSpam += Math.log(p);
    logHam += Math.log(1 - p);
  }
  return 1 / (1 + Math.exp(logHam - logSpam));
}
