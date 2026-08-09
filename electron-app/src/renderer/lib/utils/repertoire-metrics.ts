/**
 * Repertoire diversity and clonal metrics computed from SequenceData[].
 * All functions are pure TypeScript, no backend dependencies.
 */

import type { SequenceData, StudyDesign, StudyGroup, StudyTimepoint } from '../stores/app';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiversityMetrics {
  shannonEntropy: number;
  simpsonIndex: number;
  d50: number;
  chao1: number;
  giniIndex: number;
  uniqueClones: number;
  totalSequences: number;
  meanCloneSize: number;
  meanSHM: number;
  medianSHM: number;
  productivePercent: number;
  /** Fraction of sequences belonging to expanded clones (clones with ≥2 members), 0-1. Shulman 2022 Fig 2B. */
  expandedCloneFraction: number;
  /** Fraction of repertoire in the single largest clone, 0-1. */
  top1CloneFraction: number;
  /** Fraction of repertoire in the top-10 largest clones, 0-1. */
  top10CloneFraction: number;
}

export interface VGeneFamilyFreq {
  family: string;
  count: number;
  frequency: number; // 0-1
}

export interface RankAbundancePoint {
  rank: number;
  size: number;
}

export interface IsotypeFreq {
  isotype: string;   // IgM, IgD, IgG, IgA, IgE
  count: number;
  frequency: number; // 0-1
}

export interface GroupTimepointMetrics {
  groupId: string;
  groupName: string;
  groupColor: string;
  timepointId: string;
  timepointLabel: string;
  diversity: DiversityMetrics;
  vGeneFreqs: VGeneFamilyFreq[];
  rankAbundance: RankAbundancePoint[];
  isotypeFreqs: IsotypeFreq[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shade a hex color by timepoint order: latest (highest order) = darkest, earliest = lightest.
 * @param baseHex - Base color (e.g. group.color)
 * @param order - Timepoint order (0 = earliest)
 * @param maxOrder - Max order in the group
 */
function shadeColorForTimepoint(baseHex: string, order: number, maxOrder: number): string {
  if (maxOrder <= 0) return baseHex;
  const darknessFactor = (order + 1) / (maxOrder + 1); // 0..1, 1 = latest
  const hex = baseHex.replace(/^#/, '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const lightenAmount = (1 - darknessFactor) * 0.35;
  const newL = Math.min(0.92, Math.max(0.2, l + lightenAmount));
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  let nr: number, ng: number, nb: number;
  if (s === 0) {
    nr = ng = nb = newL;
  } else {
    const q = newL < 0.5 ? newL * (1 + s) : newL + s - newL * s;
    const p = 2 * newL - q;
    nr = hue2rgb(p, q, h + 1/3);
    ng = hue2rgb(p, q, h);
    nb = hue2rgb(p, q, h - 1/3);
  }
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

/** Build a map of clone_id → count of sequences in that clone. */
function cloneSizeMap(seqs: SequenceData[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of seqs) {
    const cid = s.clone_id ?? -1;
    m.set(cid, (m.get(cid) ?? 0) + 1);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Core metric functions
// ---------------------------------------------------------------------------

/** Shannon entropy: H = -sum(p_i * ln(p_i)) */
export function shannonEntropy(sizes: number[]): number {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const s of sizes) {
    if (s <= 0) continue;
    const p = s / total;
    h -= p * Math.log(p);
  }
  return h;
}

/** Simpson index: D = 1 - sum(p_i^2) */
export function simpsonIndex(sizes: number[]): number {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let sumP2 = 0;
  for (const s of sizes) {
    const p = s / total;
    sumP2 += p * p;
  }
  return 1 - sumP2;
}

/** D50: number of largest clones needed to cover 50% of sequences */
export function d50(sizes: number[]): number {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const sorted = [...sizes].sort((a, b) => b - a);
  const half = total * 0.5;
  let cumulative = 0;
  let count = 0;
  for (const s of sorted) {
    cumulative += s;
    count++;
    if (cumulative >= half) break;
  }
  return count;
}

/**
 * Chao1 richness estimator: S_obs + f1*(f1-1) / (2*(f2+1))
 * where f1 = # singletons, f2 = # doubletons
 */
export function chao1(sizes: number[]): number {
  if (sizes.length === 0) return 0;
  const sObs = sizes.length;
  let f1 = 0; // singletons
  let f2 = 0; // doubletons
  for (const s of sizes) {
    if (s === 1) f1++;
    else if (s === 2) f2++;
  }
  if (f2 === 0) {
    // Bias-corrected form when no doubletons
    return sObs + (f1 * (f1 - 1)) / 2;
  }
  return sObs + (f1 * f1) / (2 * f2);
}

/**
 * Gini index of clonal inequality: 0 = perfectly even, 1 = one clone dominates.
 * G = (2 * sum(i * x_i)) / (n * sum(x_i)) - (n+1)/n
 */
export function giniIndex(sizes: number[]): number {
  if (sizes.length <= 1) return 0;
  const sorted = [...sizes].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let sumWeighted = 0;
  for (let i = 0; i < n; i++) {
    sumWeighted += (i + 1) * sorted[i];
  }
  return (2 * sumWeighted) / (n * total) - (n + 1) / n;
}

/** Mean SHM count across all sequences with non-null somatic_mutations. */
export function meanSHM(seqs: SequenceData[]): number {
  const vals = seqs.filter(s => s.somatic_mutations != null).map(s => s.somatic_mutations!);
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Median SHM count. */
export function medianSHM(seqs: SequenceData[]): number {
  const vals = seqs.filter(s => s.somatic_mutations != null).map(s => s.somatic_mutations!).sort((a, b) => a - b);
  if (vals.length === 0) return 0;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 !== 0 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** Compute all diversity metrics from a list of sequences. */
export function computeDiversity(seqs: SequenceData[]): DiversityMetrics {
  const csm = cloneSizeMap(seqs);
  const sizes = Array.from(csm.values());
  const uniqueClones = sizes.length;
  const totalSequences = seqs.length;
  const meanCloneSize = uniqueClones > 0 ? totalSequences / uniqueClones : 0;
  const productiveCount = seqs.filter(s => s.productive !== false).length;

  // Clonal-expansion metrics (Shulman 2022 Fig 2B-style)
  const expandedSeqs = sizes.filter(s => s >= 2).reduce((a, b) => a + b, 0);
  const expandedCloneFraction = totalSequences > 0 ? expandedSeqs / totalSequences : 0;
  const sortedDesc = [...sizes].sort((a, b) => b - a);
  const top1CloneFraction = totalSequences > 0 ? (sortedDesc[0] ?? 0) / totalSequences : 0;
  const top10Sum = sortedDesc.slice(0, 10).reduce((a, b) => a + b, 0);
  const top10CloneFraction = totalSequences > 0 ? top10Sum / totalSequences : 0;

  return {
    shannonEntropy: shannonEntropy(sizes),
    simpsonIndex: simpsonIndex(sizes),
    d50: d50(sizes),
    chao1: chao1(sizes),
    giniIndex: giniIndex(sizes),
    uniqueClones,
    totalSequences,
    meanCloneSize,
    meanSHM: meanSHM(seqs),
    medianSHM: medianSHM(seqs),
    productivePercent: totalSequences > 0 ? (productiveCount / totalSequences) * 100 : 0,
    expandedCloneFraction,
    top1CloneFraction,
    top10CloneFraction,
  };
}

// ---------------------------------------------------------------------------
// V-Gene family frequencies
// ---------------------------------------------------------------------------

/** Extract family from v_call, e.g. "IGHV3-73*01" → "IGHV3" */
function extractVGeneFamily(vCall: string | null): string | null {
  if (!vCall) return null;
  // Match pattern like IGHV3, IGKV1, IGLV2 etc.
  const m = vCall.match(/^(IG[HKL]V\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

/** Compute V-gene family frequencies from sequences. */
export function computeVGeneFrequencies(seqs: SequenceData[]): VGeneFamilyFreq[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const s of seqs) {
    const fam = extractVGeneFamily(s.v_gene);
    if (fam) {
      counts.set(fam, (counts.get(fam) ?? 0) + 1);
      total++;
    }
  }
  const result: VGeneFamilyFreq[] = [];
  for (const [family, count] of counts.entries()) {
    result.push({ family, count, frequency: total > 0 ? count / total : 0 });
  }
  // Sort descending by frequency
  result.sort((a, b) => b.frequency - a.frequency);
  return result;
}

// ---------------------------------------------------------------------------
// Isotype (Ig class) frequencies from c_call
// ---------------------------------------------------------------------------

/** Map c_call (e.g. IGHM*01) to Ig class (IgM, IgG, etc.) */
export function cCallToIgClass(cCall: string | null | undefined): string | null {
  if (!cCall || typeof cCall !== 'string') return null;
  const upper = cCall.toUpperCase();
  if (upper.startsWith('IGHM')) return 'IgM';
  if (upper.startsWith('IGHD')) return 'IgD';
  if (upper.startsWith('IGHG')) return 'IgG';
  if (upper.startsWith('IGHA')) return 'IgA';
  if (upper.startsWith('IGHE')) return 'IgE';
  return null;
}

/** Compute isotype frequencies for heavy-chain sequences. */
export function computeIsotypeFrequencies(seqs: SequenceData[]): IsotypeFreq[] {
  // Only heavy chain sequences have Ig class (IgG, IgM, etc.)
  const heavySeqs = seqs.filter(s => s.isotype === 'Heavy' || (s.v_gene && !s.v_gene.includes('L') && !s.v_gene.includes('K')));
  const counts = new Map<string, number>();
  let total = 0;
  for (const s of heavySeqs) {
    const ig = cCallToIgClass(s.c_call);
    if (ig) {
      counts.set(ig, (counts.get(ig) ?? 0) + 1);
      total++;
    }
  }
  const order = ['IgM', 'IgD', 'IgG', 'IgA', 'IgE'];
  const result: IsotypeFreq[] = [];
  for (const iso of order) {
    const count = counts.get(iso) ?? 0;
    result.push({ isotype: iso, count, frequency: total > 0 ? count / total : 0 });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rank-abundance (clone sizes sorted descending)
// ---------------------------------------------------------------------------

/** Compute rank-abundance data: sorted clone sizes. */
export function computeRankAbundance(seqs: SequenceData[]): RankAbundancePoint[] {
  const csm = cloneSizeMap(seqs);
  const sizes = Array.from(csm.values()).sort((a, b) => b - a);
  return sizes.map((size, i) => ({ rank: i + 1, size }));
}

// ---------------------------------------------------------------------------
// Aggregate: compute metrics for each group+timepoint from StudyDesign
// ---------------------------------------------------------------------------

/** Filter sequences belonging to a set of filenames. */
function filterSequencesByFiles(
  allSequences: SequenceData[],
  files: string[],
  fileGroups: { filename: string; sequences: SequenceData[] }[]
): SequenceData[] {
  // Use fileGroups for quick lookup if available
  const fileSet = new Set(files);
  const result: SequenceData[] = [];
  for (const fg of fileGroups) {
    if (fileSet.has(fg.filename)) {
      result.push(...fg.sequences);
    }
  }
  // Fallback: if fileGroups didn't cover all, also try the file field on sequences
  if (result.length === 0 && allSequences.length > 0) {
    for (const s of allSequences) {
      if (s.file && fileSet.has(s.file)) {
        result.push(s);
      }
    }
  }
  return result;
}

/**
 * Compute metrics for every group+timepoint in the study design.
 */
export function computeAllMetrics(
  design: StudyDesign,
  allSequences: SequenceData[],
  fileGroups: { filename: string; sequences: SequenceData[] }[]
): GroupTimepointMetrics[] {
  const results: GroupTimepointMetrics[] = [];

  for (const group of design.groups) {
    const maxOrder = Math.max(0, ...group.timepoints.map(tp => tp.order));
    for (const tp of group.timepoints) {
      if (tp.files.length === 0) continue;
      const seqs = filterSequencesByFiles(allSequences, tp.files, fileGroups);
      const shadedColor = shadeColorForTimepoint(group.color, tp.order, maxOrder);
      results.push({
        groupId: group.id,
        groupName: group.name,
        groupColor: shadedColor,
        timepointId: tp.id,
        timepointLabel: tp.label,
        diversity: computeDiversity(seqs),
        vGeneFreqs: computeVGeneFrequencies(seqs),
        rankAbundance: computeRankAbundance(seqs),
        isotypeFreqs: computeIsotypeFrequencies(seqs)
      });
    }
  }

  return results;
}

/**
 * Fallback: compute per-file metrics when no study design is defined.
 */
export const FILE_COLORS = [
  '#0066CC', '#E85D04', '#2D9F3F', '#9B59B6',
  '#E74C3C', '#00ACC1', '#F39C12', '#7F8C8D',
  '#3498DB', '#E67E22', '#27AE60', '#8E44AD'
];

export function computePerFileMetrics(
  fileGroups: { filename: string; sequences: SequenceData[] }[]
): GroupTimepointMetrics[] {
  return fileGroups.map((fg, i) => ({
    groupId: `file-${i}`,
    groupName: fg.filename,
    groupColor: FILE_COLORS[i % FILE_COLORS.length],
    timepointId: `file-${i}`,
    timepointLabel: fg.filename,
    diversity: computeDiversity(fg.sequences),
    vGeneFreqs: computeVGeneFrequencies(fg.sequences),
    rankAbundance: computeRankAbundance(fg.sequences),
    isotypeFreqs: computeIsotypeFrequencies(fg.sequences)
  }));
}

/**
 * Compute metrics per sample (file) within the selected groups and timepoints.
 * Returns one GroupTimepointMetrics per file for side-by-side comparison.
 */
export function computePerSampleMetrics(
  design: StudyDesign | null,
  fileGroups: { filename: string; sequences: SequenceData[] }[],
  enabledGroupIds: Set<string>,
  enabledTimepointLabels: Set<string>
): GroupTimepointMetrics[] {
  const results: GroupTimepointMetrics[] = [];
  const fileMap = new Map<string, { filename: string; sequences: SequenceData[] }>();
  for (const fg of fileGroups) {
    fileMap.set(fg.filename, fg);
  }

  if (design && design.groups.length > 0) {
    // With study design: expand each group+timepoint into per-file metrics
    for (const group of design.groups) {
      if (!enabledGroupIds.has(group.id)) continue;
      const maxOrder = Math.max(0, ...group.timepoints.map(tp => tp.order));
      for (const tp of group.timepoints) {
        if (!enabledTimepointLabels.has(tp.label)) continue;
        const shadedColor = shadeColorForTimepoint(group.color, tp.order, maxOrder);
        for (const fileId of tp.files) {
          const fg = fileMap.get(fileId);
          if (!fg || fg.sequences.length === 0) continue;
          results.push({
            groupId: group.id,
            groupName: fg.filename,
            groupColor: shadedColor,
            timepointId: tp.id,
            timepointLabel: tp.label,
            diversity: computeDiversity(fg.sequences),
            vGeneFreqs: computeVGeneFrequencies(fg.sequences),
            rankAbundance: computeRankAbundance(fg.sequences),
            isotypeFreqs: computeIsotypeFrequencies(fg.sequences)
          });
        }
      }
    }
  } else {
    // No study design: one metric per file, filter by enabled groups/timepoints
    for (let i = 0; i < fileGroups.length; i++) {
      const fg = fileGroups[i];
      const groupId = `file-${i}`;
      const timepointLabel = fg.filename;
      if (!enabledGroupIds.has(groupId) || !enabledTimepointLabels.has(timepointLabel)) continue;
      results.push({
        groupId,
        groupName: fg.filename,
        groupColor: FILE_COLORS[i % FILE_COLORS.length],
        timepointId: groupId,
        timepointLabel,
        diversity: computeDiversity(fg.sequences),
        vGeneFreqs: computeVGeneFrequencies(fg.sequences),
        rankAbundance: computeRankAbundance(fg.sequences),
        isotypeFreqs: computeIsotypeFrequencies(fg.sequences)
      });
    }
  }

  return results;
}

// ===========================================================================
// Longitudinal Analysis (across timepoints within a group)
// ===========================================================================

/** A clone tracked across timepoints within a group. */
export interface TrackedClone {
  cloneId: number;
  lineageId?: number;      // Cross-timepoint lineage ID (when available)
  timepointSizes: { timepointLabel: string; timepointOrder: number; size: number }[];
  totalSize: number;
  persistent: boolean;    // present in ALL timepoints
  expanding: boolean;     // size increases from first to last
  contracting: boolean;   // size decreases from first to last
  meanSHM: number[];      // mean SHM per timepoint (for SHM accumulation)
}

/** Per-group longitudinal summary. */
export interface LongitudinalGroupData {
  groupId: string;
  groupName: string;
  groupColor: string;
  timepointLabels: string[];
  timepointOrders: number[];
  // Diversity trajectory: diversity metrics at each timepoint
  diversityTrajectory: DiversityMetrics[];
  // Clonal tracking
  trackedClones: TrackedClone[];
  persistentCloneCount: number;
  // SHM accumulation per timepoint (mean across all sequences at that timepoint)
  shmTrajectory: number[];
  // Isotype trajectory per timepoint
  isotypeTrajectory: IsotypeFreq[][];
}

/**
 * Compute longitudinal analysis for all groups in the study design.
 * Only meaningful when a group has >=2 timepoints.
 */
export function computeLongitudinalAnalysis(
  design: StudyDesign,
  allSequences: SequenceData[],
  fileGroups: { filename: string; sequences: SequenceData[] }[]
): LongitudinalGroupData[] {
  const results: LongitudinalGroupData[] = [];

  for (const group of design.groups) {
    const sortedTps = [...group.timepoints].sort((a, b) => a.order - b.order);
    if (sortedTps.length < 2) continue;

    const timepointLabels = sortedTps.map(tp => tp.label);
    const timepointOrders = sortedTps.map(tp => tp.order);

    // Gather sequences per timepoint
    const seqsPerTp: SequenceData[][] = sortedTps.map(tp =>
      filterSequencesByFiles(allSequences, tp.files, fileGroups)
    );

    // Diversity trajectory
    const diversityTrajectory = seqsPerTp.map(seqs => computeDiversity(seqs));

    // SHM trajectory (mean SHM per timepoint)
    const shmTrajectory = seqsPerTp.map(seqs => meanSHM(seqs));

    // Isotype trajectory per timepoint
    const isotypeTrajectory = seqsPerTp.map(seqs => computeIsotypeFrequencies(seqs));

    // Determine if lineage_id is available for cross-timepoint tracking
    const hasLineageIds = seqsPerTp.some(seqs => seqs.some(s => s.lineage_id != null));
    
    // Use lineage_id for cross-timepoint tracking when available, otherwise fall back to clone_id
    // lineage_id groups clones from DIFFERENT timepoints that share V+J+CDR3 similarity
    const trackingKey = hasLineageIds ? 'lineage_id' : 'clone_id';
    
    function getTrackingId(s: SequenceData): number | null {
      if (hasLineageIds && s.lineage_id != null) return s.lineage_id;
      return s.clone_id ?? null;
    }

    // Build tracking_id -> size at each timepoint
    const cloneAtTp: Map<number, number>[] = seqsPerTp.map(seqs => {
      const m = new Map<number, number>();
      for (const s of seqs) {
        const tid = getTrackingId(s);
        if (tid != null) {
          m.set(tid, (m.get(tid) ?? 0) + 1);
        }
      }
      return m;
    });

    // SHM per tracked entity per timepoint (mean)
    const cloneShmAtTp: Map<number, number>[] = seqsPerTp.map(seqs => {
      const shmSums = new Map<number, { sum: number; count: number }>();
      for (const s of seqs) {
        const tid = getTrackingId(s);
        if (tid != null && s.somatic_mutations != null) {
          const entry = shmSums.get(tid) ?? { sum: 0, count: 0 };
          entry.sum += s.somatic_mutations;
          entry.count++;
          shmSums.set(tid, entry);
        }
      }
      const result = new Map<number, number>();
      for (const [cid, { sum, count }] of shmSums) {
        result.set(cid, sum / count);
      }
      return result;
    });

    // Union of all tracking IDs across timepoints
    const allCloneIds = new Set<number>();
    for (const m of cloneAtTp) {
      for (const cid of m.keys()) allCloneIds.add(cid);
    }

    const trackedClones: TrackedClone[] = [];
    for (const cid of allCloneIds) {
      const timepointSizes = sortedTps.map((tp, i) => ({
        timepointLabel: tp.label,
        timepointOrder: tp.order,
        size: cloneAtTp[i].get(cid) ?? 0
      }));
      const nonZeroSizes = timepointSizes.filter(t => t.size > 0);
      const totalSize = timepointSizes.reduce((a, t) => a + t.size, 0);
      const persistent = timepointSizes.every(t => t.size > 0);
      const firstSize = timepointSizes.find(t => t.size > 0)?.size ?? 0;
      const lastIdx = [...timepointSizes].reverse().findIndex(t => t.size > 0);
      const lastSize = lastIdx >= 0 ? timepointSizes[timepointSizes.length - 1 - lastIdx].size : 0;
      const expanding = nonZeroSizes.length >= 2 && lastSize > firstSize;
      const contracting = nonZeroSizes.length >= 2 && lastSize < firstSize;
      const cloneMeanSHM = sortedTps.map((_, i) => cloneShmAtTp[i].get(cid) ?? 0);

      trackedClones.push({
        cloneId: cid,
        ...(hasLineageIds ? { lineageId: cid } : {}),
        timepointSizes,
        totalSize,
        persistent,
        expanding,
        contracting,
        meanSHM: cloneMeanSHM
      });
    }

    // Sort by total size descending
    trackedClones.sort((a, b) => b.totalSize - a.totalSize);

    results.push({
      groupId: group.id,
      groupName: group.name,
      groupColor: group.color,
      timepointLabels,
      timepointOrders,
      diversityTrajectory,
      trackedClones,
      persistentCloneCount: trackedClones.filter(c => c.persistent).length,
      shmTrajectory,
      isotypeTrajectory
    });
  }

  return results;
}
