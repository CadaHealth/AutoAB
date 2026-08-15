/**
 * Export utilities for all views.
 * CSV for simple exports, XLSX (multi-sheet) for shared clones & clonal dynamics.
 */

import * as XLSX from 'xlsx';
import type { GroupTimepointMetrics, LongitudinalGroupData } from './repertoire-metrics';
import { computeDiversity, computeVGeneFrequencies, computeIsotypeFrequencies } from './repertoire-metrics';
import { wilcoxonRankSum, benjaminiHochberg, type WilcoxonResult } from './statistics';
import type { ClonalDynamicsEntry, ClonalDynamicsData, IsotypeTileEntry } from './public-clones';
import { computePublicClonesPerTimepoint, computePublicClones, getTimepointLabels } from './public-clones';
import type { TreeMetadata, PublicClonesData, CohortResults, FileGroup, TimepointMapping, CovidMatchData } from '../stores/app';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(value: any): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function row(values: any[]): string {
  return values.map(esc).join(',');
}

/**
 * Trigger a CSV download in the browser or via Electron save dialog.
 */
export async function downloadCsv(csvContent: string, defaultFilename: string): Promise<void> {
  if (window.electronAPI) {
    const filePath = await window.electronAPI.saveFile({
      defaultPath: defaultFilename,
      filters: [
        { name: 'CSV Files', extensions: ['csv'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!filePath) return;
    const result = await window.electronAPI.writeFile(filePath, csvContent);
    if (!result.success) {
      alert(`Failed to export: ${result.error || 'Unknown error'}`);
    }
  } else {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/**
 * Trigger an XLSX workbook download in the browser or via Electron save dialog.
 */
export async function downloadXlsx(workbook: XLSX.WorkBook, defaultFilename: string): Promise<void> {
  const xlsxData = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const bytes = new Uint8Array(xlsxData);

  if (window.electronAPI) {
    const filePath = await window.electronAPI.saveFile({
      defaultPath: defaultFilename,
      filters: [
        { name: 'Excel Files', extensions: ['xlsx'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!filePath) return;
    // Convert to base64 for IPC transfer (chunked to avoid call-stack limits)
    let base64 = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      base64 += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
    }
    base64 = btoa(base64);
    const result = await window.electronAPI.writeBinaryFile(filePath, base64);
    if (!result.success) {
      alert(`Failed to export: ${result.error || 'Unknown error'}`);
    }
  } else {
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/** Truncate an Excel sheet name to 31 chars (Excel limit) and ensure uniqueness. */
function safeSheetName(name: string, existing: string[]): string {
  let safe = name.replace(/[\\\/\?\*\[\]:]/g, '-').slice(0, 31);
  let suffix = 2;
  const base = safe;
  while (existing.includes(safe)) {
    const tag = ` (${suffix++})`;
    safe = base.slice(0, 31 - tag.length) + tag;
  }
  return safe;
}

// ---------------------------------------------------------------------------
// 1. Dashboard Export
// ---------------------------------------------------------------------------

/**
 * Export repertoire dashboard metrics.
 * One row per cohort × group × timepoint with all diversity metrics,
 * V-gene frequencies, and isotype frequencies.
 *
 * Structure:
 *   Cohort | Group | Timepoint | Total Sequences | Unique Clones | Shannon Entropy |
 *   Simpson Index | Chao1 | Gini Index | Mean SHM | Median SHM | D50 |
 *   Productive % | Mean Clone Size |
 *   V-Gene frequencies (IGHV1..IGHV7) | Isotype frequencies (IgM, IgD, IgG, IgA, IgE)
 */
export function dashboardMetricsToCsv(
  diseaseMetrics: GroupTimepointMetrics[],
  controlMetrics: GroupTimepointMetrics[],
  diseaseCohortName: string,
  controlCohortName: string,
  diseaseLongitudinal: LongitudinalGroupData[],
  controlLongitudinal: LongitudinalGroupData[],
  extraCohorts: { name: string; metrics: GroupTimepointMetrics[] }[] = []
): string {
  const lines: string[] = [];

  // --- Sheet 1: Per-Timepoint Metrics ---
  lines.push('# Per-Timepoint Repertoire Metrics');
  const vGeneFamilies = collectVGeneFamilies([
    ...diseaseMetrics,
    ...controlMetrics,
    ...extraCohorts.flatMap(c => c.metrics),
  ]);
  const isoTypes = ['IgM', 'IgD', 'IgG', 'IgA', 'IgE'];

  const headers = [
    'Cohort', 'Group', 'Timepoint',
    'Total Sequences', 'Clone-Assigned Sequences', 'Unique Clones', 'Mean Clone Size',
    'Shannon Entropy', 'Simpson Index', 'Chao1', 'Gini Index',
    'Mean SHM', 'Median SHM', 'D50', 'Productive %',
    'Expanded Clones %', 'Top-1 Clone %', 'Top-10 Clones %',
    ...vGeneFamilies.map(f => `V-Gene ${f} (freq)`),
    ...isoTypes.map(i => `${i} (freq)`)
  ];
  lines.push(row(headers));

  function pushMetricRows(metrics: GroupTimepointMetrics[], cohortName: string) {
    for (const m of metrics) {
      const vFreqMap = new Map(m.vGeneFreqs.map(v => [v.family, v.frequency]));
      const iFreqMap = new Map(m.isotypeFreqs.map(i => [i.isotype, i.frequency]));
      lines.push(row([
        cohortName, m.groupName, m.timepointLabel,
        m.diversity.totalSequences, m.diversity.clonedSequences, m.diversity.uniqueClones,
        m.diversity.meanCloneSize.toFixed(2),
        m.diversity.shannonEntropy.toFixed(4),
        m.diversity.simpsonIndex.toFixed(4),
        m.diversity.chao1.toFixed(1),
        m.diversity.giniIndex.toFixed(4),
        m.diversity.meanSHM.toFixed(2),
        m.diversity.medianSHM.toFixed(2),
        m.diversity.d50,
        m.diversity.productivePercent.toFixed(1),
        (m.diversity.expandedCloneFraction * 100).toFixed(2),
        (m.diversity.top1CloneFraction * 100).toFixed(2),
        (m.diversity.top10CloneFraction * 100).toFixed(2),
        ...vGeneFamilies.map(f => (vFreqMap.get(f) ?? 0).toFixed(4)),
        ...isoTypes.map(i => (iFreqMap.get(i) ?? 0).toFixed(4))
      ]));
    }
  }

  pushMetricRows(diseaseMetrics, diseaseCohortName);
  if (controlMetrics.length > 0) {
    pushMetricRows(controlMetrics, controlCohortName);
  }
  for (const c of extraCohorts) {
    pushMetricRows(c.metrics, c.name);
  }

  // --- Sheet 2: Longitudinal Diversity Trajectory ---
  if (diseaseLongitudinal.length > 0 || controlLongitudinal.length > 0) {
    lines.push('');
    lines.push('# Longitudinal Diversity Trajectory');
    lines.push(row([
      'Cohort', 'Group', 'Timepoint',
      'Total Sequences', 'Unique Clones',
      'Shannon Entropy', 'Simpson Index', 'Chao1', 'Gini Index',
      'Mean SHM', 'D50', 'Productive %',
      ...isoTypes.map(i => `${i} (freq)`)
    ]));

    function pushLongitudinal(data: LongitudinalGroupData[], cohortName: string) {
      for (const group of data) {
        for (let i = 0; i < group.timepointLabels.length; i++) {
          const d = group.diversityTrajectory[i];
          const iso = group.isotypeTrajectory[i] ?? [];
          const iMap = new Map(iso.map(x => [x.isotype, x.frequency]));
          lines.push(row([
            cohortName, group.groupName, group.timepointLabels[i],
            d.totalSequences, d.uniqueClones,
            d.shannonEntropy.toFixed(4), d.simpsonIndex.toFixed(4),
            d.chao1.toFixed(1), d.giniIndex.toFixed(4),
            d.meanSHM.toFixed(2), d.d50, d.productivePercent.toFixed(1),
            ...isoTypes.map(x => (iMap.get(x) ?? 0).toFixed(4))
          ]));
        }
      }
    }

    pushLongitudinal(diseaseLongitudinal, diseaseCohortName);
    pushLongitudinal(controlLongitudinal, controlCohortName);
  }

  return lines.join('\n');
}

function collectVGeneFamilies(metrics: GroupTimepointMetrics[]): string[] {
  const families = new Set<string>();
  for (const m of metrics) {
    for (const v of m.vGeneFreqs) families.add(v.family);
  }
  return [...families].sort();
}

// ---------------------------------------------------------------------------
// 1b. Dashboard Per-Patient Export
// ---------------------------------------------------------------------------

export interface PerPatientExportParams {
  diseaseFileGroups: FileGroup[];
  diseaseTimepointMapping: TimepointMapping;
  diseaseCohortName: string;
  controlFileGroups?: FileGroup[];
  controlTimepointMapping?: TimepointMapping;
  controlCohortName?: string;
  /** Additional cohorts (N-cohort studies). Each appended as rows in the same CSV. */
  extraCohorts?: { name: string; fileGroups: FileGroup[]; timepointMapping: TimepointMapping }[];
  /**
   * Depth-normalisation state at export time. Written into the file as a
   * provenance line, so a table cannot be separated from the setting that
   * produced it. The metric rows and tests below stay unnormalised in either
   * case: the depth-matched values belong to a comparison view, and mixing
   * both into one column would make the file ambiguous.
   */
  normalization?: { enabled: boolean; depth: number; replicates: number; seed: number };
}

/**
 * Export per-patient (per-file) repertoire metrics.
 * One row per patient × timepoint with full diversity metrics + isotype frequencies.
 * Patient ID is derived from the original filename (timepoint prefix stripped).
 */
export function dashboardPerPatientCsv(params: PerPatientExportParams): string {
  const lines: string[] = [];
  const isoTypes = ['IgM', 'IgD', 'IgG', 'IgA', 'IgE'];

  const norm = params.normalization;
  lines.push(norm?.enabled
    ? `# Depth normalization: on | depth=${norm.depth} | replicates=${norm.replicates} `
      + `| seed=${norm.seed} | mean over draws | rows below are UNNORMALIZED`
    : '# Depth normalization: off');
  lines.push('# Clone-Assigned Sequences is the depth every clone-derived metric is computed on');

  // Collect all V-gene families across all files for consistent columns
  const allVFamilies = new Set<string>();

  interface PatientRow {
    cohort: string;
    patientId: string;
    timepoint: string;
    fileGroup: FileGroup;
  }

  const allRows: PatientRow[] = [];

  function collectRows(fileGroups: FileGroup[], tpMapping: TimepointMapping, cohortName: string) {
    for (const fg of fileGroups) {
      const entry = tpMapping[fg.filename];
      const timepoint = entry?.timepoint ?? '';
      // Patient ID = original filename without extension
      let patientId = entry?.originalFile ?? fg.filename;
      // Strip file extension
      patientId = patientId.replace(/\.(fasta|fa|fastq|fq|csv|tsv)$/i, '');
      allRows.push({ cohort: cohortName, patientId, timepoint, fileGroup: fg });

      // Pre-collect V-gene families
      for (const v of computeVGeneFrequencies(fg.sequences)) {
        allVFamilies.add(v.family);
      }
    }
  }

  collectRows(params.diseaseFileGroups, params.diseaseTimepointMapping, params.diseaseCohortName);
  if (params.controlFileGroups && params.controlTimepointMapping && params.controlCohortName) {
    collectRows(params.controlFileGroups, params.controlTimepointMapping, params.controlCohortName);
  }
  for (const c of params.extraCohorts ?? []) {
    collectRows(c.fileGroups, c.timepointMapping, c.name);
  }

  const vGeneFamilies = [...allVFamilies].sort();

  const headers = [
    'Cohort', 'Sample_ID', 'Timepoint',
    'Total Sequences', 'Clone-Assigned Sequences', 'Unique Clones', 'Mean Clone Size',
    'Shannon Entropy', 'Simpson Index', 'Chao1', 'Gini Index',
    'Mean SHM', 'Median SHM', 'D50', 'Productive %',
    'Expanded Clones %', 'Top-1 Clone %', 'Top-10 Clones %',
    ...vGeneFamilies.map(f => `V-Gene ${f} (freq)`),
    ...isoTypes.map(i => `${i} (freq)`)
  ];
  lines.push(row(headers));

  // Build per-patient diversity data for statistical tests
  interface PatientDiv {
    cohort: string;
    timepoint: string;
    div: ReturnType<typeof computeDiversity>;
    isoFreqs: Map<string, number>;
  }
  const patientDivs: PatientDiv[] = [];

  for (const pr of allRows) {
    const seqs = pr.fileGroup.sequences;
    const div = computeDiversity(seqs);
    const vFreqs = computeVGeneFrequencies(seqs);
    const iFreqs = computeIsotypeFrequencies(seqs);
    const vFreqMap = new Map(vFreqs.map(v => [v.family, v.frequency]));
    const iFreqMap = new Map(iFreqs.map(i => [i.isotype, i.frequency]));

    patientDivs.push({ cohort: pr.cohort, timepoint: pr.timepoint, div, isoFreqs: iFreqMap });

    lines.push(row([
      pr.cohort, pr.patientId, pr.timepoint,
      div.totalSequences, div.clonedSequences, div.uniqueClones,
      div.meanCloneSize.toFixed(2),
      div.shannonEntropy.toFixed(4),
      div.simpsonIndex.toFixed(4),
      div.chao1.toFixed(1),
      div.giniIndex.toFixed(4),
      div.meanSHM.toFixed(2),
      div.medianSHM.toFixed(2),
      div.d50,
      div.productivePercent.toFixed(1),
      (div.expandedCloneFraction * 100).toFixed(2),
      (div.top1CloneFraction * 100).toFixed(2),
      (div.top10CloneFraction * 100).toFixed(2),
      ...vGeneFamilies.map(f => (vFreqMap.get(f) ?? 0).toFixed(4)),
      ...isoTypes.map(i => (iFreqMap.get(i) ?? 0).toFixed(4))
    ]));
  }

  // Append statistical tests if two cohorts are present
  if (params.controlFileGroups && params.controlCohortName) {
    const diseaseName = params.diseaseCohortName;
    const controlName = params.controlCohortName;
    const timepoints = [...new Set(patientDivs.map(p => p.timepoint))].filter(t => t).sort();

    const metricDefs: { key: string; label: string; accessor: (d: PatientDiv) => number }[] = [
      { key: 'shannon', label: 'Shannon Entropy', accessor: d => d.div.shannonEntropy },
      { key: 'simpson', label: 'Simpson Index', accessor: d => d.div.simpsonIndex },
      { key: 'chao1', label: 'Chao1', accessor: d => d.div.chao1 },
      { key: 'gini', label: 'Gini Index', accessor: d => d.div.giniIndex },
      { key: 'meanSHM', label: 'Mean SHM', accessor: d => d.div.meanSHM },
      ...isoTypes.map(iso => ({
        key: `iso_${iso}`, label: `${iso} (freq)`, accessor: (d: PatientDiv) => d.isoFreqs.get(iso) ?? 0
      }))
    ];

    // Collect all tests, grouped by correction pool
    // Pool 1: diversity metrics (Shannon, Simpson, Chao1, Gini, Mean SHM), matches boxplot chart
    // Pool 2: isotype metrics (IgM, IgG, IgA, IgD, IgE), matches isotype comparison chart
    interface TestEntry { tp: string; metric: string; label: string; test: WilcoxonResult; n1: number; n2: number; pool: 'diversity' | 'isotype' }
    const allTests: TestEntry[] = [];

    const diversityKeys = new Set(['shannon', 'simpson', 'chao1', 'gini', 'meanSHM']);

    for (const tp of timepoints) {
      const dPatients = patientDivs.filter(p => p.cohort === diseaseName && p.timepoint === tp);
      const cPatients = patientDivs.filter(p => p.cohort === controlName && p.timepoint === tp);
      for (const md of metricDefs) {
        const dVals = dPatients.map(md.accessor);
        const cVals = cPatients.map(md.accessor);
        const test = wilcoxonRankSum(dVals, cVals);
        const pool = diversityKeys.has(md.key) ? 'diversity' as const : 'isotype' as const;
        allTests.push({ tp, metric: md.key, label: md.label, test, n1: dVals.length, n2: cVals.length, pool });
      }
    }

    // BH-FDR correction applied separately per pool (matching the dashboard charts)
    const adjustedPs = new Map<number, number>();
    for (const pool of ['diversity', 'isotype'] as const) {
      const poolIndices = allTests.map((t, i) => t.pool === pool && t.test.valid ? i : -1).filter(i => i >= 0);
      const poolPs = poolIndices.map(i => allTests[i].test.p);
      const poolAdj = benjaminiHochberg(poolPs);
      poolIndices.forEach((idx, j) => { adjustedPs.set(idx, poolAdj[j]); });
    }

    lines.push('');
    lines.push(row(['STATISTICAL TESTS', `${diseaseName} vs ${controlName}`, 'Wilcoxon rank-sum (Mann-Whitney U)', 'BH-FDR corrected per metric group']));
    lines.push(row([
      'Timepoint', 'Metric', 'Correction Pool',
      `n (${diseaseName})`, `n (${controlName})`,
      'U statistic', 'p-value (raw)', 'p-value (BH-adjusted)',
      'Effect size (r)', 'Significant (p<0.05)'
    ]));

    allTests.forEach((te, idx) => {
      if (!te.test.valid) {
        lines.push(row([te.tp, te.label, te.pool, te.n1, te.n2, '', '', '', '', 'n too small']));
      } else {
        const adjP = adjustedPs.get(idx) ?? te.test.p;
        lines.push(row([
          te.tp, te.label, te.pool,
          te.n1, te.n2,
          te.test.U,
          te.test.p.toFixed(6),
          adjP.toFixed(6),
          te.test.r.toFixed(4),
          adjP < 0.05 ? 'Yes' : 'No'
        ]));
      }
    });
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 2. Phylogenetic Trees Export
// ---------------------------------------------------------------------------

/**
 * Export tree metadata as a flat CSV.
 * One row per tree with cohort, timepoint, clone info.
 */
export function treeMetadataToCsv(
  treeMetadata: TreeMetadata[],
  treeImages: string[],
  cohortResults: CohortResults[]
): string {
  const lines: string[] = [];
  const headers = ['Cohort', 'Timepoint', 'Clone ID', 'Clone Size', 'Tree File'];
  lines.push(row(headers));

  if (cohortResults.length > 0) {
    for (const cohort of cohortResults) {
      for (let i = 0; i < cohort.treeMetadata.length; i++) {
        const m = cohort.treeMetadata[i];
        const imgPath = cohort.treeImages[i] ?? '';
        const filename = imgPath.split('/').pop() ?? '';
        lines.push(row([
          cohort.cohortName,
          m.timepoint ?? '',
          m.clone_id ?? '',
          m.clone_size ?? '',
          filename
        ]));
      }
    }
  } else {
    for (let i = 0; i < treeMetadata.length; i++) {
      const m = treeMetadata[i];
      const imgPath = treeImages[i] ?? m.path ?? '';
      const filename = imgPath.split('/').pop() ?? '';
      lines.push(row([
        '',
        m.timepoint ?? '',
        m.clone_id ?? '',
        m.clone_size ?? '',
        filename
      ]));
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 3. Clones - Shared Clones Full Export (XLSX, one sheet per cohort×timepoint)
// ---------------------------------------------------------------------------

export interface SharedClonesExportParams {
  fileGroups: FileGroup[];
  timepointMapping: TimepointMapping;
  cohortResults: CohortResults[];
}

/**
 * Build an XLSX workbook with one sheet per cohort × timepoint.
 * Sheet names: "Disease T1", "Disease T2", "Control T1", etc.
 */
export function sharedClonesWorkbook(params: SharedClonesExportParams): XLSX.WorkBook {
  const { fileGroups, timepointMapping, cohortResults } = params;
  const wb = XLSX.utils.book_new();
  const hasCohorts = cohortResults.length > 0;

  interface CohortSource {
    cohortName: string;
    fileGroups: FileGroup[];
    timepointMapping: TimepointMapping;
  }

  const sources: CohortSource[] = hasCohorts
    ? cohortResults.map(c => ({
        cohortName: c.cohortName,
        fileGroups: c.fileGroups,
        timepointMapping: c.timepointMapping
      }))
    : [{ cohortName: 'All Samples', fileGroups, timepointMapping }];

  const usedNames: string[] = [];

  for (const src of sources) {
    const tpLabels = getTimepointLabels(src.timepointMapping);
    const hasTimepoints = tpLabels.length > 0;
    const timepointsToExport = hasTimepoints ? tpLabels : [null];

    for (const tp of timepointsToExport) {
      const data = tp
        ? computePublicClonesPerTimepoint(src.fileGroups, src.timepointMapping, tp, { topN: 99999 })
        : computePublicClones(src.fileGroups, src.timepointMapping, { topN: 99999 });

      const clones = data.public_clones;
      if (clones.length === 0) continue;

      // Collect patients
      const allPatients = new Set<string>();
      for (const c of clones) {
        for (const p of c.patients) allPatients.add(p);
      }
      const sortedPatients = [...allPatients].sort();

      // Patient totals (sequences per sample) drive the % of repertoire that the
      // heatmap displays, keep the spreadsheet 1:1 with the heatmap cells.
      const heatmapPatients = data.visualizations.heatmap.patients;
      const heatmapTotals = data.visualizations.heatmap.patientTotals ?? [];
      const totalsByPatient = new Map<string, number>();
      heatmapPatients.forEach((p, i) => totalsByPatient.set(p, heatmapTotals[i] ?? 0));

      const headers = [
        'Clone ID', 'CDR3 Amino Acid', 'CDR3 DNA', 'V Gene', 'J Gene',
        'Patient Count', 'Total Sequence Count', 'Unique CDR3 Variants',
        ...sortedPatients.map(p => `${p} (count)`),
        ...sortedPatients.map(p => `${p} (% of repertoire)`)
      ];

      const rows: any[][] = [headers];

      // Patient-totals row, formatted to mirror the heatmap legend: shows how many
      // sequences each sample contributed (denominator for the % columns).
      rows.push([
        'TOTAL SEQUENCES (per sample)', '', '', '', '', '', '', '',
        ...sortedPatients.map(p => totalsByPatient.get(p) ?? 0),
        ...sortedPatients.map(() => '')
      ]);

      for (const c of clones) {
        rows.push([
          c.id.replace('clone_', ''),
          c.cdr3_aa,
          c.cdr3_dna,
          c.v_gene,
          c.j_gene,
          c.patient_count,
          c.sequence_count,
          c.unique_cdr3_variants,
          ...sortedPatients.map(p => c.sequences_by_patient?.[p]?.length ?? 0),
          ...sortedPatients.map(p => {
            const cnt = c.sequences_by_patient?.[p]?.length ?? 0;
            const tot = totalsByPatient.get(p) ?? 0;
            return tot > 0 ? +((cnt / tot) * 100).toFixed(3) : 0;
          })
        ]);
      }

      const rawName = tp
        ? (hasCohorts ? `${src.cohortName} ${tp}` : tp)
        : src.cohortName;
      const sheetName = safeSheetName(rawName, usedNames);
      usedNames.push(sheetName);

      const ws = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
  }

  return wb;
}

// ---------------------------------------------------------------------------
// 3b. Clones - Cross-Cohort Shared Lineages (single-sheet XLSX)
// ---------------------------------------------------------------------------

import type { CrossCohortCluster } from './cross-cohort-clones';

export function crossCohortClonesWorkbook(
  clusters: CrossCohortCluster[],
  allCohortNames: string[],
  cohortTotals: Record<string, number> = {}
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // Sheet 1: cluster-level summary (one row per cross-cohort lineage).
  // First data row shows each cohort's total clone-assigned sequence count, // the denominator behind the "% of repertoire" columns.
  const summaryHeaders = [
    'Lineage ID', 'V Family', 'J Family', 'CDR3 Length',
    'Cohorts Spanned (n)', 'Cohorts',
    'Total Sequences', 'Unique CDR3 Variants',
    ...allCohortNames.map(c => `${c} seqs`),
    ...allCohortNames.map(c => `${c} (% of repertoire)`),
    ...allCohortNames.map(c => `${c} samples`),
    ...allCohortNames.map(c => `${c} top CDR3`),
  ];
  const summaryRows: any[][] = [summaryHeaders];
  // Totals row (denominators for the % columns)
  summaryRows.push([
    'TOTAL SEQUENCES (per cohort)', '', '', '', '', '', '', '',
    ...allCohortNames.map(cn => cohortTotals[cn] ?? 0),
    ...allCohortNames.map(() => ''),
    ...allCohortNames.map(() => ''),
    ...allCohortNames.map(() => ''),
  ]);
  for (const c of clusters) {
    summaryRows.push([
      c.id,
      c.v_family, c.j_family, c.cdr3_length,
      c.cohorts.length, c.cohorts.join(' + '),
      c.total_sequences, c.unique_cdr3_count,
      ...allCohortNames.map(cn => c.cohort_breakdown[cn]?.sequences ?? 0),
      ...allCohortNames.map(cn => {
        const seqs = c.cohort_breakdown[cn]?.sequences ?? 0;
        const tot = cohortTotals[cn] ?? 0;
        return tot > 0 ? +((seqs / tot) * 100).toFixed(3) : 0;
      }),
      ...allCohortNames.map(cn => c.cohort_breakdown[cn]?.samples.size ?? 0),
      ...allCohortNames.map(cn => c.cohort_breakdown[cn]?.topCdr3 ?? ''),
    ]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, ws1, 'Lineages');

  // Sheet 2: member-level detail (one row per cohort × clone in each cluster)
  const memberHeaders = [
    'Lineage ID', 'V Family', 'J Family', 'CDR3 Length',
    'Cohort', 'Clone ID', 'CDR3 (aa)', 'V Gene', 'J Gene',
    'Sequence Count', 'Sample Count', 'Samples',
  ];
  const memberRows: any[][] = [memberHeaders];
  for (const c of clusters) {
    for (const m of c.members) {
      memberRows.push([
        c.id, c.v_family, c.j_family, c.cdr3_length,
        m.cohortName, m.cloneId, m.cdr3_aa, m.v_gene, m.j_gene,
        m.sequence_count, m.sample_count, m.samples.join(';'),
      ]);
    }
  }
  const ws2 = XLSX.utils.aoa_to_sheet(memberRows);
  XLSX.utils.book_append_sheet(wb, ws2, 'Members');

  return wb;
}

// ---------------------------------------------------------------------------
// 4. Clones - Full Clonal Dynamics Export (XLSX, 3 sheets)
// ---------------------------------------------------------------------------

export interface ClonalDynamicsExportParams {
  dynamicsData: ClonalDynamicsData | null;
  cohortName?: string;
  controlDynamicsData?: ClonalDynamicsData | null;
  controlCohortName?: string;
  isotypeTiles: IsotypeTileEntry[];
  isotypeTimepointLabels: string[];
  controlIsotypeTiles?: IsotypeTileEntry[];
  controlIsotypeTimepointLabels?: string[];
}

/**
 * Build an XLSX workbook with three sheets:
 *   1. Frequency (Heatmap)   – per-clone frequency + raw count at each timepoint
 *   2. Clone Sizes (Bubbles) – per-clone raw counts + timepoint totals
 *   3. Isotype               – per-clone × per-timepoint isotype breakdown
 */
export function clonalDynamicsWorkbook(params: ClonalDynamicsExportParams): XLSX.WorkBook | null {
  const {
    dynamicsData, cohortName,
    controlDynamicsData, controlCohortName,
    isotypeTiles, isotypeTimepointLabels,
    controlIsotypeTiles, controlIsotypeTimepointLabels
  } = params;

  if (!dynamicsData) return null;
  const wb = XLSX.utils.book_new();
  const hasCohort = !!cohortName;
  const tpLabels = dynamicsData.timepointLabels;
  const isoTypes = ['IgM', 'IgD', 'IgG', 'IgA', 'IgE'];

  // ─── Sheet 1: Heatmap / Frequency ──────────────────────────────────
  {
    const headers = [
      ...(hasCohort ? ['Cohort'] : []),
      'Clone Rank', 'Clone ID', 'Lineage ID', 'CDR3 Amino Acid', 'V Gene', 'J Gene',
      'Status', 'Total Raw Count',
      ...tpLabels.flatMap(tp => [`${tp} Frequency`, `${tp} Raw Count`])
    ];
    const rows: any[][] = [headers];

    function pushEntries(entries: ClonalDynamicsEntry[], cName: string, labels: string[]) {
      for (const e of entries) {
        const tpMap = new Map(e.timepointSizes.map(t => [t.label, t]));
        rows.push([
          ...(hasCohort ? [cName] : []),
          e.cloneLabel, e.cloneId, e.lineageId ?? '',
          e.cdr3Aa, e.vGene, e.jGene, e.status, e.totalRawCount,
          ...labels.flatMap(tp => {
            const t = tpMap.get(tp);
            return [t ? Number(t.frequency.toFixed(6)) : 0, t ? t.rawCount : 0];
          })
        ]);
      }
    }

    pushEntries(dynamicsData.allEntries, cohortName ?? '', tpLabels);
    if (controlDynamicsData && controlCohortName) {
      pushEntries(controlDynamicsData.allEntries, controlCohortName, controlDynamicsData.timepointLabels);
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Frequency (Heatmap)');
  }

  // ─── Sheet 2: Clone Sizes (Bubbles) ───────────────────────────────
  {
    const headers = [
      ...(hasCohort ? ['Cohort'] : []),
      'Clone Rank', 'Clone ID', 'Status',
      ...tpLabels.map(tp => `${tp} Size`)
    ];
    const rows: any[][] = [headers];

    function pushBubbles(data: ClonalDynamicsData, cName: string) {
      // Summary row: timepoint totals
      rows.push([
        ...(hasCohort ? [cName] : []),
        '(Timepoint Total)', '', '',
        ...data.timepointTotals.map(t => t.total)
      ]);
      for (const e of data.allEntries) {
        const tpMap = new Map(e.timepointSizes.map(t => [t.label, t]));
        rows.push([
          ...(hasCohort ? [cName] : []),
          e.cloneLabel, e.cloneId, e.status,
          ...data.timepointLabels.map(tp => tpMap.get(tp)?.rawCount ?? 0)
        ]);
      }
    }

    pushBubbles(dynamicsData, cohortName ?? '');
    if (controlDynamicsData && controlCohortName) {
      pushBubbles(controlDynamicsData, controlCohortName);
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Clone Sizes (Bubbles)');
  }

  // ─── Sheet 3: Isotype ─────────────────────────────────────────────
  if (isotypeTiles.length > 0 || (controlIsotypeTiles && controlIsotypeTiles.length > 0)) {
    const headers = [
      ...(hasCohort ? ['Cohort'] : []),
      'Clone Rank', 'Clone ID', 'Lineage ID', 'CDR3 Amino Acid', 'V Gene', 'J Gene',
      'Status', 'Total Raw Count', 'Overall Mean SHM', 'Patient Count',
      ...isotypeTimepointLabels.flatMap(tp => [
        `${tp} Dominant Isotype`, `${tp} Seq Count`, `${tp} Mean SHM`,
        ...isoTypes.map(i => `${tp} ${i} Count`)
      ])
    ];
    const rows: any[][] = [headers];

    function pushTiles(entries: IsotypeTileEntry[], cName: string, labels: string[]) {
      for (const e of entries) {
        const tileMap = new Map(e.tiles.map(t => [t.timepointLabel, t]));
        rows.push([
          ...(hasCohort ? [cName] : []),
          e.cloneLabel, e.cloneId, e.lineageId ?? '',
          e.cdr3Aa, e.vGene, e.jGene, e.status, e.totalRawCount,
          Number(e.meanSHM.toFixed(2)), e.patientCount,
          ...labels.flatMap(tp => {
            const t = tileMap.get(tp);
            if (!t) return ['', 0, '', ...isoTypes.map(() => 0)];
            return [
              t.dominantIsotype ?? '', t.seqCount, Number(t.meanSHM.toFixed(2)),
              ...isoTypes.map(i => t.isotypeBreakdown[i] ?? 0)
            ];
          })
        ]);
      }
    }

    pushTiles(isotypeTiles, cohortName ?? '', isotypeTimepointLabels);
    if (controlIsotypeTiles && controlCohortName && controlIsotypeTimepointLabels) {
      pushTiles(controlIsotypeTiles, controlCohortName, controlIsotypeTimepointLabels);
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Isotype');
  }

  return wb;
}

// ---------------------------------------------------------------------------
// 5. COVID Database Matching Export (XLSX, 2 sheets)
// ---------------------------------------------------------------------------

/** Minimal shape we need from the timepoint mapping in this module. */
type TpMapping = Record<string, { timepoint: string; originalFile: string }>;

export interface CovidMatchExportParams {
  /** Top-20 covid matching data for the disease (or sole) cohort */
  covidData: CovidMatchData;
  cohortName?: string;
  /** Top-20 covid matching data for the control cohort */
  controlCovidData?: CovidMatchData | null;
  controlCohortName?: string;
  /** Public-clones covid matching data for the disease (or sole) cohort */
  covidDataPublic?: CovidMatchData | null;
  /** Public-clones covid matching data for the control cohort */
  controlCovidDataPublic?: CovidMatchData | null;
  /** Timepoint mappings per cohort, used to resolve which timepoint(s) a clone's files belong to */
  timepointMapping?: TpMapping;
  controlTimepointMapping?: TpMapping;
}

/** Given a clone's files and a timepoint mapping, return the sorted, deduped timepoint labels. */
function resolveCloneTimepoints(files: string[], mapping: TpMapping | undefined): string[] {
  if (!mapping) return [];
  const seen = new Set<string>();
  for (const f of files) {
    const tp = mapping[f]?.timepoint;
    if (tp) seen.add(tp);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Build an XLSX workbook with three sheets:
 *   1. Clone Summary  – one row per (cohort, source, clone) with match counts, top match,
 *                        and the timepoint(s) that clone is present in.
 *   2. All Matches    – one row per VH/CDR3 match with full antibody details, tagged with
 *                        cohort / source / timepoint(s).
 *   3. Stats Overview – cohort × source × timepoint pivot: total analyzed, high matches, %.
 */
export function covidMatchWorkbook(params: CovidMatchExportParams): XLSX.WorkBook {
  const {
    covidData, cohortName, controlCovidData, controlCohortName,
    covidDataPublic, controlCovidDataPublic,
    timepointMapping, controlTimepointMapping
  } = params;
  const wb = XLSX.utils.book_new();
  const hasCohort = !!cohortName && !!controlCovidData;
  // Only emit the "Source" column if at least one public-clones dataset is present
  const hasPublic = !!(covidDataPublic || controlCovidDataPublic);

  type Scope = {
    data: CovidMatchData | null | undefined;
    cohortLabel: string;
    sourceLabel: 'Top 20' | 'Public clones';
    mapping: TpMapping | undefined;
  };
  const scopes: Scope[] = [
    { data: covidData, cohortLabel: cohortName ?? '', sourceLabel: 'Top 20', mapping: timepointMapping },
    { data: covidDataPublic, cohortLabel: cohortName ?? '', sourceLabel: 'Public clones', mapping: timepointMapping },
    { data: controlCovidData, cohortLabel: controlCohortName ?? '', sourceLabel: 'Top 20', mapping: controlTimepointMapping },
    { data: controlCovidDataPublic, cohortLabel: controlCohortName ?? '', sourceLabel: 'Public clones', mapping: controlTimepointMapping },
  ].filter(s => s.data) as Scope[];

  // ─── Sheet 1: Clone Summary ────────────────────────────────────────
  {
    const headers = [
      ...(hasCohort ? ['Cohort'] : []),
      ...(hasPublic ? ['Source'] : []),
      'Timepoints',
      'Clone ID', 'Clone Size', 'CDR3 AA (IMGT)', 'CDR3 AA (AIRR)', 'VH AA',
      'V Gene', 'J Gene', 'Files',
      'VH Matches', 'CDR3 Matches', 'Has High VH Match', 'Has High CDR3 Match',
      'Best VH Match Antibody', 'Best VH Match Identity %',
      'Best CDR3 Match Antibody', 'Best CDR3 Match Identity %'
    ];
    const rows: any[][] = [headers];

    for (const scope of scopes) {
      if (!scope.data) continue;
      for (const c of scope.data.top_clones) {
        const bestVH = c.vh_matches.length > 0
          ? c.vh_matches.reduce((a, b) => a.identity > b.identity ? a : b)
          : null;
        const bestCDR3 = c.cdr3_matches.length > 0
          ? c.cdr3_matches.reduce((a, b) => a.identity > b.identity ? a : b)
          : null;
        const tps = resolveCloneTimepoints(c.files, scope.mapping);
        rows.push([
          ...(hasCohort ? [scope.cohortLabel] : []),
          ...(hasPublic ? [scope.sourceLabel] : []),
          tps.join(', '),
          c.clone_id, c.size, c.cdr3_aa, c.cdr3_aa_raw, c.vh_aa,
          c.v_gene, c.j_gene, c.files.join('; '),
          c.vh_matches.length, c.cdr3_matches.length,
          c.has_high_vh_match ? 'Yes' : 'No',
          c.has_high_cdr3_match ? 'Yes' : 'No',
          bestVH?.antibody_name ?? '', bestVH ? Number(bestVH.identity.toFixed(1)) : '',
          bestCDR3?.antibody_name ?? '', bestCDR3 ? Number(bestCDR3.identity.toFixed(1)) : ''
        ]);
      }
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Clone Summary');
  }

  // ─── Sheet 2: All Matches (detailed) ──────────────────────────────
  {
    const headers = [
      ...(hasCohort ? ['Cohort'] : []),
      ...(hasPublic ? ['Source'] : []),
      'Timepoints',
      'Clone ID', 'Clone Size', 'Match Type',
      'Antibody Name', 'Identity %',
      'Binds To', 'Neutralizes', 'Origin', 'Antibody Type',
      'DB V Gene', 'DB J Gene',
      'Query CDR3 AA', 'Clone V Gene', 'Clone J Gene'
    ];
    const rows: any[][] = [headers];

    for (const scope of scopes) {
      if (!scope.data) continue;
      for (const c of scope.data.top_clones) {
        const tps = resolveCloneTimepoints(c.files, scope.mapping).join(', ');
        for (const m of c.vh_matches) {
          rows.push([
            ...(hasCohort ? [scope.cohortLabel] : []),
            ...(hasPublic ? [scope.sourceLabel] : []),
            tps,
            c.clone_id, c.size, 'VH',
            m.antibody_name, Number(m.identity.toFixed(1)),
            m.db_info.binds_to, m.db_info.neutralizes, m.db_info.origin, m.db_info.ab_or_nb,
            m.db_info.v_gene, m.db_info.j_gene,
            c.cdr3_aa, c.v_gene, c.j_gene
          ]);
        }
        for (const m of c.cdr3_matches) {
          rows.push([
            ...(hasCohort ? [scope.cohortLabel] : []),
            ...(hasPublic ? [scope.sourceLabel] : []),
            tps,
            c.clone_id, c.size, 'CDR3',
            m.antibody_name, Number(m.identity.toFixed(1)),
            m.db_info.binds_to, m.db_info.neutralizes, m.db_info.origin, m.db_info.ab_or_nb,
            m.db_info.v_gene, m.db_info.j_gene,
            c.cdr3_aa, c.v_gene, c.j_gene
          ]);
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'All Matches');
  }

  // ─── Sheet 3: Stats Overview (cohort × source × timepoint) ────────
  {
    // Collect all timepoints that appear in any scope so columns are consistent
    const allTps = new Set<string>();
    for (const scope of scopes) {
      if (!scope.data) continue;
      for (const c of scope.data.top_clones) {
        for (const tp of resolveCloneTimepoints(c.files, scope.mapping)) allTps.add(tp);
      }
    }
    const tpList = Array.from(allTps).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const headers = [
      ...(hasCohort ? ['Cohort'] : []),
      ...(hasPublic ? ['Source'] : []),
      'Timepoint',
      'Clones Analyzed', 'VH Matches', 'CDR3 Matches', 'High Matches (≥90%)', 'High-Match %'
    ];
    const rows: any[][] = [headers];

    function statsFor(clones: CovidMatchData['top_clones']) {
      const total = clones.length;
      const vh = clones.filter(c => c.vh_matches.length > 0).length;
      const cdr3 = clones.filter(c => c.cdr3_matches.length > 0).length;
      const high = clones.filter(c => c.has_high_vh_match || c.has_high_cdr3_match).length;
      const pct = total > 0 ? Number(((high / total) * 100).toFixed(1)) : 0;
      return [total, vh, cdr3, high, pct];
    }

    for (const scope of scopes) {
      if (!scope.data) continue;
      // Row for "All timepoints"
      rows.push([
        ...(hasCohort ? [scope.cohortLabel] : []),
        ...(hasPublic ? [scope.sourceLabel] : []),
        'All',
        ...statsFor(scope.data.top_clones)
      ]);
      // Per-timepoint rows, only when we can resolve timepoints
      if (tpList.length > 0 && scope.mapping) {
        for (const tp of tpList) {
          const filtered = scope.data.top_clones.filter(c =>
            resolveCloneTimepoints(c.files, scope.mapping).includes(tp)
          );
          if (filtered.length === 0) continue;
          rows.push([
            ...(hasCohort ? [scope.cohortLabel] : []),
            ...(hasPublic ? [scope.sourceLabel] : []),
            tp,
            ...statsFor(filtered)
          ]);
        }
      }
    }

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Stats Overview');
  }

  return wb;
}
