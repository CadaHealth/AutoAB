/**
 * Non-parametric statistical tests for group comparison.
 * Pure TypeScript, no external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WilcoxonResult {
  /** Mann-Whitney U statistic (smaller of U1, U2) */
  U: number;
  /** Two-sided p-value */
  p: number;
  /** Rank-biserial effect size r: −1..+1.  r = 1 − 2U/(n1·n2) */
  r: number;
  /** Sample sizes */
  n1: number;
  n2: number;
  /** Whether the test is valid (both n >= 3) */
  valid: boolean;
}

export interface ComparisonResult {
  timepointLabel: string;
  metric: string;
  diseaseValues: number[];
  controlValues: number[];
  test: WilcoxonResult;
}

// ---------------------------------------------------------------------------
// Wilcoxon rank-sum (Mann-Whitney U) test
// ---------------------------------------------------------------------------

/**
 * Assign ranks to combined samples with midrank ties.
 * Returns ranks in the same order as the input.
 */
function assignRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    // Find all tied values
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    // Midrank for tied group: average of ranks i+1 .. j
    const midrank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = midrank;
    }
    i = j;
  }
  return ranks;
}

/**
 * Normal approximation CDF (for large samples).
 * Uses Abramowitz & Stegun approximation of the standard normal CDF.
 */
function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Exact Mann-Whitney U p-value for small samples.
 * Enumerates all possible rank sums for sample of size n1 from n1+n2 ranks.
 * Returns two-sided p-value.
 */
function exactMWU(U: number, n1: number, n2: number): number {
  const N = n1 + n2;
  const total = binomial(N, n1);

  // Count arrangements where U_1 <= observed U or U_1 >= n1*n2 - U
  // U_1 = R1 - n1*(n1+1)/2 where R1 = sum of ranks for group 1
  // We enumerate all possible rank sums R1 for n1 items from 1..N
  let countExtreme = 0;
  const target = U;

  // Dynamic programming: count(k, r) = number of ways to choose k ranks
  // from ranks 1..N with sum r
  // R1 ranges from n1*(n1+1)/2 to n1*n2 + n1*(n1+1)/2
  const minR = (n1 * (n1 + 1)) / 2;

  // Use DP: ways[k][r] but flatten to 1D per step
  // Max rank sum = n1*N - n1*(n1-1)/2 = sum of top n1 ranks
  const maxR = (n1 * (2 * N - n1 + 1)) / 2;
  const range = maxR - minR;

  // For very large ranges, fall back to normal approximation
  if (range > 10000 || total > 1e12) {
    return normalApproxMWU(U, n1, n2);
  }

  // DP: dp[r - minR] = number of ways to pick exactly n1 items from 1..N with rank sum r
  // Build incrementally: add ranks 1, 2, ..., N one at a time
  // dp_prev[j][s] = ways to pick j items from ranks 1..i with sum s
  // We only need the current number-of-items layer

  // Simpler approach for small N: enumerate subsets
  // For N <= 20 this is fine via DP
  const dp: number[][] = Array.from({ length: n1 + 1 }, () => new Array(range + 1).fill(0));
  dp[0][0] = 1; // 0 items chosen, sum = minR → offset 0

  for (let rank = 1; rank <= N; rank++) {
    // Iterate backwards to avoid double-counting
    for (let k = Math.min(n1, rank); k >= 1; k--) {
      for (let s = range; s >= rank; s--) {
        dp[k][s] += dp[k - 1][s - rank];
      }
    }
  }

  // Now dp[n1][s] = number of subsets of size n1 with rank sum = minR + s
  for (let s = 0; s <= range; s++) {
    const U1 = (minR + s) - minR; // = s, since U1 = R1 - n1*(n1+1)/2
    if (U1 <= target || U1 >= n1 * n2 - target) {
      countExtreme += dp[n1][s];
    }
  }

  return Math.min(1, countExtreme / total);
}

/** Binomial coefficient C(n, k) */
function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  if (k > n - k) k = n - k;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/**
 * Normal approximation for Mann-Whitney U (with continuity correction).
 */
function normalApproxMWU(U: number, n1: number, n2: number): number {
  const mean = (n1 * n2) / 2;
  const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  if (sd === 0) return 1;
  // Continuity correction
  const z = (Math.abs(U - mean) - 0.5) / sd;
  return 2 * (1 - normalCDF(z));
}

/**
 * Perform two-sided Wilcoxon rank-sum (Mann-Whitney U) test.
 *
 * @param group1 - Values for group 1 (e.g. Disease)
 * @param group2 - Values for group 2 (e.g. Control)
 * @returns WilcoxonResult with U, p, r, n1, n2, valid
 */
export function wilcoxonRankSum(group1: number[], group2: number[]): WilcoxonResult {
  const n1 = group1.length;
  const n2 = group2.length;

  // Need at least 3 per group for meaningful test
  if (n1 < 3 || n2 < 3) {
    return { U: 0, p: NaN, r: NaN, n1, n2, valid: false };
  }

  // Combine and rank
  const combined = [...group1, ...group2];
  const ranks = assignRanks(combined);

  // Rank sum for group 1
  const R1 = ranks.slice(0, n1).reduce((a, b) => a + b, 0);
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);

  // p-value: exact for small samples, normal approx for large
  const N = n1 + n2;
  let p: number;
  if (N <= 20) {
    p = exactMWU(U, n1, n2);
  } else {
    p = normalApproxMWU(U, n1, n2);
  }

  // Rank-biserial effect size: r = 1 - 2U/(n1*n2)
  const r = 1 - (2 * U) / (n1 * n2);

  return { U, p: Math.min(1, p), r, n1, n2, valid: true };
}

// ---------------------------------------------------------------------------
// Multiple testing correction: Benjamini-Hochberg FDR
// ---------------------------------------------------------------------------

/**
 * Apply Benjamini-Hochberg FDR correction to an array of p-values.
 * Returns adjusted p-values in the same order as input.
 */
export function benjaminiHochberg(pValues: number[]): number[] {
  const n = pValues.length;
  if (n === 0) return [];

  // Sort indices by p-value
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);

  const adjusted = new Array<number>(n);
  let cumMin = 1;

  // Walk from largest to smallest p-value
  for (let k = n - 1; k >= 0; k--) {
    const rank = k + 1;
    const corrected = (indexed[k].p * n) / rank;
    cumMin = Math.min(cumMin, corrected);
    adjusted[indexed[k].i] = Math.min(1, cumMin);
  }

  return adjusted;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format p-value for display: "p < 0.001", "p = 0.045", "n.s." etc. */
export function formatPValue(p: number): string {
  if (isNaN(p)) return 'n too small';
  if (p < 0.001) return 'p < 0.001';
  if (p < 0.01) return `p = ${p.toFixed(3)}`;
  if (p < 0.05) return `p = ${p.toFixed(3)}`;
  return `p = ${p.toFixed(2)}`;
}

/** Return significance stars: *** < 0.001, ** < 0.01, * < 0.05, ns */
export function significanceStars(p: number): string {
  if (isNaN(p)) return '';
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return 'ns';
}
