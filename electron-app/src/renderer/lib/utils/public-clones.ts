/**
 * Public clone analysis and clonal dynamics - computed from existing clonality results.
 * 
 * "Public/shared clones" are clones shared across 2+ patient files within the same
 * timepoint. Since clonality is defined per-timepoint by DefineClones, any clone_id
 * that contains sequences from multiple patient files is "public".
 * 
 * "Clonal dynamics" tracks lineages (lineage_id) or clones across timepoints to
 * identify expanding, contracting, persistent, disappeared, and late-emerging clones.
 */

import type {
  SequenceData,
  FileGroup,
  TimepointMapping,
  PublicCloneResult,
  PublicClonesData,
  VisualizationData
} from '../stores/app';

import { cCallToIgClass } from './repertoire-metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve filename to a unique patient identifier, deduplicating across timepoints. */
function getPatientName(filename: string, timepointMapping: TimepointMapping): string {
  const entry = timepointMapping[filename];
  let name = entry?.originalFile ?? filename;

  if (!entry?.originalFile) {
    const m = name.match(/^T\d+_(.+)$/);
    if (m) name = m[1];
  }

  // Strip timepoint suffix from the base name so the same patient
  // across timepoints resolves to a single ID.
  // e.g. "INCOV002_T1.fasta" with timepoint "T1" → "INCOV002.fasta"
  if (entry?.timepoint) {
    const tp = entry.timepoint;
    const ext = name.match(/(\.[^.]+)$/)?.[1] ?? '';
    const base = ext ? name.slice(0, -ext.length) : name;
    if (base.endsWith(`_${tp}`)) {
      name = base.slice(0, -(tp.length + 1)) + ext;
    }
  }

  return name;
}

/** Get the timepoint label for a file. */
function getTimepoint(filename: string, timepointMapping: TimepointMapping): string {
  return timepointMapping[filename]?.timepoint ?? '';
}

/** Get ordered unique timepoint labels from the mapping. */
export function getTimepointLabels(timepointMapping: TimepointMapping): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of Object.values(timepointMapping)) {
    if (entry.timepoint && !seen.has(entry.timepoint)) {
      seen.add(entry.timepoint);
      labels.push(entry.timepoint);
    }
  }
  return labels.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SeqEntry = {
  seq: SequenceData;
  patient: string;
  timepoint: string;
  filename: string;
};

export interface PublicCloneOptions {
  topN?: number;
}

// ---------------------------------------------------------------------------
// Section 1: Shared Clones (per timepoint)
// ---------------------------------------------------------------------------

/**
 * Compute public clones for a specific timepoint only.
 * Filters fileGroups to files belonging to the selected timepoint.
 * Uses frequency normalization to account for sequencing depth differences.
 */
export function computePublicClonesPerTimepoint(
  fileGroups: FileGroup[],
  timepointMapping: TimepointMapping,
  selectedTimepoint: string,
  options: PublicCloneOptions = {}
): PublicClonesData {
  const { topN = 20 } = options;
  const hasMapping = Object.keys(timepointMapping).length > 0;

  // Filter to only files in the selected timepoint
  const filteredGroups = hasMapping
    ? fileGroups.filter(fg => getTimepoint(fg.filename, timepointMapping) === selectedTimepoint)
    : fileGroups;

  const entries: SeqEntry[] = [];
  const allPatients = new Set<string>();
  const patientSeqTotals = new Map<string, number>();

  for (const fg of filteredGroups) {
    const patient = hasMapping ? getPatientName(fg.filename, timepointMapping) : fg.filename;
    allPatients.add(patient);
    const clonedSeqs = fg.sequences.filter(s => s.clone_id != null);
    patientSeqTotals.set(patient, (patientSeqTotals.get(patient) ?? 0) + clonedSeqs.length);
    for (const seq of clonedSeqs) {
      entries.push({ seq, patient, timepoint: selectedTimepoint, filename: fg.filename });
    }
  }

  // Group by clone_id
  const cloneMap = new Map<number, { seqs: SeqEntry[]; patients: Set<string> }>();
  for (const entry of entries) {
    const cid = entry.seq.clone_id!;
    let group = cloneMap.get(cid);
    if (!group) {
      group = { seqs: [], patients: new Set() };
      cloneMap.set(cid, group);
    }
    group.seqs.push(entry);
    group.patients.add(entry.patient);
  }

  // Public = present in >= 2 patients
  const publicClones: PublicCloneResult[] = [];
  for (const [cloneId, group] of cloneMap) {
    if (group.patients.size < 2) continue;

    const repSeq = group.seqs[0].seq;
    const seqsByPatient: Record<string, string[]> = {};
    const uniqueCdr3s = new Set<string>();
    for (const entry of group.seqs) {
      if (!seqsByPatient[entry.patient]) seqsByPatient[entry.patient] = [];
      seqsByPatient[entry.patient].push(entry.seq.id);
      if (entry.seq.cdr3_peptide) uniqueCdr3s.add(entry.seq.cdr3_peptide);
    }

    publicClones.push({
      id: `clone_${cloneId}`,
      cdr3_aa: repSeq.cdr3_peptide || '',
      cdr3_dna: repSeq.cdr3_dna || '',
      v_gene: repSeq.v_gene?.split('*')[0] || '',
      j_gene: repSeq.j_gene?.split('*')[0] || '',
      sequence_count: group.seqs.length,
      patient_count: group.patients.size,
      patients: [...group.patients].sort(),
      sequences: group.seqs.map(e => e.seq.id),
      sequences_by_patient: seqsByPatient,
      unique_cdr3_variants: uniqueCdr3s.size,
      avg_intra_cluster_similarity: 1.0
    });
  }

  publicClones.sort((a, b) => {
    if (b.patient_count !== a.patient_count) return b.patient_count - a.patient_count;
    return b.sequence_count - a.sequence_count;
  });

  const topX = publicClones.slice(0, topN);
  const sortedPatients = [...allPatients].sort();
  const visualizations = buildVisualizationData(publicClones, sortedPatients, patientSeqTotals);

  return {
    public_clones: publicClones,
    top_x: topX,
    stats: {
      total_public_clones: publicClones.length,
      total_sequences_in_public_clones: publicClones.reduce((s, c) => s + c.sequence_count, 0),
      max_patient_sharing: publicClones.length > 0 ? Math.max(...publicClones.map(c => c.patient_count)) : 0,
      total_patients: allPatients.size,
      clustering_mode: 'clonality',
      similarity_threshold: 1.0,
      top_n_displayed: topX.length
    },
    method: `Per-timepoint clonality (${selectedTimepoint})`,
    visualizations
  };
}

/**
 * Compute public clones across all timepoints (legacy/fallback).
 */
export function computePublicClones(
  fileGroups: FileGroup[],
  timepointMapping: TimepointMapping,
  options: PublicCloneOptions = {}
): PublicClonesData {
  const { topN = 20 } = options;
  const hasMapping = Object.keys(timepointMapping).length > 0;

  const entries: SeqEntry[] = [];
  const allPatients = new Set<string>();
  const patientSeqTotals = new Map<string, number>();

  for (const fg of fileGroups) {
    const patient = hasMapping ? getPatientName(fg.filename, timepointMapping) : fg.filename;
    const tp = hasMapping ? getTimepoint(fg.filename, timepointMapping) : '';
    allPatients.add(patient);
    const clonedSeqs = fg.sequences.filter(s => s.clone_id != null);
    patientSeqTotals.set(patient, (patientSeqTotals.get(patient) ?? 0) + clonedSeqs.length);
    for (const seq of clonedSeqs) {
      entries.push({ seq, patient, timepoint: tp, filename: fg.filename });
    }
  }

  const cloneMap = new Map<number, { seqs: SeqEntry[]; patients: Set<string>; timepoint: string }>();
  for (const entry of entries) {
    const cid = entry.seq.clone_id!;
    let group = cloneMap.get(cid);
    if (!group) {
      group = { seqs: [], patients: new Set(), timepoint: entry.timepoint };
      cloneMap.set(cid, group);
    }
    group.seqs.push(entry);
    group.patients.add(entry.patient);
  }

  const publicClones: PublicCloneResult[] = [];
  for (const [cloneId, group] of cloneMap) {
    if (group.patients.size < 2) continue;
    const repSeq = group.seqs[0].seq;
    const seqsByPatient: Record<string, string[]> = {};
    const uniqueCdr3s = new Set<string>();
    for (const entry of group.seqs) {
      if (!seqsByPatient[entry.patient]) seqsByPatient[entry.patient] = [];
      seqsByPatient[entry.patient].push(entry.seq.id);
      if (entry.seq.cdr3_peptide) uniqueCdr3s.add(entry.seq.cdr3_peptide);
    }
    publicClones.push({
      id: `clone_${cloneId}`,
      cdr3_aa: repSeq.cdr3_peptide || '',
      cdr3_dna: repSeq.cdr3_dna || '',
      v_gene: repSeq.v_gene?.split('*')[0] || '',
      j_gene: repSeq.j_gene?.split('*')[0] || '',
      sequence_count: group.seqs.length,
      patient_count: group.patients.size,
      patients: [...group.patients].sort(),
      sequences: group.seqs.map(e => e.seq.id),
      sequences_by_patient: seqsByPatient,
      unique_cdr3_variants: uniqueCdr3s.size,
      avg_intra_cluster_similarity: 1.0
    });
  }

  publicClones.sort((a, b) => {
    if (b.patient_count !== a.patient_count) return b.patient_count - a.patient_count;
    return b.sequence_count - a.sequence_count;
  });

  const topX = publicClones.slice(0, topN);
  const sortedPatients = [...allPatients].sort();
  const visualizations = buildVisualizationData(publicClones, sortedPatients, patientSeqTotals);

  return {
    public_clones: publicClones,
    top_x: topX,
    stats: {
      total_public_clones: publicClones.length,
      total_sequences_in_public_clones: publicClones.reduce((s, c) => s + c.sequence_count, 0),
      max_patient_sharing: publicClones.length > 0 ? Math.max(...publicClones.map(c => c.patient_count)) : 0,
      total_patients: allPatients.size,
      clustering_mode: 'clonality',
      similarity_threshold: 1.0,
      top_n_displayed: topX.length
    },
    method: 'Derived from per-timepoint clonality (DefineClones)',
    visualizations
  };
}

// ---------------------------------------------------------------------------
// Section 2: Clonal Dynamics (across timepoints)
// ---------------------------------------------------------------------------

export type ClonalStatus = 'persistent' | 'expanding' | 'contracting' | 'disappeared' | 'late_emerging' | 'transient';

export interface TimepointSize {
  label: string;
  /** Normalized frequency (0-1) as proportion of timepoint repertoire */
  frequency: number;
  /** Raw sequence count */
  rawCount: number;
}

export interface ClonalDynamicsEntry {
  cloneLabel: string;
  cloneId: number;
  lineageId?: number;
  cdr3Aa: string;
  vGene: string;
  jGene: string;
  timepointSizes: TimepointSize[];
  totalRawCount: number;
  status: ClonalStatus;
  /** Maps timepoint label → clone_id(s) present in that timepoint for this lineage/clone */
  cloneIdsByTimepoint: Record<string, number[]>;
}

export interface ClonalDynamicsData {
  entries: ClonalDynamicsEntry[];
  /** All ranked entries (not limited to topN), for bubble chart per-timepoint mode */
  allEntries: ClonalDynamicsEntry[];
  timepointLabels: string[];
  /** Total sequences per timepoint (for display in header) */
  timepointTotals: { label: string; total: number }[];
  stats: {
    persistent: number;
    expanding: number;
    contracting: number;
    disappeared: number;
    lateEmerging: number;
    total: number;
  };
}

/**
 * Compute clonal dynamics heatmap data: track lineages (or clones) across timepoints.
 * Uses lineage_id when available for cross-timepoint tracking, else clone_id.
 * All sizes are normalized to frequencies (proportion of timepoint repertoire)
 * to account for differences in sequencing depth across timepoints.
 */
export function computeClonalDynamicsHeatmap(
  fileGroups: FileGroup[],
  timepointMapping: TimepointMapping,
  topN: number = 20
): ClonalDynamicsData {
  const tpLabels = getTimepointLabels(timepointMapping);
  const hasMapping = Object.keys(timepointMapping).length > 0;
  const emptyTotals = tpLabels.map(l => ({ label: l, total: 0 }));

  if (tpLabels.length < 2) {
    return { entries: [], allEntries: [], timepointLabels: tpLabels, timepointTotals: emptyTotals, stats: { persistent: 0, expanding: 0, contracting: 0, disappeared: 0, lateEmerging: 0, total: 0 } };
  }

  // Compute total sequences per timepoint (for normalization)
  const tpTotalMap = new Map<string, number>();
  for (const tp of tpLabels) tpTotalMap.set(tp, 0);

  const hasLineageIds = fileGroups.some(fg => fg.sequences.some(s => s.lineage_id != null));

  type TrackEntry = { trackId: number; lineageId?: number; cloneId: number; tp: string; seq: SequenceData };
  const trackEntries: TrackEntry[] = [];

  for (const fg of fileGroups) {
    const tp = hasMapping ? getTimepoint(fg.filename, timepointMapping) : '';
    if (!tp) continue;
    for (const seq of fg.sequences) {
      if (seq.clone_id == null) continue;
      // Count toward timepoint total
      tpTotalMap.set(tp, (tpTotalMap.get(tp) ?? 0) + 1);
      const trackId = (hasLineageIds && seq.lineage_id != null) ? seq.lineage_id : seq.clone_id;
      trackEntries.push({ trackId, lineageId: seq.lineage_id ?? undefined, cloneId: seq.clone_id, tp, seq });
    }
  }

  const timepointTotals = tpLabels.map(label => ({ label, total: tpTotalMap.get(label) ?? 0 }));

  // Group by trackId
  const trackMap = new Map<number, Map<string, SequenceData[]>>();
  const trackMeta = new Map<number, { lineageId?: number; cloneId: number; repSeq: SequenceData }>();
  const trackCloneIds = new Map<number, Map<string, Set<number>>>();

  for (const entry of trackEntries) {
    if (!trackMap.has(entry.trackId)) {
      trackMap.set(entry.trackId, new Map());
      trackMeta.set(entry.trackId, { lineageId: entry.lineageId, cloneId: entry.cloneId, repSeq: entry.seq });
      trackCloneIds.set(entry.trackId, new Map());
    }
    const tpMap = trackMap.get(entry.trackId)!;
    if (!tpMap.has(entry.tp)) tpMap.set(entry.tp, []);
    tpMap.get(entry.tp)!.push(entry.seq);

    const cidMap = trackCloneIds.get(entry.trackId)!;
    if (!cidMap.has(entry.tp)) cidMap.set(entry.tp, new Set());
    cidMap.get(entry.tp)!.add(entry.cloneId);
  }

  // Build dynamics entries with frequency normalization
  const allEntries: ClonalDynamicsEntry[] = [];

  for (const [trackId, tpMap] of trackMap) {
    const meta = trackMeta.get(trackId)!;
    const timepointSizes: TimepointSize[] = tpLabels.map(label => {
      const rawCount = tpMap.get(label)?.length ?? 0;
      const tpTotal = tpTotalMap.get(label) ?? 1;
      return {
        label,
        frequency: tpTotal > 0 ? rawCount / tpTotal : 0,
        rawCount
      };
    });
    const totalRawCount = timepointSizes.reduce((s, t) => s + t.rawCount, 0);
    if (totalRawCount === 0) continue;

    // Determine status using FREQUENCY (not raw counts) to avoid depth bias
    const presentTps = timepointSizes.filter(t => t.rawCount > 0);
    const firstPresentIdx = timepointSizes.findIndex(t => t.rawCount > 0);
    const lastPresentIdx = timepointSizes.length - 1 - [...timepointSizes].reverse().findIndex(t => t.rawCount > 0);

    let status: ClonalStatus;
    if (presentTps.length === tpLabels.length) {
      const firstFreq = timepointSizes[0].frequency;
      const lastFreq = timepointSizes[timepointSizes.length - 1].frequency;
      if (firstFreq > 0 && lastFreq > firstFreq * 1.5) status = 'expanding';
      else if (firstFreq > 0 && lastFreq < firstFreq * 0.67) status = 'contracting';
      else status = 'persistent';
    } else if (firstPresentIdx === 0 && lastPresentIdx < tpLabels.length - 1) {
      status = 'disappeared';
    } else if (firstPresentIdx > 0) {
      status = 'late_emerging';
    } else {
      status = 'transient';
    }

    const isLineage = hasLineageIds && meta.lineageId != null;
    const repSeq = meta.repSeq;

    // Build per-timepoint clone ID map
    const cidMap = trackCloneIds.get(trackId);
    const cloneIdsByTimepoint: Record<string, number[]> = {};
    if (cidMap) {
      for (const [tp, cids] of cidMap) {
        cloneIdsByTimepoint[tp] = [...cids];
      }
    }

    allEntries.push({
      cloneLabel: isLineage ? `Lineage ${trackId}` : `Clone ${meta.cloneId}`,
      cloneId: meta.cloneId,
      lineageId: meta.lineageId,
      cdr3Aa: repSeq.cdr3_peptide || '',
      vGene: repSeq.v_gene?.split('*')[0] || '',
      jGene: repSeq.j_gene?.split('*')[0] || '',
      timepointSizes,
      totalRawCount,
      status,
      cloneIdsByTimepoint
    });
  }

  // Sort by total sequence count (largest clones first) and assign ranked labels
  allEntries.sort((a, b) => b.totalRawCount - a.totalRawCount);
  allEntries.forEach((e, i) => { e.cloneLabel = `C${i + 1}`; });

  const topEntries = allEntries.slice(0, topN);

  const stats = {
    persistent: allEntries.filter(e => e.status === 'persistent').length,
    expanding: allEntries.filter(e => e.status === 'expanding').length,
    contracting: allEntries.filter(e => e.status === 'contracting').length,
    disappeared: allEntries.filter(e => e.status === 'disappeared').length,
    lateEmerging: allEntries.filter(e => e.status === 'late_emerging').length,
    total: allEntries.length
  };

  return { entries: topEntries, allEntries, timepointLabels: tpLabels, timepointTotals, stats };
}

// ---------------------------------------------------------------------------
// Visualization data builders (for shared clones heatmap)
// ---------------------------------------------------------------------------

function buildVisualizationData(
  publicClones: PublicCloneResult[],
  allPatients: string[],
  patientSeqTotals?: Map<string, number>
): VisualizationData {
  const viz: VisualizationData = {
    heatmap: { clones: [], patients: [], matrix: [], frequencies: [], rawCounts: [], patientTotals: [] },
    chord: { nodes: [], links: [] },
    upset: { sets: {}, intersections: [] },
    network: { nodes: [], edges: [] }
  };

  if (publicClones.length === 0) return viz;

  // --- Heatmap: use Clone ID labels, frequency-normalized ---
  viz.heatmap.patients = allPatients;
  viz.heatmap.patientTotals = allPatients.map(p => patientSeqTotals?.get(p) ?? 0);

  for (const clone of publicClones) {
    viz.heatmap.clones.push(clone.id.replace('clone_', 'Clone '));

    const presenceRow: number[] = [];
    const frequencyRow: number[] = [];
    const rawCountRow: number[] = [];
    for (const patient of allPatients) {
      const rawCount = clone.sequences_by_patient?.[patient]?.length ?? 0;
      const patientTotal = patientSeqTotals?.get(patient) ?? 0;
      const freq = patientTotal > 0 ? (rawCount / patientTotal) * 100 : 0; // percentage
      presenceRow.push(rawCount > 0 ? 1 : 0);
      frequencyRow.push(freq);
      rawCountRow.push(rawCount);
    }
    viz.heatmap.matrix.push(presenceRow);
    viz.heatmap.frequencies.push(frequencyRow);
    viz.heatmap.rawCounts!.push(rawCountRow);
  }

  // --- Chord diagram ---
  viz.chord.nodes = allPatients;
  const pairCounts = new Map<string, number>();
  for (const clone of publicClones) {
    for (let i = 0; i < clone.patients.length; i++) {
      for (let j = i + 1; j < clone.patients.length; j++) {
        const key = [clone.patients[i], clone.patients[j]].sort().join('||');
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, value] of pairCounts) {
    const [source, target] = key.split('||');
    viz.chord.links.push({ source, target, value });
  }

  // --- UpSet ---
  for (const patient of allPatients) {
    viz.upset.sets[patient] = publicClones.filter(c => c.patients.includes(patient)).length;
  }
  const intersectionCounts = new Map<string, number>();
  for (const clone of publicClones) {
    const key = clone.patients.join('||');
    intersectionCounts.set(key, (intersectionCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of intersectionCounts) {
    viz.upset.intersections.push({ sets: key.split('||'), size: count });
  }
  viz.upset.intersections.sort((a, b) => b.size - a.size);

  // --- Network ---
  for (const patient of allPatients) {
    viz.network.nodes.push({ id: `patient_${patient}`, type: 'patient', label: patient });
  }
  for (let i = 0; i < Math.min(publicClones.length, 50); i++) {
    const clone = publicClones[i];
    const cid = `clone_${i}`;
    viz.network.nodes.push({ id: cid, type: 'clone', label: clone.id.replace('clone_', 'Cl.') });
    for (const patient of clone.patients) {
      viz.network.edges.push({ source: cid, target: `patient_${patient}`, count: clone.sequence_count });
    }
  }

  return viz;
}

// ---------------------------------------------------------------------------
// Public/Private clone classification for bubble chart coloring
// ---------------------------------------------------------------------------

/**
 * Identify clone IDs that are "public" (shared by >=2 distinct patients at
 * the same timepoint, aggregated across all timepoints). Returns a Set of clone_ids.
 *
 * Groups by patient (not by file) so multi-run patients, the same patient
 * contributing two files to one timepoint, are counted as one patient, matching
 * the definition used by `computePublicClonesPerTimepoint` and the CoV-AbDab
 * matching orchestrator.
 */
export function getPublicCloneIds(
  fileGroups: FileGroup[],
  timepointMapping: TimepointMapping
): Set<number> {
  const hasMapping = Object.keys(timepointMapping).length > 0;
  // Group files by timepoint
  const tpFiles = new Map<string, string[]>();
  for (const [filename, entry] of Object.entries(timepointMapping)) {
    const tp = entry.timepoint;
    if (!tpFiles.has(tp)) tpFiles.set(tp, []);
    tpFiles.get(tp)!.push(filename);
  }

  const publicIds = new Set<number>();
  const fgMap = new Map<string, FileGroup>();
  for (const fg of fileGroups) fgMap.set(fg.filename, fg);

  for (const [, files] of tpFiles) {
    if (files.length < 2) continue;
    // clone_id -> set of distinct patient names at this timepoint
    const cloneToPatients = new Map<number, Set<string>>();
    for (const filename of files) {
      const fg = fgMap.get(filename);
      if (!fg) continue;
      const patient = hasMapping ? getPatientName(filename, timepointMapping) : filename;
      for (const seq of fg.sequences) {
        if (seq.clone_id == null) continue;
        if (!cloneToPatients.has(seq.clone_id)) cloneToPatients.set(seq.clone_id, new Set());
        cloneToPatients.get(seq.clone_id)!.add(patient);
      }
    }
    for (const [cloneId, patients] of cloneToPatients) {
      if (patients.size >= 2) publicIds.add(cloneId);
    }
  }

  return publicIds;
}

// ---------------------------------------------------------------------------
// Section 3: Isotype Tile Data (per clone × timepoint)
// ---------------------------------------------------------------------------

export const ISOTYPE_COLORS: Record<string, string> = {
  IgM: '#4e79a7',
  IgD: '#76b7b2',
  IgG: '#e15759',
  IgA: '#f28e2b',
  IgE: '#b07aa1',
  Mixed: '#bab0ac'
};

export const ISOTYPE_ORDER = ['IgM', 'IgD', 'IgG', 'IgA', 'IgE'];

export interface IsotypeTileEntry {
  cloneLabel: string;
  cloneId: number;
  lineageId?: number;
  cdr3Aa: string;
  vGene: string;
  jGene: string;
  totalRawCount: number;
  status: ClonalStatus;
  meanSHM: number;
  patientCount: number;
  tiles: IsotypeTile[];
}

export interface IsotypeTile {
  timepointLabel: string;
  dominantIsotype: string | null;
  seqCount: number;
  isotypeBreakdown: Record<string, number>;
  meanSHM: number;
}

/**
 * Compute isotype tile data for clonal dynamics entries.
 * For each clone × timepoint, determines the dominant isotype by examining
 * sequences within that clone's timepoint bucket.
 */
export function computeIsotypePerCloneTimepoint(
  entries: ClonalDynamicsEntry[],
  fileGroups: FileGroup[],
  timepointMapping: TimepointMapping,
  timepointLabels: string[]
): IsotypeTileEntry[] {
  const fgMap = new Map<string, FileGroup>();
  for (const fg of fileGroups) fgMap.set(fg.filename, fg);

  // Build lookup: trackId → timepoint → sequences
  const trackSeqsByTp = new Map<number, Map<string, SequenceData[]>>();

  const hasLineageIds = fileGroups.some(fg => fg.sequences.some(s => s.lineage_id != null));

  for (const fg of fileGroups) {
    const tp = timepointMapping[fg.filename]?.timepoint;
    if (!tp) continue;
    for (const seq of fg.sequences) {
      if (seq.clone_id == null) continue;
      const trackId = (hasLineageIds && seq.lineage_id != null) ? seq.lineage_id : seq.clone_id;
      if (!trackSeqsByTp.has(trackId)) trackSeqsByTp.set(trackId, new Map());
      const tpMap = trackSeqsByTp.get(trackId)!;
      if (!tpMap.has(tp)) tpMap.set(tp, []);
      tpMap.get(tp)!.push(seq);
    }
  }

  // Count unique patients per trackId
  const trackPatients = new Map<number, Set<string>>();
  for (const fg of fileGroups) {
    const patient = getPatientName(fg.filename, timepointMapping);
    for (const seq of fg.sequences) {
      if (seq.clone_id == null) continue;
      const trackId = (hasLineageIds && seq.lineage_id != null) ? seq.lineage_id : seq.clone_id;
      if (!trackPatients.has(trackId)) trackPatients.set(trackId, new Set());
      trackPatients.get(trackId)!.add(patient);
    }
  }

  return entries.map(entry => {
    const trackId = (hasLineageIds && entry.lineageId != null) ? entry.lineageId : entry.cloneId;
    const tpMap = trackSeqsByTp.get(trackId);

    const allShmValues: number[] = [];
    const tiles: IsotypeTile[] = timepointLabels.map(label => {
      const seqs = tpMap?.get(label) ?? [];
      const breakdown: Record<string, number> = {};
      let shmSum = 0;
      let shmCount = 0;

      for (const s of seqs) {
        const ig = cCallToIgClass(s.c_call);
        if (ig) breakdown[ig] = (breakdown[ig] ?? 0) + 1;
        if (s.somatic_mutations != null) {
          shmSum += s.somatic_mutations;
          shmCount++;
          allShmValues.push(s.somatic_mutations);
        }
      }

      let dominantIsotype: string | null = null;
      let maxCount = 0;
      for (const [iso, cnt] of Object.entries(breakdown)) {
        if (cnt > maxCount) { maxCount = cnt; dominantIsotype = iso; }
      }

      return {
        timepointLabel: label,
        dominantIsotype: seqs.length === 0 ? null : dominantIsotype,
        seqCount: seqs.length,
        isotypeBreakdown: breakdown,
        meanSHM: shmCount > 0 ? shmSum / shmCount : 0
      };
    });

    const overallMeanSHM = allShmValues.length > 0
      ? allShmValues.reduce((a, b) => a + b, 0) / allShmValues.length
      : 0;

    return {
      cloneLabel: entry.cloneLabel,
      cloneId: entry.cloneId,
      lineageId: entry.lineageId,
      cdr3Aa: entry.cdr3Aa,
      vGene: entry.vGene,
      jGene: entry.jGene,
      totalRawCount: entry.totalRawCount,
      status: entry.status,
      meanSHM: overallMeanSHM,
      patientCount: trackPatients.get(trackId)?.size ?? 1,
      tiles
    };
  });
}
