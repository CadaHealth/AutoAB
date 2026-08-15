/**
 * Depth normalisation for group comparisons.
 *
 * Every clone-derived metric grows with the number of sequences a donor
 * contributed. Rarefaction answers the question the depth panel raises: does a
 * group difference survive when every donor is cut to the same depth? Each
 * donor is reduced to a random sample of D clone-assigned sequences, the
 * metrics are recomputed on that reduced sample rather than extrapolated, and
 * donors that never reach D drop out.
 *
 * This estimates nothing about the true repertoire. It is a diagnostic: a
 * difference that disappears at matched depth was not independent of depth.
 */

import type { SequenceData } from '../stores/app';
import { computeDiversity, type DiversityMetrics } from './repertoire-metrics';

/** Draws averaged per donor. 500 is what the reference analysis used. */
export const DEFAULT_REPLICATES = 500;

/** Fixed so the same session always yields the same numbers. */
export const DEFAULT_SEED = 42;

/**
 * Depths below this are refused outright. With four or fewer sequences a donor
 * can hold at most four clones, Shannon is capped at ln(4) = 1.39, and Chao1
 * is determined by whether one pair happens to repeat. Nothing measured there
 * can separate two groups, so offering the choice would only produce
 * confident-looking noise.
 */
export const MIN_USEFUL_DEPTH = 5;

/** Fraction of donors the suggested default is willing to lose. */
const DEFAULT_LOSS_TOLERANCE = 0.1;

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32. Math.random() cannot be used here: an unseeded draw would move
 * every p-value on every re-render, and the same view would disagree with
 * itself between two clicks.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a over the donor key. The per-donor seed must not depend on the order
 * files were loaded in, or the same study would rarefy differently after a
 * reload.
 */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Partial Fisher-Yates: draws k of n without replacement, O(k). */
function sampleWithoutReplacement<T>(items: T[], k: number, rng: () => number): T[] {
  const pool = items.slice();
  const n = pool.length;
  const take = Math.min(k, n);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, take);
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

/** Sequences carrying a clone id, the pool rarefaction draws from. */
export function cloneAssigned(seqs: SequenceData[]): SequenceData[] {
  return seqs.filter((s) => s.clone_id !== null && s.clone_id !== undefined);
}

export interface DepthChoice {
  depth: number;
  kept: number;
  total: number;
  /** True when the suggestion hit MIN_USEFUL_DEPTH instead of the loss rule. */
  atFloor: boolean;
}

/**
 * Suggested depth: the largest that loses no more than DEFAULT_LOSS_TOLERANCE
 * of donors.
 *
 * Deliberately not the minimum donor depth, which is the intuitive choice and
 * the wrong one. In the reference study one donor contributed a single
 * clone-assigned sequence, so the minimum rule would default to D = 1 and the
 * first thing a user saw would be meaningless. One pathological donor should
 * not set the depth for everyone.
 */
export function suggestDepth(depths: number[]): DepthChoice {
  const sorted = depths.filter((d) => d > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { depth: MIN_USEFUL_DEPTH, kept: 0, total: 0, atFloor: true };
  const idx = Math.floor(sorted.length * DEFAULT_LOSS_TOLERANCE);
  const raw = sorted[Math.min(idx, sorted.length - 1)];
  const depth = Math.max(MIN_USEFUL_DEPTH, raw);
  return {
    depth,
    kept: sorted.filter((d) => d >= depth).length,
    total: sorted.length,
    atFloor: depth > raw,
  };
}

/** Donors retained at a given depth. */
export function retentionAt(depths: number[], depth: number): { kept: number; total: number } {
  return { kept: depths.filter((d) => d >= depth).length, total: depths.length };
}

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/**
 * The largest value a metric can take at depth D, reached when every sampled
 * sequence lands in its own clone.
 *
 * This matters more than it looks. At D = 10 the reference study's donors sit
 * at 99.8% of ln(10) in both groups, so the metric has no room left to
 * separate anything and a large p-value there says "not resolvable at this
 * depth", not "the groups are alike".
 */
export function metricCeiling(metricKey: string, depth: number): number | null {
  switch (metricKey) {
    case 'shannon':
      return Math.log(depth);
    case 'simpson':
      return 1 - 1 / depth;
    default:
      return null;
  }
}

/** Fraction of the ceiling a value sits at, or null when there is no ceiling. */
export function ceilingFraction(metricKey: string, depth: number, value: number): number | null {
  const c = metricCeiling(metricKey, depth);
  if (c === null || c <= 0) return null;
  return value / c;
}

/**
 * Chao1 has no fixed ceiling but degenerates just as badly: at small D almost
 * every clone is a singleton, so f1 approaches D, f2 approaches 0, and the
 * estimator is driven by the depth rather than by richness.
 */
export const CHAO1_DEGENERATE_BELOW = 50;

// ---------------------------------------------------------------------------
// Rarefaction
// ---------------------------------------------------------------------------

const NUMERIC_KEYS: (keyof DiversityMetrics)[] = [
  'shannonEntropy', 'simpsonIndex', 'd50', 'chao1', 'giniIndex',
  'uniqueClones', 'totalSequences', 'clonedSequences', 'meanCloneSize',
  'meanSHM', 'medianSHM', 'productivePercent',
  'expandedCloneFraction', 'top1CloneFraction', 'top10CloneFraction',
];

/**
 * Metrics for one donor at depth D, averaged over `replicates` independent
 * draws. Returns null when the donor cannot reach D.
 *
 * The average is the MEAN, not the median, and that is not a stylistic choice.
 * Shannon is capped at ln(D) and for most donors more than half the draws land
 * exactly on that cap, so a median snaps to the ceiling and produces a wall of
 * ties. The rank test is then decided by the handful of donors that fall below
 * it, which are disproportionately the shallow ones, and the depth signal the
 * whole procedure exists to remove walks straight back in. Measured on the
 * reference study: mean gives p = 0.46 at D = 10 and p = 0.26 at D = 20, median
 * gives 0.021 and 0.032, flipping the conclusion across the 0.05 line.
 */
export function rarefyDonor(
  seqs: SequenceData[],
  depth: number,
  donorKey: string,
  replicates: number = DEFAULT_REPLICATES,
  seed: number = DEFAULT_SEED
): DiversityMetrics | null {
  const pool = cloneAssigned(seqs);
  if (pool.length < depth || depth < MIN_USEFUL_DEPTH) return null;

  const rng = mulberry32(seed ^ stableHash(donorKey));
  const acc: Record<string, number> = {};
  for (const k of NUMERIC_KEYS) acc[k as string] = 0;

  for (let r = 0; r < replicates; r++) {
    const draw = sampleWithoutReplacement(pool, depth, rng);
    const m = computeDiversity(draw);
    for (const k of NUMERIC_KEYS) acc[k as string] += m[k] as number;
  }

  const out: Record<string, number> = {};
  for (const k of NUMERIC_KEYS) out[k as string] = acc[k as string] / replicates;
  return out as unknown as DiversityMetrics;
}

export interface RarefactionSettings {
  enabled: boolean;
  depth: number;
  replicates: number;
  seed: number;
}

export const DEFAULT_RAREFACTION: RarefactionSettings = {
  enabled: false,
  depth: MIN_USEFUL_DEPTH,
  replicates: DEFAULT_REPLICATES,
  seed: DEFAULT_SEED,
};

/** Human-readable provenance line for exports and figure captions. */
export function describeRarefaction(s: RarefactionSettings): string {
  if (!s.enabled) return 'Depth normalization: off';
  return `Depth normalization: on | depth=${s.depth} | replicates=${s.replicates} | seed=${s.seed} | mean over draws`;
}
