/**
 * Cross-cohort shared-clone detection.
 *
 * Pipeline's main clonality step (Change-O DefineClones) runs *per cohort*, so
 * clone_ids in different cohorts are not comparable. To detect lineages that
 * span multiple treatment groups (e.g. an IgG-mouse clone reappearing in an
 * LCP mouse), we re-cluster on top of the per-cohort clone assignments using
 * the standard rule:
 *
 *   bucket by (V_family, J_family, CDR3 length), then union-find by CDR3
 *   amino-acid Hamming distance ≤ ceil(length × threshold).
 *
 * Operates on already-clustered per-cohort clones (sequences are grouped by
 * their cohort-local clone_id first, then a single representative CDR3 per
 * clone is fed into the cross-cohort clustering). This keeps performance
 * tractable on 60k+ sequences.
 */

import type { CohortResults, FileGroup, SequenceData } from '../stores/app';

export interface CohortClone {
  cohortName: string;
  cohortType: string;
  cohortColor: string;
  cloneId: number;
  /** Representative CDR3 amino-acid (longest non-null in the clone). */
  cdr3_aa: string;
  v_gene: string;
  j_gene: string;
  v_family: string;
  j_family: string;
  /** Total sequences in the (cohort × clone). */
  sequence_count: number;
  /** Distinct samples (mice) in this cohort that contain ≥1 sequence of the clone. */
  sample_count: number;
  /** Sample names contributing sequences. */
  samples: string[];
}

export interface CrossCohortCluster {
  /** Synthetic ID assigned at clustering time. */
  id: number;
  v_family: string;
  j_family: string;
  cdr3_length: number;
  /** Cohort names this cluster spans. */
  cohorts: string[];
  /** Sequence count summed across all member clones in the cluster. */
  total_sequences: number;
  /** Distinct unique CDR3 strings across members. */
  unique_cdr3_count: number;
  /** Per-cohort sequence-count breakdown (cohortName → total seqs in cluster). */
  cohort_breakdown: Record<string, { sequences: number; samples: Set<string>; topCdr3: string }>;
  members: CohortClone[];
}

export interface CrossCohortOptions {
  /** Hamming-distance threshold as a fraction of CDR3 length. Default 0.10. */
  hammingFraction?: number;
  /** Minimum clone size in any single cohort to be considered. Default 1. */
  minCloneSize?: number;
}

function vFamily(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/^(IG[HKL]V\d+)/);
  return m ? m[1] : null;
}

function jFamily(j: string | null): string | null {
  if (!j) return null;
  const m = j.match(/^(IGHJ\d+)/);
  return m ? m[1] : null;
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** Roll up per-cohort sequences into one entry per (cohort × clone_id). */
function buildCohortClones(
  cohort: CohortResults,
  cohortColor: string,
  minCloneSize: number
): CohortClone[] {
  // Group sequences by clone_id within this cohort
  const byClone = new Map<number, { seqs: SequenceData[]; samples: Set<string> }>();

  for (const fg of cohort.fileGroups) {
    const sample = fg.filename;
    for (const seq of fg.sequences) {
      if (seq.clone_id == null) continue;
      let g = byClone.get(seq.clone_id);
      if (!g) { g = { seqs: [], samples: new Set() }; byClone.set(seq.clone_id, g); }
      g.seqs.push(seq);
      g.samples.add(sample);
    }
  }

  const out: CohortClone[] = [];
  for (const [cloneId, g] of byClone) {
    if (g.seqs.length < minCloneSize) continue;
    // Representative: longest CDR3 amino-acid; first non-null V/J
    let repCdr3 = '';
    let repV = '';
    let repJ = '';
    for (const s of g.seqs) {
      if (s.cdr3_peptide && s.cdr3_peptide.length > repCdr3.length) repCdr3 = s.cdr3_peptide;
      if (!repV && s.v_gene) repV = s.v_gene;
      if (!repJ && s.j_gene) repJ = s.j_gene;
    }
    if (!repCdr3 || !repV || !repJ) continue;
    const vFam = vFamily(repV);
    const jFam = jFamily(repJ);
    if (!vFam || !jFam) continue;

    out.push({
      cohortName: cohort.cohortName || cohort.cohortType,
      cohortType: cohort.cohortType,
      cohortColor,
      cloneId,
      cdr3_aa: repCdr3,
      v_gene: repV,
      j_gene: repJ,
      v_family: vFam,
      j_family: jFam,
      sequence_count: g.seqs.length,
      sample_count: g.samples.size,
      samples: [...g.samples],
    });
  }
  return out;
}

/**
 * Detect cross-cohort shared lineages.
 *
 * Returns clusters spanning ≥2 cohorts, sorted by total sequence count (desc).
 */
export function findCrossCohortClones(
  cohorts: { cohort: CohortResults; color: string }[],
  options: CrossCohortOptions = {}
): CrossCohortCluster[] {
  const hammingFraction = options.hammingFraction ?? 0.10;
  const minCloneSize = options.minCloneSize ?? 1;

  // 1. Build cohort × clone summaries
  const allClones: CohortClone[] = [];
  for (const { cohort, color } of cohorts) {
    allClones.push(...buildCohortClones(cohort, color, minCloneSize));
  }

  // 2. Bucket by (v_family, j_family, cdr3_length)
  const buckets = new Map<string, CohortClone[]>();
  for (const cl of allClones) {
    const key = `${cl.v_family}|${cl.j_family}|${cl.cdr3_aa.length}`;
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    list.push(cl);
  }

  // 3. Union-find cluster within each bucket by CDR3 Hamming
  const clusters: CrossCohortCluster[] = [];
  let clusterIdSeq = 0;

  for (const [, members] of buckets) {
    if (members.length < 2) continue;

    const len = members[0].cdr3_aa.length;
    const threshold = Math.max(1, Math.ceil(len * hammingFraction));

    const parent = new Array<number>(members.length);
    for (let i = 0; i < members.length; i++) parent[i] = i;
    const find = (i: number): number => {
      let r = i;
      while (parent[r] !== r) r = parent[r];
      // path compression
      let k = i;
      while (parent[k] !== r) { const next = parent[k]; parent[k] = r; k = next; }
      return r;
    };

    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (hamming(members[i].cdr3_aa, members[j].cdr3_aa) <= threshold) {
          const ri = find(i);
          const rj = find(j);
          if (ri !== rj) parent[ri] = rj;
        }
      }
    }

    // Collect groups
    const groups = new Map<number, CohortClone[]>();
    for (let i = 0; i < members.length; i++) {
      const r = find(i);
      let g = groups.get(r);
      if (!g) { g = []; groups.set(r, g); }
      g.push(members[i]);
    }

    for (const [, group] of groups) {
      const cohortsInGroup = new Set(group.map(m => m.cohortName));
      if (cohortsInGroup.size < 2) continue;

      // Aggregate per-cohort
      const breakdown: CrossCohortCluster['cohort_breakdown'] = {};
      let totalSeqs = 0;
      const uniqueCdr3s = new Set<string>();
      for (const m of group) {
        totalSeqs += m.sequence_count;
        uniqueCdr3s.add(m.cdr3_aa);
        let b = breakdown[m.cohortName];
        if (!b) {
          b = { sequences: 0, samples: new Set<string>(), topCdr3: m.cdr3_aa };
          breakdown[m.cohortName] = b;
        }
        b.sequences += m.sequence_count;
        for (const s of m.samples) b.samples.add(s);
        // Track the largest member's CDR3 as the cohort's "top"
        const cur = group
          .filter(g => g.cohortName === m.cohortName)
          .reduce((acc, g) => g.sequence_count > acc.sequence_count ? g : acc, m);
        b.topCdr3 = cur.cdr3_aa;
      }

      clusters.push({
        id: ++clusterIdSeq,
        v_family: group[0].v_family,
        j_family: group[0].j_family,
        cdr3_length: len,
        cohorts: [...cohortsInGroup].sort(),
        total_sequences: totalSeqs,
        unique_cdr3_count: uniqueCdr3s.size,
        cohort_breakdown: breakdown,
        members: [...group].sort((a, b) => b.sequence_count - a.sequence_count),
      });
    }
  }

  clusters.sort((a, b) => b.total_sequences - a.total_sequences);
  return clusters;
}
