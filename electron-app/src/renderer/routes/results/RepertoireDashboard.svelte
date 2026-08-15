<script lang="ts">
  import { resultsState, studyDesign, saveDepthNormalization, type StudyDesign, type TimepointMapping, type FileGroup, type CohortResults, GROUP_COLORS } from '../../lib/stores/app';
  import {
    computeAllMetrics,
    computePerFileMetrics,
    computePerSampleMetrics,
    type GroupTimepointMetrics
  } from '../../lib/utils/repertoire-metrics';
  import DiversityChart from '../../lib/components/visualizations/DiversityChart.svelte';
  import VGeneChart from '../../lib/components/visualizations/VGeneChart.svelte';
  import ExpansionChart from '../../lib/components/visualizations/ExpansionChart.svelte';
  import IsotypeChart from '../../lib/components/visualizations/IsotypeChart.svelte';
  import VGeneHeatmap from '../../lib/components/visualizations/VGeneHeatmap.svelte';
  import GroupComparisonChart from '../../lib/components/visualizations/GroupComparisonChart.svelte';
  import IsotypeComparisonChart from '../../lib/components/visualizations/IsotypeComparisonChart.svelte';
  import PerPatientTrajectoryChart from '../../lib/components/visualizations/PerPatientTrajectoryChart.svelte';
  import SequencingDepthPanel from '../../lib/components/visualizations/SequencingDepthPanel.svelte';
  import {
    rarefyDonor, suggestDepth,
    DEFAULT_REPLICATES, DEFAULT_SEED, MIN_USEFUL_DEPTH,
    type RarefactionSettings
  } from '../../lib/utils/rarefaction';

  function buildDesignFromTimepointMapping(tpMapping: TimepointMapping, fileGroups: FileGroup[]): StudyDesign {
    const fileGroupNames = new Set(fileGroups.map(fg => fg.filename));
    const tpMap = new Map<string, string[]>();
    const tpOrder: string[] = [];
    for (const [stagedFile, entry] of Object.entries(tpMapping)) {
      if (!fileGroupNames.has(stagedFile)) continue;
      if (!tpMap.has(entry.timepoint)) {
        tpMap.set(entry.timepoint, []);
        tpOrder.push(entry.timepoint);
      }
      tpMap.get(entry.timepoint)!.push(stagedFile);
    }
    if (tpMap.size === 0) return { groups: [], unassigned: [] };
    return {
      groups: [{
        id: 'cohort-auto',
        name: 'All Samples',
        color: GROUP_COLORS[0],
        timepoints: tpOrder.map((label, i) => ({
          id: `tp-${i}`,
          label,
          order: i,
          files: tpMap.get(label) || []
        }))
      }],
      unassigned: []
    };
  }

  // ── Cohort awareness ─────────────────────────────────────
  $: hasCohorts = $resultsState.cohortResults.length > 0;
  $: diseaseCohort = $resultsState.cohortResults.find(c => c.cohortType === 'disease') || null;
  $: controlCohort = $resultsState.cohortResults.find(c => c.cohortType === 'control') || null;

  // ── Designs per cohort ──────────────────────────────────
  $: diseaseDesign = diseaseCohort
    ? buildDesignFromTimepointMapping(diseaseCohort.timepointMapping, diseaseCohort.fileGroups)
    : { groups: [], unassigned: [] } as StudyDesign;
  $: controlDesign = controlCohort
    ? buildDesignFromTimepointMapping(controlCohort.timepointMapping, controlCohort.fileGroups)
    : { groups: [], unassigned: [] } as StudyDesign;

  // Single-cohort mode (no control)
  $: singleDesign = hasCohorts ? diseaseDesign : $studyDesign;
  $: singleFileGroups = hasCohorts ? (diseaseCohort?.fileGroups ?? []) : $resultsState.fileGroups;
  $: singleSequences = hasCohorts ? (diseaseCohort?.sequences ?? []) : $resultsState.sequences;

  // ── Section collapse state ───────────────────────────────
  let perTimepointOpen = true;
  let perSampleComparisonOpen = true;
  let groupComparisonOpen = true;
  let perCohortCompositionOpen = true;
  let perCohortDrilldownOpen = true;

  // ── Disease metrics ──────────────────────────────────────
  let diseaseMetrics: GroupTimepointMetrics[] = [];
  let diseaseHasDesign = false;

  $: {
    if (hasCohorts && diseaseCohort) {
      diseaseHasDesign = diseaseDesign.groups.length > 0;
      diseaseMetrics = diseaseHasDesign
        ? computeAllMetrics(diseaseDesign, diseaseCohort.sequences, diseaseCohort.fileGroups)
        : computePerFileMetrics(diseaseCohort.fileGroups);
    } else if (!hasCohorts) {
      diseaseHasDesign = singleDesign.groups.length > 0;
      diseaseMetrics = diseaseHasDesign
        ? computeAllMetrics(singleDesign, singleSequences, singleFileGroups)
        : computePerFileMetrics(singleFileGroups);
    }
  }

  // ── Control metrics (only when cohorts exist) ────────────
  let controlMetrics: GroupTimepointMetrics[] = [];
  let controlHasDesign = false;

  $: {
    if (hasCohorts && controlCohort) {
      controlHasDesign = controlDesign.groups.length > 0;
      controlMetrics = controlHasDesign
        ? computeAllMetrics(controlDesign, controlCohort.sequences, controlCohort.fileGroups)
        : computePerFileMetrics(controlCohort.fileGroups);
    } else {
      controlMetrics = [];
    }
  }

  // ── Timepoint filters (independent per cohort) ───────────
  let diseaseEnabledTimepoints = new Set<string>();
  let controlEnabledTimepoints = new Set<string>();
  let diseaseTimepointsInit = false;
  let controlTimepointsInit = false;

  $: diseaseUniqueTimepoints = [...new Set(diseaseMetrics.map(m => m.timepointLabel))];
  $: controlUniqueTimepoints = [...new Set(controlMetrics.map(m => m.timepointLabel))];

  $: {
    if (!diseaseTimepointsInit && diseaseMetrics.length > 0) {
      diseaseEnabledTimepoints = new Set(diseaseMetrics.map(m => m.timepointLabel));
      diseaseTimepointsInit = true;
    }
  }
  $: {
    if (!controlTimepointsInit && controlMetrics.length > 0) {
      controlEnabledTimepoints = new Set(controlMetrics.map(m => m.timepointLabel));
      controlTimepointsInit = true;
    }
  }

  function toggleDiseaseTimepoint(label: string) {
    if (diseaseEnabledTimepoints.has(label)) diseaseEnabledTimepoints.delete(label);
    else diseaseEnabledTimepoints.add(label);
    diseaseEnabledTimepoints = new Set(diseaseEnabledTimepoints);
  }
  function toggleControlTimepoint(label: string) {
    if (controlEnabledTimepoints.has(label)) controlEnabledTimepoints.delete(label);
    else controlEnabledTimepoints.add(label);
    controlEnabledTimepoints = new Set(controlEnabledTimepoints);
  }

  $: filteredDiseaseMetrics = diseaseMetrics.filter(m => diseaseEnabledTimepoints.has(m.timepointLabel));
  $: filteredControlMetrics = controlMetrics.filter(m => controlEnabledTimepoints.has(m.timepointLabel));

  // ── Summary stats ────────────────────────────────────────
  function sumStat(metrics: GroupTimepointMetrics[], key: 'totalSequences' | 'uniqueClones') {
    return metrics.reduce((a, m) => a + m.diversity[key], 0);
  }
  function avgStat(metrics: GroupTimepointMetrics[], key: 'shannonEntropy' | 'meanSHM') {
    if (metrics.length === 0) return 0;
    return metrics.reduce((a, m) => a + m.diversity[key], 0) / metrics.length;
  }

  // ── Per-sample metrics ───────────────────────────────────
  $: diseasePerSampleMetrics = computePerSampleMetrics(
    diseaseHasDesign ? (hasCohorts ? diseaseDesign : singleDesign) : null,
    hasCohorts ? (diseaseCohort?.fileGroups ?? []) : singleFileGroups,
    new Set(diseaseMetrics.map(m => m.groupId)),
    diseaseEnabledTimepoints
  );
  $: controlPerSampleMetrics = hasCohorts ? computePerSampleMetrics(
    controlHasDesign ? controlDesign : null,
    controlCohort?.fileGroups ?? [],
    new Set(controlMetrics.map(m => m.groupId)),
    controlEnabledTimepoints
  ) : [];

  // Per-sample enabled state
  let diseaseEnabledSamples = new Set<string>();
  let controlEnabledSamples = new Set<string>();
  let prevDiseaseSampleNames = new Set<string>();
  let prevControlSampleNames = new Set<string>();

  $: if (diseasePerSampleMetrics.length > 0) {
    const valid = new Set(diseasePerSampleMetrics.map(m => m.groupName));
    const next = new Set(diseaseEnabledSamples);
    for (const s of [...next]) { if (!valid.has(s)) next.delete(s); }
    for (const s of valid) { if (!prevDiseaseSampleNames.has(s)) next.add(s); }
    prevDiseaseSampleNames = valid;
    diseaseEnabledSamples = next.size > 0 ? next : new Set(valid);
  } else { prevDiseaseSampleNames = new Set(); diseaseEnabledSamples = new Set(); }

  $: if (controlPerSampleMetrics.length > 0) {
    const valid = new Set(controlPerSampleMetrics.map(m => m.groupName));
    const next = new Set(controlEnabledSamples);
    for (const s of [...next]) { if (!valid.has(s)) next.delete(s); }
    for (const s of valid) { if (!prevControlSampleNames.has(s)) next.add(s); }
    prevControlSampleNames = valid;
    controlEnabledSamples = next.size > 0 ? next : new Set(valid);
  } else { prevControlSampleNames = new Set(); controlEnabledSamples = new Set(); }

  $: filteredDiseasePerSample = diseasePerSampleMetrics.filter(m => diseaseEnabledSamples.has(m.groupName));
  $: filteredControlPerSample = controlPerSampleMetrics.filter(m => controlEnabledSamples.has(m.groupName));

  // ── Depth normalisation ──────────────────────────────────
  // Off by default. While it is off nothing below may change, so the rarefied
  // arrays are simply not computed and the charts fall back to the originals.
  let normalizeDepth = false;
  let normDepth = MIN_USEFUL_DEPTH;
  let depthInitialized = false;

  /** Clone-assigned depth of every donor currently in the comparison. */
  $: comparisonDepths = [
    ...diseasePerSampleMetrics.map(m => m.diversity.clonedSequences),
    ...controlPerSampleMetrics.map(m => m.diversity.clonedSequences),
  ].filter(d => d > 0);

  $: depthSuggestion = suggestDepth(comparisonDepths);

  // Seed the field from the suggestion exactly once, then leave it alone.
  // Tracking "has the user edited this" instead and re-asserting the
  // suggestion on every pass is the obvious alternative and it fights the
  // input: suggestDepth() returns a fresh object each time, so that statement
  // re-runs constantly and any missed edit flag silently overwrites what was
  // typed. Setting it once cannot do that. The reset button below is the
  // explicit way back.
  $: if (!depthInitialized && depthSuggestion.total > 0) {
    normDepth = depthSuggestion.depth;
    depthInitialized = true;
  }

  $: rarefaction = {
    enabled: normalizeDepth,
    depth: normDepth,
    replicates: DEFAULT_REPLICATES,
    seed: DEFAULT_SEED,
  } as RarefactionSettings;

  const rarefyFn = (depth: number) => (seqs: any[], key: string) =>
    rarefyDonor(seqs, depth, key, DEFAULT_REPLICATES, DEFAULT_SEED);

  $: diseasePerSampleRarefied = normalizeDepth ? computePerSampleMetrics(
    diseaseHasDesign ? (hasCohorts ? diseaseDesign : singleDesign) : null,
    hasCohorts ? (diseaseCohort?.fileGroups ?? []) : singleFileGroups,
    new Set(diseaseMetrics.map(m => m.groupId)),
    diseaseEnabledTimepoints,
    rarefyFn(normDepth)
  ) : [];

  $: controlPerSampleRarefied = (normalizeDepth && hasCohorts) ? computePerSampleMetrics(
    controlHasDesign ? controlDesign : null,
    controlCohort?.fileGroups ?? [],
    new Set(controlMetrics.map(m => m.groupId)),
    controlEnabledTimepoints,
    rarefyFn(normDepth)
  ) : [];

  /** Retention per group and timepoint, which is what the user has to see. */
  $: retentionRows = (() => {
    const tps = [...new Set([
      ...diseasePerSampleMetrics.map(m => m.timepointLabel),
      ...controlPerSampleMetrics.map(m => m.timepointLabel),
    ])].sort();
    const count = (arr: GroupTimepointMetrics[], tp: string, min: number) =>
      arr.filter(m => m.timepointLabel === tp && m.diversity.clonedSequences >= min).length;
    return tps.map(tp => ({
      tp,
      diseaseKept: count(diseasePerSampleMetrics, tp, normDepth),
      diseaseTotal: diseasePerSampleMetrics.filter(m => m.timepointLabel === tp).length,
      controlKept: count(controlPerSampleMetrics, tp, normDepth),
      controlTotal: controlPerSampleMetrics.filter(m => m.timepointLabel === tp).length,
    }));
  })();

  $: anyTimepointTooThin = retentionRows.some(r =>
    (r.diseaseTotal > 0 && r.diseaseKept < 3) || (r.controlTotal > 0 && r.controlKept < 3));

  // Carry the setting with the session so a restored run comes back showing
  // what it was last read at, rather than silently reverting to off.
  $: {
    const dir = $resultsState.outputDir;
    if (dir) saveDepthNormalization(dir, { ...rarefaction });
  }

  // ── N-cohort generalization ────────────────────────────────
  // When 3+ cohorts are present (e.g. mouse 4 treatment groups), build per-
  // cohort per-sample metrics and feed them to GroupComparisonChart's
  // N-cohort path via the new `cohortsData` prop. The legacy 2-cohort flow
  // (Long-COVID disease vs control) stays unchanged.
  $: allCohorts = $resultsState.cohortResults;

  /** Per-cohort aggregated (per-timepoint pooled) metrics: one array per cohort. */
  $: allCohortAggregatedMetrics = allCohorts.map((c, idx) => {
    const design = buildDesignFromTimepointMapping(c.timepointMapping, c.fileGroups);
    const metrics = design.groups.length > 0
      ? computeAllMetrics(design, c.sequences, c.fileGroups)
      : computePerFileMetrics(c.fileGroups);
    return {
      name: c.cohortName || c.cohortType,
      color: GROUP_COLORS[idx % GROUP_COLORS.length],
      metrics,
    };
  });

  /** Per-cohort per-sample metrics: one entry per cohort. */
  $: allCohortPerSampleMetrics = allCohorts.map((c, idx) => {
    const design = buildDesignFromTimepointMapping(c.timepointMapping, c.fileGroups);
    const cohortMetrics = design.groups.length > 0
      ? computeAllMetrics(design, c.sequences, c.fileGroups)
      : computePerFileMetrics(c.fileGroups);
    const enabledTps = new Set(cohortMetrics.map(m => m.timepointLabel));
    const perSample = computePerSampleMetrics(
      design.groups.length > 0 ? design : null,
      c.fileGroups,
      new Set(cohortMetrics.map(m => m.groupId)),
      enabledTps
    );
    return {
      name: c.cohortName || c.cohortType,
      color: GROUP_COLORS[idx % GROUP_COLORS.length],
      data: perSample
    };
  });

  /** Same as allCohorts but only includes cohorts that actually have data. */
  $: nonEmptyCohortsData = allCohortPerSampleMetrics.filter(c => c.data.length > 0);
  /** Switch to N-cohort UI when ≥3 cohorts. ≤2 keeps the original disease/control layout. */
  $: useNCohortLayout = nonEmptyCohortsData.length > 2;

  /**
   * One synthetic GroupTimepointMetrics per cohort, pooled across all samples
   * of that cohort. Used to feed the existing IsotypeChart (donut grid) and
   * the new V-gene heatmap with a single row per cohort.
   *
   * Counts (isotype, V-gene, sequences, clones) are summed across samples;
   * derived ratios (Shannon, Gini, SHM) are sample-averaged. This is a rough
   * pooled view, for per-sample-weighted comparisons use GroupComparisonChart.
   */
  $: cohortPooledMetrics = nonEmptyCohortsData.map((c) => poolCohortMetrics(c.data, c.name, c.color));

  function poolCohortMetrics(perSample: GroupTimepointMetrics[], name: string, color: string): GroupTimepointMetrics {
    const isoMap = new Map<string, number>();
    for (const m of perSample) for (const f of m.isotypeFreqs) {
      isoMap.set(f.isotype, (isoMap.get(f.isotype) ?? 0) + f.count);
    }
    const isoTotal = [...isoMap.values()].reduce((a, b) => a + b, 0) || 1;
    const isotypeFreqs = [...isoMap.entries()].map(([isotype, count]) => ({
      isotype, count, frequency: count / isoTotal
    }));

    const vMap = new Map<string, number>();
    for (const m of perSample) for (const f of m.vGeneFreqs) {
      vMap.set(f.family, (vMap.get(f.family) ?? 0) + f.count);
    }
    const vTotal = [...vMap.values()].reduce((a, b) => a + b, 0) || 1;
    const vGeneFreqs = [...vMap.entries()]
      .map(([family, count]) => ({ family, count, frequency: count / vTotal }))
      .sort((a, b) => b.frequency - a.frequency);

    const n = perSample.length || 1;
    const sum = (k: keyof GroupTimepointMetrics['diversity']) =>
      perSample.reduce((a, m) => a + (m.diversity[k] as number), 0);
    const avg = (k: keyof GroupTimepointMetrics['diversity']) => sum(k) / n;

    return {
      groupId: 'cohort-pool',
      groupName: name,
      groupColor: color,
      timepointId: 'pool',
      timepointLabel: '',
      diversity: {
        totalSequences: sum('totalSequences'),
        clonedSequences: sum('clonedSequences'),
        uniqueClones: sum('uniqueClones'),
        meanCloneSize: avg('meanCloneSize'),
        shannonEntropy: avg('shannonEntropy'),
        chao1: sum('chao1'),
        giniIndex: avg('giniIndex'),
        simpsonIndex: avg('simpsonIndex'),
        d50: Math.round(avg('d50')),
        meanSHM: avg('meanSHM'),
        medianSHM: avg('medianSHM'),
        productivePercent: avg('productivePercent'),
        expandedCloneFraction: avg('expandedCloneFraction'),
        top1CloneFraction: avg('top1CloneFraction'),
        top10CloneFraction: avg('top10CloneFraction'),
      },
      vGeneFreqs,
      rankAbundance: [],
      isotypeFreqs,
    };
  }

  // ── Per-cohort drilldown ────────────────────────────────
  /** Index into nonEmptyCohortsData of the cohort selected for per-mouse drilldown. */
  let drilldownCohortIdx = 0;
  $: if (useNCohortLayout && drilldownCohortIdx >= nonEmptyCohortsData.length) drilldownCohortIdx = 0;
  $: drilldownCohort = useNCohortLayout && nonEmptyCohortsData[drilldownCohortIdx]
    ? nonEmptyCohortsData[drilldownCohortIdx]
    : null;

  /** True when only one timepoint label exists across all cohorts.
   *  Drives whether longitudinal/over-time views are shown. */
  $: isSingleTimepoint = (() => {
    const tps = new Set<string>();
    for (const c of allCohorts) for (const fname of Object.keys(c.timepointMapping)) {
      const tp = c.timepointMapping[fname]?.timepoint;
      if (tp) tps.add(tp);
    }
    // Single-cohort mode: check the global mapping
    if (!hasCohorts) {
      for (const fname of Object.keys($resultsState.timepointMapping)) {
        const tp = $resultsState.timepointMapping[fname]?.timepoint;
        if (tp) tps.add(tp);
      }
    }
    return tps.size <= 1;
  })();

  function toggleDiseaseSample(name: string) {
    if (diseaseEnabledSamples.has(name)) diseaseEnabledSamples.delete(name);
    else diseaseEnabledSamples.add(name);
    diseaseEnabledSamples = new Set(diseaseEnabledSamples);
  }
  function toggleControlSample(name: string) {
    if (controlEnabledSamples.has(name)) controlEnabledSamples.delete(name);
    else controlEnabledSamples.add(name);
    controlEnabledSamples = new Set(controlEnabledSamples);
  }

  // Group samples by timepoint for hierarchical selector
  interface TimepointGroup { label: string; samples: GroupTimepointMetrics[]; }
  function groupByTimepoint(metrics: GroupTimepointMetrics[]): TimepointGroup[] {
    const map = new Map<string, GroupTimepointMetrics[]>();
    const order: string[] = [];
    for (const m of metrics) {
      if (!map.has(m.timepointLabel)) { map.set(m.timepointLabel, []); order.push(m.timepointLabel); }
      map.get(m.timepointLabel)!.push(m);
    }
    return order.map(label => ({ label, samples: map.get(label)! }));
  }
  $: diseaseSampleGroups = groupByTimepoint(diseasePerSampleMetrics);
  $: controlSampleGroups = groupByTimepoint(controlPerSampleMetrics);

  function toggleAllSamplesInTp(tpGroup: TimepointGroup, enabledSet: Set<string>, setter: (s: Set<string>) => void) {
    const names = tpGroup.samples.map(m => m.groupName);
    const allOn = names.every(n => enabledSet.has(n));
    const next = new Set(enabledSet);
    if (allOn) { for (const n of names) next.delete(n); }
    else { for (const n of names) next.add(n); }
    setter(next);
  }

  const METRIC_TOOLTIPS: Record<string, string> = {
    Sequences: 'Total number of sequences in the sample.',
    Clones: 'Number of unique clonotypes (clusters of related sequences).',
    Shannon: 'Shannon entropy: diversity measure. Higher = more diverse repertoire.',
    Chao1: 'Chao1 richness estimator: predicts total clone diversity from singletons/doubletons.',
    Gini: 'Gini index: clonal inequality. 0 = even distribution, 1 = one clone dominates.',
    Simpson: 'Simpson diversity index: probability two random sequences are from different clones.',
    'Mean SHM': 'Mean somatic hypermutation count per sequence (affinity maturation level).',
    D50: 'Number of largest clones needed to cover 50% of sequences. Lower = more focused response.',
    Productive: 'Percentage of productive (in-frame) sequences.'
  };

  const COHORT_COLOR_DISEASE = '#1565C0';
  const COHORT_COLOR_CONTROL = '#757575';

  // ── Export ─────────────────────────────────────────────
  import { dashboardMetricsToCsv, dashboardPerPatientCsv, downloadCsv } from '../../lib/utils/export-csv';
  import { downloadSvg, downloadPng } from '../../lib/utils/publication-export';

  let isExportingDashboard = false;
  let isExportingPerPatient = false;
  let isExportingPublication = false;
  /** When true, charts render in publication mode (larger fonts, more spacing) */
  let publicationMode = false;

  /** Export dropdown state */
  let showExportMenu = false;

  interface PubFigureOption {
    id: string;
    label: string;
    selector: string;
    filename: string;
  }

  /** Figures that always appear (cross-cohort boxplots from Group Comparison). */
  const PUB_FIG_BOXPLOTS: PubFigureOption[] = [
    { id: 'shannon', label: 'Shannon Entropy', selector: '#group-comparison-chart svg[data-metric="shannon"]', filename: 'boxplot_shannon_entropy' },
    { id: 'simpson', label: 'Simpson Index', selector: '#group-comparison-chart svg[data-metric="simpson"]', filename: 'boxplot_simpson_index' },
    { id: 'chao1', label: 'Chao1', selector: '#group-comparison-chart svg[data-metric="chao1"]', filename: 'boxplot_chao1' },
    { id: 'meanSHM', label: 'Mean SHM', selector: '#group-comparison-chart svg[data-metric="meanSHM"]', filename: 'boxplot_mean_shm' },
    { id: 'gini', label: 'Gini Index', selector: '#group-comparison-chart svg[data-metric="gini"]', filename: 'boxplot_gini_index' },
    { id: 'expandedFrac', label: '% Expanded Clones', selector: '#group-comparison-chart svg[data-metric="expandedFrac"]', filename: 'boxplot_expanded_clones' },
    { id: 'top1Frac', label: '% Top-1 Clone', selector: '#group-comparison-chart svg[data-metric="top1Frac"]', filename: 'boxplot_top1_clone' },
    { id: 'top10Frac', label: '% Top-10 Clones', selector: '#group-comparison-chart svg[data-metric="top10Frac"]', filename: 'boxplot_top10_clones' },
  ];

  /** Longitudinal figures, only rendered when ≥2 timepoints exist. */
  const PUB_FIG_LONGITUDINAL: PubFigureOption[] = [
    { id: 'isotype', label: 'Isotype Composition (per-sample mean)', selector: '#isotype-comparison-chart svg', filename: 'isotype_comparison' },
    { id: 'trajectory', label: 'Diversity Trajectory', selector: '#per-patient-trajectory-chart svg', filename: 'diversity_trajectory' },
  ];

  /** N-cohort composition figures, only rendered with 3+ cohorts. */
  const PUB_FIG_NCOHORT: PubFigureOption[] = [
    { id: 'cohortIsotype', label: 'Isotype Donut Grid (per cohort)', selector: '#cohort-isotype-grid svg', filename: 'isotype_per_cohort' },
    { id: 'cohortVgene', label: 'V-Gene Usage Heatmap (per cohort)', selector: '#cohort-vgene-heatmap svg', filename: 'vgene_heatmap_per_cohort' },
  ];

  /** Reactive list of figures actually available on the current dashboard. */
  $: availableFigures = [
    ...PUB_FIG_BOXPLOTS,
    ...(useNCohortLayout ? PUB_FIG_NCOHORT : []),
    ...(!isSingleTimepoint && !useNCohortLayout ? PUB_FIG_LONGITUDINAL : []),
  ];

  async function exportPublicationFigure(fig: PubFigureOption, format: 'svg' | 'png') {
    isExportingPublication = true;
    showExportMenu = false;
    try {
      // Enable publication mode so charts redraw at larger size
      publicationMode = true;

      // Temporarily show hidden sections so styles can be computed for export
      const hiddenSections = document.querySelectorAll('.section-hidden');
      hiddenSections.forEach(el => (el as HTMLElement).style.display = 'block');

      // Allow layout to settle and charts to redraw in publication mode
      await new Promise(r => setTimeout(r, 150));

      const chartEl = document.querySelector(fig.selector) as SVGSVGElement | null;
      if (!chartEl) {
        hiddenSections.forEach(el => (el as HTMLElement).style.display = '');
        publicationMode = false;
        alert(`Chart not found. Make sure data is loaded.`);
        return;
      }
      if (format === 'svg') {
        downloadSvg(chartEl, `${fig.filename}.svg`);
      } else {
        await downloadPng(chartEl, `${fig.filename}.png`, 3);
      }

      // Re-hide sections and disable publication mode
      hiddenSections.forEach(el => (el as HTMLElement).style.display = '');
      publicationMode = false;
    } catch (err: any) {
      // Ensure sections are re-hidden on error
      document.querySelectorAll('.section-hidden').forEach(el => (el as HTMLElement).style.display = '');
      publicationMode = false;
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      isExportingPublication = false;
    }
  }

  async function exportDashboard() {
    isExportingDashboard = true;
    try {
      const extraCohorts = useNCohortLayout
        ? allCohortAggregatedMetrics.map(c => ({ name: c.name, metrics: c.metrics }))
        : [];
      const csv = dashboardMetricsToCsv(
        useNCohortLayout ? [] : diseaseMetrics,
        useNCohortLayout ? [] : controlMetrics,
        hasCohorts ? (diseaseCohort?.cohortName ?? 'Disease') : 'All Samples',
        controlCohort?.cohortName ?? 'Control',
        [],
        [],
        extraCohorts
      );
      await downloadCsv(csv, 'repertoire_dashboard_metrics.csv');
    } catch (err: any) {
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      isExportingDashboard = false;
    }
  }

  async function exportPerPatient() {
    isExportingPerPatient = true;
    try {
      const extraCohorts = useNCohortLayout
        ? allCohorts.map(c => ({
            name: c.cohortName || c.cohortType,
            fileGroups: c.fileGroups,
            timepointMapping: c.timepointMapping,
          }))
        : undefined;
      const csv = dashboardPerPatientCsv({
        diseaseFileGroups: useNCohortLayout ? [] : (hasCohorts ? (diseaseCohort?.fileGroups ?? []) : singleFileGroups),
        diseaseTimepointMapping: useNCohortLayout
          ? {}
          : (hasCohorts ? (diseaseCohort?.timepointMapping ?? {}) : ($resultsState.timepointMapping ?? {})),
        diseaseCohortName: hasCohorts ? (diseaseCohort?.cohortName ?? 'Disease') : 'All Samples',
        controlFileGroups: !useNCohortLayout && hasCohorts ? (controlCohort?.fileGroups ?? undefined) : undefined,
        controlTimepointMapping: !useNCohortLayout && hasCohorts ? (controlCohort?.timepointMapping ?? undefined) : undefined,
        controlCohortName: !useNCohortLayout && hasCohorts ? (controlCohort?.cohortName ?? 'Control') : undefined,
        extraCohorts,
        normalization: rarefaction,
      });
      await downloadCsv(csv, 'repertoire_per_patient_metrics.csv');
    } catch (err: any) {
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      isExportingPerPatient = false;
    }
  }
</script>

<div class="dashboard">
  <div class="dash-header">
    <h2 class="dash-title">Repertoire Dashboard</h2>
    {#if diseaseMetrics.length > 0 || controlMetrics.length > 0 || nonEmptyCohortsData.length > 0}
      <div class="dash-export-group">
        <button
          class="export-view-btn"
          on:click={exportDashboard}
          disabled={isExportingDashboard}
          title="Export aggregated metrics (one row per timepoint)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {isExportingDashboard ? '...' : 'Export Aggregated'}
        </button>
        <button
          class="export-view-btn"
          on:click={exportPerPatient}
          disabled={isExportingPerPatient}
          title="Export per-sample metrics (one row per sample × timepoint)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {isExportingPerPatient ? '...' : 'Export Per-Sample'}
        </button>
        <div class="export-dropdown-wrapper">
          <button
            class="export-view-btn export-pub-btn"
            on:click={() => { showExportMenu = !showExportMenu; }}
            disabled={isExportingPublication}
            title="Export publication-ready figures"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 2h12v12H2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
              <path d="M5 8h6M8 5v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            {isExportingPublication ? '...' : 'Publication Figure'}
          </button>
          {#if showExportMenu}
            <div class="export-dropdown">
              {#each availableFigures as fig}
                <div class="export-dropdown-group">
                  <span class="export-dropdown-label">{fig.label}</span>
                  <div class="export-dropdown-actions">
                    <button class="export-dropdown-item" on:click={() => exportPublicationFigure(fig, 'svg')}>
                      SVG
                    </button>
                    <button class="export-dropdown-item" on:click={() => exportPublicationFigure(fig, 'png')}>
                      PNG
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if diseaseMetrics.length === 0 && controlMetrics.length === 0 && nonEmptyCohortsData.length === 0}
    <div class="empty-state">
      <p>No data available yet. Run an analysis first.</p>
    </div>
  {:else}

    <!-- ════════════════════════════════════════════════════════
         SUMMARY CARDS
         ════════════════════════════════════════════════════════ -->
    {#if useNCohortLayout}
      <!-- N-cohort summary: one card per cohort with its own colour stripe -->
      <div class="ncohort-summary">
        {#each allCohorts as cohort, ci}
          {@const cm = ci < allCohortPerSampleMetrics.length ? allCohortPerSampleMetrics[ci] : null}
          {@const seqSum = cm?.data.reduce((a, m) => a + m.diversity.totalSequences, 0) ?? 0}
          {@const cloneSum = cm?.data.reduce((a, m) => a + m.diversity.uniqueClones, 0) ?? 0}
          {@const shannonAvg = (cm && cm.data.length > 0) ? cm.data.reduce((a, m) => a + m.diversity.shannonEntropy, 0) / cm.data.length : 0}
          {@const shmAvg = (cm && cm.data.length > 0) ? cm.data.reduce((a, m) => a + m.diversity.meanSHM, 0) / cm.data.length : 0}
          <div class="ncohort-card" style="border-top-color: {GROUP_COLORS[ci % GROUP_COLORS.length]}">
            <div class="ncohort-name" style="color: {GROUP_COLORS[ci % GROUP_COLORS.length]}">{cohort.cohortName || cohort.cohortType}</div>
            <div class="ncohort-row"><span class="ncohort-label">Sequences</span><span class="ncohort-val">{seqSum.toLocaleString()}</span></div>
            <div class="ncohort-row"><span class="ncohort-label">Unique clones</span><span class="ncohort-val">{cloneSum.toLocaleString()}</span></div>
            <div class="ncohort-row"><span class="ncohort-label">Shannon</span><span class="ncohort-val">{shannonAvg.toFixed(2)}</span></div>
            <div class="ncohort-row"><span class="ncohort-label">Mean SHM</span><span class="ncohort-val">{shmAvg.toFixed(1)}</span></div>
          </div>
        {/each}
      </div>
    {:else if hasCohorts}
      <div class="comparison-summary">
        <div class="comp-card">
          <span class="comp-metric-label">Total Sequences</span>
          <div class="comp-values">
            <span class="comp-val disease">{sumStat(diseaseMetrics, 'totalSequences').toLocaleString()}</span>
            <span class="comp-sep">vs</span>
            <span class="comp-val control">{sumStat(controlMetrics, 'totalSequences').toLocaleString()}</span>
          </div>
          <div class="comp-cohort-labels">
            <span class="comp-cohort-name disease">{diseaseCohort?.cohortName ?? 'Disease'}</span>
            <span class="comp-cohort-name control">{controlCohort?.cohortName ?? 'Control'}</span>
          </div>
        </div>
        <div class="comp-card">
          <span class="comp-metric-label">Unique Clones</span>
          <div class="comp-values">
            <span class="comp-val disease">{sumStat(diseaseMetrics, 'uniqueClones').toLocaleString()}</span>
            <span class="comp-sep">vs</span>
            <span class="comp-val control">{sumStat(controlMetrics, 'uniqueClones').toLocaleString()}</span>
          </div>
          <div class="comp-cohort-labels">
            <span class="comp-cohort-name disease">{diseaseCohort?.cohortName ?? 'Disease'}</span>
            <span class="comp-cohort-name control">{controlCohort?.cohortName ?? 'Control'}</span>
          </div>
        </div>
        <div class="comp-card">
          <span class="comp-metric-label">Shannon Diversity</span>
          <div class="comp-values">
            <span class="comp-val disease">{avgStat(diseaseMetrics, 'shannonEntropy').toFixed(2)}</span>
            <span class="comp-sep">vs</span>
            <span class="comp-val control">{avgStat(controlMetrics, 'shannonEntropy').toFixed(2)}</span>
          </div>
          <div class="comp-cohort-labels">
            <span class="comp-cohort-name disease">{diseaseCohort?.cohortName ?? 'Disease'}</span>
            <span class="comp-cohort-name control">{controlCohort?.cohortName ?? 'Control'}</span>
          </div>
        </div>
        <div class="comp-card">
          <span class="comp-metric-label">Mean SHM</span>
          <div class="comp-values">
            <span class="comp-val disease">{avgStat(diseaseMetrics, 'meanSHM').toFixed(1)}</span>
            <span class="comp-sep">vs</span>
            <span class="comp-val control">{avgStat(controlMetrics, 'meanSHM').toFixed(1)}</span>
          </div>
          <div class="comp-cohort-labels">
            <span class="comp-cohort-name disease">{diseaseCohort?.cohortName ?? 'Disease'}</span>
            <span class="comp-cohort-name control">{controlCohort?.cohortName ?? 'Control'}</span>
          </div>
        </div>
      </div>
    {:else}
      <div class="summary-row">
        <div class="summary-card">
          <span class="sum-value">{sumStat(diseaseMetrics, 'totalSequences').toLocaleString()}</span>
          <span class="sum-label">Total Sequences</span>
        </div>
        <div class="summary-card">
          <span class="sum-value">{sumStat(diseaseMetrics, 'uniqueClones').toLocaleString()}</span>
          <span class="sum-label">Unique Clones</span>
        </div>
        <div class="summary-card">
          <span class="sum-value">{diseaseMetrics.length}</span>
          <span class="sum-label">Timepoints</span>
        </div>
      </div>
    {/if}

    <!-- ════════════════════════════════════════════════════════
         N-COHORT SECTION A: Per-Cohort Composition
         (donut grid + V-gene heatmap, one column per cohort)
         ════════════════════════════════════════════════════════ -->
    {#if useNCohortLayout}
    <section class="collapsible-section">
      <button class="section-header" on:click={() => perCohortCompositionOpen = !perCohortCompositionOpen}>
        <span class="section-chevron" class:open={perCohortCompositionOpen}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <h3 class="section-title">Per-Cohort Composition</h3>
        <span class="section-badge">{nonEmptyCohortsData.length} cohorts pooled</span>
      </button>

      {#if perCohortCompositionOpen}
        <div class="section-body">
          <p class="section-desc">
            Each cohort's sequences are pooled across samples. Useful for at-a-glance treatment-effect comparisons,
            but weighted toward samples with more sequences, use the Group Comparison section below for per-sample-weighted statistics.
          </p>

          <section class="chart-panel full-width" id="cohort-isotype-grid">
            <h3 class="chart-heading">Isotype Distribution (per cohort)</h3>
            <IsotypeChart data={cohortPooledMetrics} />
          </section>

          <section class="chart-panel full-width" id="cohort-vgene-heatmap">
            <h3 class="chart-heading">V-Gene Usage (per cohort)</h3>
            <p class="chart-desc">Top 20 V-gene families. Colour intensity = frequency within the cohort.</p>
            <VGeneHeatmap data={cohortPooledMetrics} />
          </section>
        </div>
      {/if}
    </section>

    <!-- ════════════════════════════════════════════════════════
         N-COHORT SECTION B: Per-Cohort Drilldown
         (cohort pill selector → per-mouse metric cards + charts)
         ════════════════════════════════════════════════════════ -->
    <section class="collapsible-section">
      <button class="section-header" on:click={() => perCohortDrilldownOpen = !perCohortDrilldownOpen}>
        <span class="section-chevron" class:open={perCohortDrilldownOpen}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <h3 class="section-title">Per-Cohort Drilldown</h3>
        {#if drilldownCohort}
          <span class="section-badge">{drilldownCohort.data.length} sample{drilldownCohort.data.length !== 1 ? 's' : ''}</span>
        {/if}
      </button>

      {#if perCohortDrilldownOpen}
        <div class="section-body">
          <p class="section-desc">
            Inspect individual samples within one cohort, pick a cohort to see per-mouse diversity, V-gene usage, isotype composition, and rank-abundance.
          </p>

          <div class="drilldown-pills">
            {#each nonEmptyCohortsData as c, i}
              <button
                class="drill-pill"
                class:active={i === drilldownCohortIdx}
                style="--pill-color: {c.color}"
                on:click={() => drilldownCohortIdx = i}
              >
                <span class="drill-pill-dot" style="background: {c.color}"></span>
                <span class="drill-pill-name">{c.name}</span>
                <span class="drill-pill-count">{c.data.length}</span>
              </button>
            {/each}
          </div>

          {#if drilldownCohort && drilldownCohort.data.length > 0}
            <div class="metric-cards-scroll">
              {#each drilldownCohort.data as m}
                <div class="metric-card">
                  <div class="mc-header">
                    <span class="mc-dot" style="background: {drilldownCohort.color}"></span>
                    <span class="mc-label">{m.groupName}{m.timepointLabel ? ` (${m.timepointLabel})` : ''}</span>
                  </div>
                  <div class="mc-grid">
                    <div class="mc-item" title={METRIC_TOOLTIPS['Sequences']}><span class="mc-val">{m.diversity.totalSequences}</span><span class="mc-key">Sequences</span></div>
                    <div class="mc-item" title={METRIC_TOOLTIPS['Clones']}><span class="mc-val">{m.diversity.uniqueClones}</span><span class="mc-key">Clones</span></div>
                    <div class="mc-item" title={METRIC_TOOLTIPS['Shannon']}><span class="mc-val">{m.diversity.shannonEntropy.toFixed(2)}</span><span class="mc-key">Shannon</span></div>
                    <div class="mc-item" title={METRIC_TOOLTIPS['Mean SHM']}><span class="mc-val">{m.diversity.meanSHM.toFixed(1)}</span><span class="mc-key">Mean SHM</span></div>
                    <div class="mc-item" title={METRIC_TOOLTIPS['Gini']}><span class="mc-val">{m.diversity.giniIndex.toFixed(3)}</span><span class="mc-key">Gini</span></div>
                    <div class="mc-item" title={METRIC_TOOLTIPS['D50']}><span class="mc-val">{m.diversity.d50}</span><span class="mc-key">D50</span></div>
                  </div>
                </div>
              {/each}
            </div>
            <div class="charts-grid">
              <section class="chart-panel"><h3 class="chart-heading">Diversity &amp; SHM</h3><DiversityChart data={drilldownCohort.data} /></section>
              <section class="chart-panel chart-panel-scroll"><h3 class="chart-heading">V-Gene Usage</h3><VGeneChart data={drilldownCohort.data} /></section>
            </div>
            <section class="chart-panel full-width"><h3 class="chart-heading">Isotype Distribution</h3><IsotypeChart data={drilldownCohort.data} /></section>
            <section class="chart-panel full-width"><h3 class="chart-heading">Rank-Abundance</h3><ExpansionChart data={drilldownCohort.data} /></section>
          {:else}
            <div class="empty-state-sm"><p>No samples in this cohort.</p></div>
          {/if}
        </div>
      {/if}
    </section>
    {/if}

    <!-- ════════════════════════════════════════════════════════
         SECTION 1: Per-Timepoint Metrics
         (hidden in N-cohort mode, only renders disease/control)
         ════════════════════════════════════════════════════════ -->
    {#if !useNCohortLayout}
    <section class="collapsible-section">
      <button class="section-header" on:click={() => perTimepointOpen = !perTimepointOpen}>
        <span class="section-chevron" class:open={perTimepointOpen}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <h3 class="section-title">Per-Timepoint Metrics</h3>
      </button>

      {#if perTimepointOpen}
        <div class="section-body">
          <p class="section-desc">
            Pooled metrics per timepoint, all sequences from all patients at each timepoint are combined into a single repertoire.
            This gives an overview of the overall repertoire composition but is weighted toward patients with more sequences.
          </p>
          {#if hasCohorts}
            <!-- COMPARISON: side-by-side disease | control -->
            <div class="cohort-comparison-row">
              <!-- Disease column -->
              <div class="cohort-col">
                <div class="cohort-col-header disease">
                  <span class="cohort-col-dot" style="background: {COHORT_COLOR_DISEASE}"></span>
                  {diseaseCohort?.cohortName ?? 'Disease'}
                </div>
                {#if diseaseUniqueTimepoints.length > 1}
                  <div class="tp-filter-row">
                    {#each diseaseUniqueTimepoints as tp}
                      <button
                        class="filter-pill filter-pill-sm"
                        class:active={diseaseEnabledTimepoints.has(tp)}
                        on:click={() => toggleDiseaseTimepoint(tp)}
                      >{tp}</button>
                    {/each}
                  </div>
                {/if}
                {#if filteredDiseaseMetrics.length > 0}
                  <div class="metric-cards-scroll">
                    {#each filteredDiseaseMetrics as m}
                      <div class="metric-card">
                        <div class="mc-header">
                          <span class="mc-dot" style="background: {m.groupColor}"></span>
                          <span class="mc-label">{m.timepointLabel}</span>
                        </div>
                        <div class="mc-grid">
                          <div class="mc-item" title={METRIC_TOOLTIPS['Sequences']}><span class="mc-val">{m.diversity.totalSequences}</span><span class="mc-key">Sequences</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['Clones']}><span class="mc-val">{m.diversity.uniqueClones}</span><span class="mc-key">Clones</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['Shannon']}><span class="mc-val">{m.diversity.shannonEntropy.toFixed(2)}</span><span class="mc-key">Shannon</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['Mean SHM']}><span class="mc-val">{m.diversity.meanSHM.toFixed(1)}</span><span class="mc-key">Mean SHM</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['Gini']}><span class="mc-val">{m.diversity.giniIndex.toFixed(3)}</span><span class="mc-key">Gini</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['D50']}><span class="mc-val">{m.diversity.d50}</span><span class="mc-key">D50</span></div>
                        </div>
                      </div>
                    {/each}
                  </div>
                  <div class="charts-grid">
                    <section class="chart-panel"><h3 class="chart-heading">Diversity &amp; SHM</h3><DiversityChart data={filteredDiseaseMetrics} /></section>
                    <section class="chart-panel chart-panel-scroll"><h3 class="chart-heading">V-Gene Usage</h3><VGeneChart data={filteredDiseaseMetrics} /></section>
                  </div>
                  <section class="chart-panel full-width"><h3 class="chart-heading">Isotype Distribution</h3><IsotypeChart data={filteredDiseaseMetrics} /></section>
                  <section class="chart-panel full-width"><h3 class="chart-heading">Rank-Abundance</h3><ExpansionChart data={filteredDiseaseMetrics} /></section>
                {:else}
                  <div class="empty-state-sm"><p>No data for selected timepoints.</p></div>
                {/if}
              </div>

              <!-- Control column -->
              <div class="cohort-col">
                <div class="cohort-col-header control">
                  <span class="cohort-col-dot" style="background: {COHORT_COLOR_CONTROL}"></span>
                  {controlCohort?.cohortName ?? 'Control'}
                </div>
                {#if controlUniqueTimepoints.length > 1}
                  <div class="tp-filter-row">
                    {#each controlUniqueTimepoints as tp}
                      <button
                        class="filter-pill filter-pill-sm"
                        class:active={controlEnabledTimepoints.has(tp)}
                        on:click={() => toggleControlTimepoint(tp)}
                      >{tp}</button>
                    {/each}
                  </div>
                {/if}
                {#if filteredControlMetrics.length > 0}
                  <div class="metric-cards-scroll">
                    {#each filteredControlMetrics as m}
                      <div class="metric-card">
                        <div class="mc-header">
                          <span class="mc-dot" style="background: {m.groupColor}"></span>
                          <span class="mc-label">{m.timepointLabel}</span>
                        </div>
                        <div class="mc-grid">
                          <div class="mc-item" title={METRIC_TOOLTIPS['Sequences']}><span class="mc-val">{m.diversity.totalSequences}</span><span class="mc-key">Sequences</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['Clones']}><span class="mc-val">{m.diversity.uniqueClones}</span><span class="mc-key">Clones</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['Shannon']}><span class="mc-val">{m.diversity.shannonEntropy.toFixed(2)}</span><span class="mc-key">Shannon</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['Mean SHM']}><span class="mc-val">{m.diversity.meanSHM.toFixed(1)}</span><span class="mc-key">Mean SHM</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['Gini']}><span class="mc-val">{m.diversity.giniIndex.toFixed(3)}</span><span class="mc-key">Gini</span></div>
                          <div class="mc-item" title={METRIC_TOOLTIPS['D50']}><span class="mc-val">{m.diversity.d50}</span><span class="mc-key">D50</span></div>
                        </div>
                      </div>
                    {/each}
                  </div>
                  <div class="charts-grid">
                    <section class="chart-panel"><h3 class="chart-heading">Diversity &amp; SHM</h3><DiversityChart data={filteredControlMetrics} /></section>
                    <section class="chart-panel chart-panel-scroll"><h3 class="chart-heading">V-Gene Usage</h3><VGeneChart data={filteredControlMetrics} /></section>
                  </div>
                  <section class="chart-panel full-width"><h3 class="chart-heading">Isotype Distribution</h3><IsotypeChart data={filteredControlMetrics} /></section>
                  <section class="chart-panel full-width"><h3 class="chart-heading">Rank-Abundance</h3><ExpansionChart data={filteredControlMetrics} /></section>
                {:else}
                  <div class="empty-state-sm"><p>No data for selected timepoints.</p></div>
                {/if}
              </div>
            </div>
          {:else}
            <!-- SINGLE COHORT: original layout -->
            {#if diseaseUniqueTimepoints.length > 1}
              <div class="tp-filter-row" style="margin-bottom: var(--space-3);">
                <span class="filter-label">Timepoints:</span>
                {#each diseaseUniqueTimepoints as tp}
                  <button
                    class="filter-pill filter-pill-sm"
                    class:active={diseaseEnabledTimepoints.has(tp)}
                    on:click={() => toggleDiseaseTimepoint(tp)}
                  >{tp}</button>
                {/each}
              </div>
            {/if}
            {#if filteredDiseaseMetrics.length > 0}
              <div class="metric-cards-scroll">
                {#each filteredDiseaseMetrics as m}
                  <div class="metric-card">
                    <div class="mc-header">
                      <span class="mc-dot" style="background: {m.groupColor}"></span>
                      <span class="mc-label">{m.groupName}{diseaseHasDesign ? ` / ${m.timepointLabel}` : ''}</span>
                    </div>
                    <div class="mc-grid">
                      <div class="mc-item" title={METRIC_TOOLTIPS['Sequences']}><span class="mc-val">{m.diversity.totalSequences}</span><span class="mc-key">Sequences</span></div>
                      <div class="mc-item" title={METRIC_TOOLTIPS['Clones']}><span class="mc-val">{m.diversity.uniqueClones}</span><span class="mc-key">Clones</span></div>
                      <div class="mc-item" title={METRIC_TOOLTIPS['Shannon']}><span class="mc-val">{m.diversity.shannonEntropy.toFixed(2)}</span><span class="mc-key">Shannon</span></div>
                      <div class="mc-item" title={METRIC_TOOLTIPS['Chao1']}><span class="mc-val">{m.diversity.chao1.toFixed(0)}</span><span class="mc-key">Chao1</span></div>
                      <div class="mc-item" title={METRIC_TOOLTIPS['Gini']}><span class="mc-val">{m.diversity.giniIndex.toFixed(3)}</span><span class="mc-key">Gini</span></div>
                      <div class="mc-item" title={METRIC_TOOLTIPS['Simpson']}><span class="mc-val">{m.diversity.simpsonIndex.toFixed(3)}</span><span class="mc-key">Simpson</span></div>
                      <div class="mc-item" title={METRIC_TOOLTIPS['Mean SHM']}><span class="mc-val">{m.diversity.meanSHM.toFixed(1)}</span><span class="mc-key">Mean SHM</span></div>
                      <div class="mc-item" title={METRIC_TOOLTIPS['D50']}><span class="mc-val">{m.diversity.d50}</span><span class="mc-key">D50</span></div>
                      <div class="mc-item" title={METRIC_TOOLTIPS['Productive']}><span class="mc-val">{m.diversity.productivePercent.toFixed(0)}%</span><span class="mc-key">Productive</span></div>
                    </div>
                  </div>
                {/each}
              </div>
              <div class="charts-grid">
                <section class="chart-panel"><h3 class="chart-heading">Clonal Diversity &amp; SHM</h3><DiversityChart data={filteredDiseaseMetrics} /></section>
                <section class="chart-panel chart-panel-scroll"><h3 class="chart-heading">V-Gene Family Usage</h3><VGeneChart data={filteredDiseaseMetrics} /></section>
              </div>
              <section class="chart-panel full-width"><h3 class="chart-heading">Isotype Distribution</h3><IsotypeChart data={filteredDiseaseMetrics} /></section>
              <section class="chart-panel full-width"><h3 class="chart-heading">Clonal Expansion (Rank-Abundance)</h3><ExpansionChart data={filteredDiseaseMetrics} /></section>
            {:else}
              <div class="empty-state"><p>No data matches the current filters.</p></div>
            {/if}
          {/if}
        </div>
      {/if}
    </section>
    {/if}

    <!-- ════════════════════════════════════════════════════════
         SECTION 2: Per-Sample Comparison
         (hidden in N-cohort mode, only renders disease/control)
         ════════════════════════════════════════════════════════ -->
    {#if !useNCohortLayout}
    <section class="collapsible-section">
      <button class="section-header" on:click={() => perSampleComparisonOpen = !perSampleComparisonOpen}>
        <span class="section-chevron" class:open={perSampleComparisonOpen}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <h3 class="section-title">Per-Sample Comparison</h3>
        <span class="section-badge">
          {filteredDiseasePerSample.length + filteredControlPerSample.length} sample{(filteredDiseasePerSample.length + filteredControlPerSample.length) !== 1 ? 's' : ''}
        </span>
      </button>

      {#if perSampleComparisonOpen}
        <div class="section-body">
          <p class="section-desc">
            Individual patient/sample metrics, each sample is analyzed independently.
            Use this to explore individual variation within each group, identify outlier patients, or select specific samples for deeper analysis.
          </p>

          {#if hasCohorts}
            <div class="cohort-comparison-row">
              <!-- Disease samples -->
              <div class="cohort-col">
                <div class="cohort-col-header disease">
                  <span class="cohort-col-dot" style="background: {COHORT_COLOR_DISEASE}"></span>
                  {diseaseCohort?.cohortName ?? 'Disease'}
                </div>
                {#if diseaseSampleGroups.length > 0}
                  <div class="hierarchical-selector">
                    {#each diseaseSampleGroups as tpGroup}
                      <div class="tp-sample-group">
                        <div class="tp-sample-header">
                          <span class="tp-sample-label">{tpGroup.label}</span>
                          <button
                            class="tp-all-btn"
                            on:click={() => toggleAllSamplesInTp(tpGroup, diseaseEnabledSamples, s => { diseaseEnabledSamples = s; })}
                          >All</button>
                        </div>
                        <div class="tp-sample-pills">
                          {#each tpGroup.samples as m}
                            <button
                              class="filter-pill filter-pill-sm"
                              class:active={diseaseEnabledSamples.has(m.groupName)}
                              on:click={() => toggleDiseaseSample(m.groupName)}
                              title={m.groupName}
                            >
                              <span class="pill-dot" style="background: {m.groupColor}"></span>
                              <span class="pill-name">{m.groupName}</span>
                            </button>
                          {/each}
                        </div>
                      </div>
                    {/each}
                  </div>
                  {#if filteredDiseasePerSample.length > 0}
                    <div class="metric-cards-scroll">
                      {#each filteredDiseasePerSample as m}
                        <div class="metric-card">
                          <div class="mc-header">
                            <span class="mc-dot" style="background: {m.groupColor}"></span>
                            <span class="mc-label">{m.groupName} ({m.timepointLabel})</span>
                          </div>
                          <div class="mc-grid">
                            <div class="mc-item"><span class="mc-val">{m.diversity.totalSequences}</span><span class="mc-key">Sequences</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.uniqueClones}</span><span class="mc-key">Clones</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.shannonEntropy.toFixed(2)}</span><span class="mc-key">Shannon</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.meanSHM.toFixed(1)}</span><span class="mc-key">Mean SHM</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.giniIndex.toFixed(3)}</span><span class="mc-key">Gini</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.d50}</span><span class="mc-key">D50</span></div>
                          </div>
                        </div>
                      {/each}
                    </div>
                    <div class="charts-grid">
                      <section class="chart-panel"><h3 class="chart-heading">Diversity &amp; SHM</h3><DiversityChart data={filteredDiseasePerSample} /></section>
                      <section class="chart-panel chart-panel-scroll"><h3 class="chart-heading">V-Gene Usage</h3><VGeneChart data={filteredDiseasePerSample} /></section>
                    </div>
                    <section class="chart-panel full-width"><h3 class="chart-heading">Isotype Distribution</h3><IsotypeChart data={filteredDiseasePerSample} /></section>
                    <section class="chart-panel full-width"><h3 class="chart-heading">Rank-Abundance</h3><ExpansionChart data={filteredDiseasePerSample} /></section>
                  {:else}
                    <div class="empty-state-sm"><p>Select at least one sample.</p></div>
                  {/if}
                {:else}
                  <div class="empty-state-sm"><p>No samples available.</p></div>
                {/if}
              </div>

              <!-- Control samples -->
              <div class="cohort-col">
                <div class="cohort-col-header control">
                  <span class="cohort-col-dot" style="background: {COHORT_COLOR_CONTROL}"></span>
                  {controlCohort?.cohortName ?? 'Control'}
                </div>
                {#if controlSampleGroups.length > 0}
                  <div class="hierarchical-selector">
                    {#each controlSampleGroups as tpGroup}
                      <div class="tp-sample-group">
                        <div class="tp-sample-header">
                          <span class="tp-sample-label">{tpGroup.label}</span>
                          <button
                            class="tp-all-btn"
                            on:click={() => toggleAllSamplesInTp(tpGroup, controlEnabledSamples, s => { controlEnabledSamples = s; })}
                          >All</button>
                        </div>
                        <div class="tp-sample-pills">
                          {#each tpGroup.samples as m}
                            <button
                              class="filter-pill filter-pill-sm"
                              class:active={controlEnabledSamples.has(m.groupName)}
                              on:click={() => toggleControlSample(m.groupName)}
                              title={m.groupName}
                            >
                              <span class="pill-dot" style="background: {m.groupColor}"></span>
                              <span class="pill-name">{m.groupName}</span>
                            </button>
                          {/each}
                        </div>
                      </div>
                    {/each}
                  </div>
                  {#if filteredControlPerSample.length > 0}
                    <div class="metric-cards-scroll">
                      {#each filteredControlPerSample as m}
                        <div class="metric-card">
                          <div class="mc-header">
                            <span class="mc-dot" style="background: {m.groupColor}"></span>
                            <span class="mc-label">{m.groupName} ({m.timepointLabel})</span>
                          </div>
                          <div class="mc-grid">
                            <div class="mc-item"><span class="mc-val">{m.diversity.totalSequences}</span><span class="mc-key">Sequences</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.uniqueClones}</span><span class="mc-key">Clones</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.shannonEntropy.toFixed(2)}</span><span class="mc-key">Shannon</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.meanSHM.toFixed(1)}</span><span class="mc-key">Mean SHM</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.giniIndex.toFixed(3)}</span><span class="mc-key">Gini</span></div>
                            <div class="mc-item"><span class="mc-val">{m.diversity.d50}</span><span class="mc-key">D50</span></div>
                          </div>
                        </div>
                      {/each}
                    </div>
                    <div class="charts-grid">
                      <section class="chart-panel"><h3 class="chart-heading">Diversity &amp; SHM</h3><DiversityChart data={filteredControlPerSample} /></section>
                      <section class="chart-panel chart-panel-scroll"><h3 class="chart-heading">V-Gene Usage</h3><VGeneChart data={filteredControlPerSample} /></section>
                    </div>
                    <section class="chart-panel full-width"><h3 class="chart-heading">Isotype Distribution</h3><IsotypeChart data={filteredControlPerSample} /></section>
                    <section class="chart-panel full-width"><h3 class="chart-heading">Rank-Abundance</h3><ExpansionChart data={filteredControlPerSample} /></section>
                  {:else}
                    <div class="empty-state-sm"><p>Select at least one sample.</p></div>
                  {/if}
                {:else}
                  <div class="empty-state-sm"><p>No samples available.</p></div>
                {/if}
              </div>
            </div>
          {:else}
            <!-- SINGLE: grouped by timepoint -->
            {#if diseaseSampleGroups.length > 0}
              <div class="hierarchical-selector">
                {#each diseaseSampleGroups as tpGroup}
                  <div class="tp-sample-group">
                    <div class="tp-sample-header">
                      <span class="tp-sample-label">{tpGroup.label}</span>
                      <button
                        class="tp-all-btn"
                        on:click={() => toggleAllSamplesInTp(tpGroup, diseaseEnabledSamples, s => { diseaseEnabledSamples = s; })}
                      >All</button>
                    </div>
                    <div class="tp-sample-pills">
                      {#each tpGroup.samples as m}
                        <button
                          class="filter-pill filter-pill-sm"
                          class:active={diseaseEnabledSamples.has(m.groupName)}
                          on:click={() => toggleDiseaseSample(m.groupName)}
                          title={m.groupName}
                        >
                          <span class="pill-dot" style="background: {m.groupColor}"></span>
                          <span class="pill-name">{m.groupName}{diseaseHasDesign ? ` (${m.timepointLabel})` : ''}</span>
                        </button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
              {#if filteredDiseasePerSample.length > 0}
                <div class="metric-cards-scroll">
                  {#each filteredDiseasePerSample as m}
                    <div class="metric-card">
                      <div class="mc-header">
                        <span class="mc-dot" style="background: {m.groupColor}"></span>
                        <span class="mc-label">{m.groupName}{diseaseHasDesign ? ` (${m.timepointLabel})` : ''}</span>
                      </div>
                      <div class="mc-grid">
                        <div class="mc-item" title={METRIC_TOOLTIPS['Sequences']}><span class="mc-val">{m.diversity.totalSequences}</span><span class="mc-key">Sequences</span></div>
                        <div class="mc-item" title={METRIC_TOOLTIPS['Clones']}><span class="mc-val">{m.diversity.uniqueClones}</span><span class="mc-key">Clones</span></div>
                        <div class="mc-item" title={METRIC_TOOLTIPS['Shannon']}><span class="mc-val">{m.diversity.shannonEntropy.toFixed(2)}</span><span class="mc-key">Shannon</span></div>
                        <div class="mc-item" title={METRIC_TOOLTIPS['Chao1']}><span class="mc-val">{m.diversity.chao1.toFixed(0)}</span><span class="mc-key">Chao1</span></div>
                        <div class="mc-item" title={METRIC_TOOLTIPS['Gini']}><span class="mc-val">{m.diversity.giniIndex.toFixed(3)}</span><span class="mc-key">Gini</span></div>
                        <div class="mc-item" title={METRIC_TOOLTIPS['Simpson']}><span class="mc-val">{m.diversity.simpsonIndex.toFixed(3)}</span><span class="mc-key">Simpson</span></div>
                        <div class="mc-item" title={METRIC_TOOLTIPS['Mean SHM']}><span class="mc-val">{m.diversity.meanSHM.toFixed(1)}</span><span class="mc-key">Mean SHM</span></div>
                        <div class="mc-item" title={METRIC_TOOLTIPS['D50']}><span class="mc-val">{m.diversity.d50}</span><span class="mc-key">D50</span></div>
                        <div class="mc-item" title={METRIC_TOOLTIPS['Productive']}><span class="mc-val">{m.diversity.productivePercent.toFixed(0)}%</span><span class="mc-key">Productive</span></div>
                      </div>
                    </div>
                  {/each}
                </div>
                <div class="charts-grid">
                  <section class="chart-panel"><h3 class="chart-heading">Diversity &amp; SHM (per sample)</h3><DiversityChart data={filteredDiseasePerSample} /></section>
                  <section class="chart-panel chart-panel-scroll"><h3 class="chart-heading">V-Gene Usage (per sample)</h3><VGeneChart data={filteredDiseasePerSample} /></section>
                </div>
                <section class="chart-panel full-width"><h3 class="chart-heading">Isotype Distribution (per sample)</h3><IsotypeChart data={filteredDiseasePerSample} /></section>
                <section class="chart-panel full-width"><h3 class="chart-heading">Rank-Abundance (per sample)</h3><ExpansionChart data={filteredDiseasePerSample} /></section>
              {:else}
                <div class="empty-state"><p>Select at least one sample above to view metrics and charts.</p></div>
              {/if}
            {:else}
              <div class="empty-state"><p>No samples available.</p></div>
            {/if}
          {/if}
        </div>
      {/if}
    </section>
    {/if}

    <!-- ════════════════════════════════════════════════════════
         SECTION 2.5: Group Comparison (Boxplots with Statistical Tests)
         ════════════════════════════════════════════════════════ -->
    <section class="collapsible-section">
      <button class="section-header" on:click={() => groupComparisonOpen = !groupComparisonOpen}>
        <span class="section-chevron" class:open={groupComparisonOpen}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <h3 class="section-title">Group Comparison</h3>
        {#if hasCohorts}
          <span class="section-badge">Wilcoxon rank-sum</span>
        {:else}
          <span class="section-badge muted">requires 2 groups</span>
        {/if}
      </button>

      <div class="section-body" class:section-hidden={!groupComparisonOpen}>
        <p class="section-desc">
          Statistical group comparison using per-patient metrics, each patient contributes equally regardless of sample size.
          Unlike the pooled per-timepoint view above, this avoids bias toward patients with more sequences.
          {#if hasCohorts}P-values from Wilcoxon rank-sum test (BH-FDR corrected across all comparisons). Individual data points are overlaid.{/if}
        </p>
        {#if useNCohortLayout}
          <div class="ncohort-banner">
            Showing all {nonEmptyCohortsData.length} cohorts side-by-side. Statistical comparisons reduced to pairwise Wilcoxon (BH-corrected) for readability.
          </div>
        {/if}
        <!-- Diagnostic, deliberately ahead of the boxplots and outside every
             correction family: depth is the precondition the p-values below
             rest on, so it has to be read first. No test runs here. -->
        <section class="chart-panel full-width" id="sequencing-depth-panel">
          <h3 class="chart-heading">Sequencing Depth per Patient <span class="diag-tag">diagnostic</span></h3>
          <p class="chart-desc">
            Clone-assigned sequences per patient, the depth every metric below is computed on.
            Light chains are excluded because they never reach clonal assignment.
            No statistical test is run here and this panel is not part of the multiple-testing
            correction applied to the comparisons below.
          </p>
          <SequencingDepthPanel
            diseaseData={diseasePerSampleMetrics}
            controlData={controlPerSampleMetrics}
            diseaseName={hasCohorts ? (diseaseCohort?.cohortName ?? 'Disease') : 'All Samples'}
            controlName={controlCohort?.cohortName ?? 'Control'}
            cohortsData={useNCohortLayout ? nonEmptyCohortsData : null}
            {publicationMode}
          />
        </section>
        {#if hasCohorts && !useNCohortLayout}
          <div class="norm-bar" class:norm-on={normalizeDepth}>
            <label class="norm-toggle">
              <input type="checkbox" bind:checked={normalizeDepth} />
              <span>Normalize sequencing depth</span>
            </label>
            {#if normalizeDepth}
              <label class="norm-depth">
                Depth
                <input
                  type="number"
                  min={MIN_USEFUL_DEPTH}
                  step="1"
                  bind:value={normDepth}
                />
              </label>
              <button class="norm-reset" on:click={() => (normDepth = depthSuggestion.depth)}>
                reset to {depthSuggestion.depth}
              </button>
              <span class="norm-meta">
                {DEFAULT_REPLICATES} draws, seed {DEFAULT_SEED}, mean per patient
              </span>
            {:else}
              <span class="norm-meta">
                Off. Values below are computed at each patient's own depth.
              </span>
            {/if}
          </div>

          {#if normalizeDepth}
            <div class="norm-detail">
              <table class="retention-table">
                <thead>
                  <tr>
                    <th>Timepoint</th>
                    <th>{diseaseCohort?.cohortName ?? 'Disease'}</th>
                    <th>{controlCohort?.cohortName ?? 'Control'}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each retentionRows as r}
                    <tr>
                      <td class="tp">{r.tp}</td>
                      <td class:thin={r.diseaseTotal > 0 && r.diseaseKept < 3}>{r.diseaseKept} of {r.diseaseTotal}</td>
                      <td class:thin={r.controlTotal > 0 && r.controlKept < 3}>{r.controlKept} of {r.controlTotal}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <p class="norm-note">
                Patients retained at depth {normDepth}. Each retained patient is reduced to a
                random sample of {normDepth} clone-assigned sequences, {DEFAULT_REPLICATES} times, and the
                metrics are averaged over those draws. Unnormalized values stay visible
                alongside each comparison.
                {#if depthSuggestion.atFloor}
                  The suggested depth sits at the floor of {MIN_USEFUL_DEPTH}, meaning most
                  patients in this study are too shallow for depth-matched comparison.
                {/if}
                {#if anyTimepointTooThin}
                  At least one timepoint drops below three patients in a group, where no
                  rank test can run. Lower the depth or read that timepoint as unresolved.
                {/if}
              </p>
            </div>
          {/if}
        {/if}

        <div id="group-comparison-chart">
          <GroupComparisonChart
            diseaseData={diseasePerSampleMetrics}
            controlData={controlPerSampleMetrics}
            rarefiedDisease={normalizeDepth ? diseasePerSampleRarefied : null}
            rarefiedControl={normalizeDepth ? controlPerSampleRarefied : null}
            rarefactionDepth={normDepth}
            diseaseName={hasCohorts ? (diseaseCohort?.cohortName ?? 'Disease') : 'All Samples'}
            controlName={controlCohort?.cohortName ?? 'Control'}
            cohortsData={useNCohortLayout ? nonEmptyCohortsData : null}
          />
        </div>
        {#if !isSingleTimepoint}
          <section class="chart-panel full-width" id="isotype-comparison-chart">
            <h3 class="chart-heading">Isotype Composition (per-patient mean)</h3>
            <p class="chart-desc">
              Per-patient mean isotype proportions, each patient's IgM/IgG/IgA/IgD/IgE distribution is computed individually, then averaged across the group.
              This differs from the pooled donut charts above, which are dominated by high-sequence patients. Error bars show ± SEM.
              {#if hasCohorts}Significant differences (BH-adjusted p &lt; 0.05) are marked.{/if}
            </p>
            <IsotypeComparisonChart
              diseaseData={diseasePerSampleMetrics}
              controlData={controlPerSampleMetrics}
              diseaseName={hasCohorts ? (diseaseCohort?.cohortName ?? 'Disease') : 'All Samples'}
              controlName={controlCohort?.cohortName ?? 'Control'}
              {publicationMode}
            />
          </section>
          <section class="chart-panel full-width" id="per-patient-trajectory-chart">
            <h3 class="chart-heading">Per-Patient Diversity Trajectory</h3>
            <p class="chart-desc">
              Mean per-patient diversity over time with ± SEM error bands.
              Each patient is weighted equally at each timepoint, unlike the pooled trajectory in the Longitudinal section below.
              {#if hasCohorts}Significant timepoint differences (BH-adjusted p &lt; 0.05) are marked with stars.{/if}
            </p>
            <PerPatientTrajectoryChart
              diseaseData={normalizeDepth ? diseasePerSampleRarefied : diseasePerSampleMetrics}
              controlData={normalizeDepth ? controlPerSampleRarefied : controlPerSampleMetrics}
              diseaseName={hasCohorts ? (diseaseCohort?.cohortName ?? 'Disease') : 'All Samples'}
              controlName={controlCohort?.cohortName ?? 'Control'}
              normalizedDepth={normalizeDepth ? normDepth : null}
            />
          </section>
        {/if}
      </div>
    </section>

  {/if}
</div>

<style>
  .dashboard {
    padding: var(--space-6);
    overflow-y: auto;
    height: 100%;
  }
  .dash-header {
    margin-bottom: var(--space-4);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .dash-title {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  .dash-export-group {
    display: flex;
    gap: var(--space-2);
  }
  .export-view-btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }
  .export-view-btn:hover { background: var(--gray-100); color: var(--text-primary); }
  .export-view-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .export-view-btn svg { flex-shrink: 0; }

  /* ── Comparison summary cards ─── */
  .comparison-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .comp-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    text-align: center;
  }
  .comp-metric-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    margin-bottom: var(--space-2);
  }
  .comp-values {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .comp-val {
    font-size: var(--text-lg);
    font-weight: var(--font-bold);
    font-feature-settings: 'tnum' 1;
  }
  .comp-val.disease { color: #1565C0; }
  .comp-val.control { color: #616161; }
  .comp-sep {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    font-weight: var(--font-medium);
  }
  .comp-cohort-labels {
    display: flex;
    justify-content: space-between;
    width: 100%;
    margin-top: var(--space-1);
  }
  .comp-cohort-name {
    font-size: 10px;
    font-weight: var(--font-medium);
  }
  .comp-cohort-name.disease { color: #1565C0; }
  .comp-cohort-name.control { color: #757575; }

  /* ── Single-cohort summary ────── */
  .summary-row {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }
  .summary-card {
    flex: 1;
    min-width: 100px;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
  }
  .ncohort-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .ncohort-card {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-top: 3px solid transparent;
    border-radius: var(--border-radius-md);
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ncohort-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    margin-bottom: 4px;
  }
  .ncohort-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: var(--text-xs);
  }
  .ncohort-label {
    color: var(--text-tertiary);
  }
  .ncohort-val {
    color: var(--text-primary);
    font-weight: var(--font-medium);
    font-variant-numeric: tabular-nums;
  }

  .ncohort-banner {
    padding: var(--space-3) var(--space-4);
    background: var(--gray-50);
    border-left: 3px solid var(--color-primary);
    border-radius: var(--border-radius-sm);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin-bottom: var(--space-3);
  }

  .drilldown-pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }
  .drill-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px 12px;
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-full);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .drill-pill:hover {
    border-color: var(--pill-color, var(--color-primary));
    color: var(--text-primary);
  }
  .drill-pill.active {
    background: var(--pill-color, var(--color-primary));
    border-color: var(--pill-color, var(--color-primary));
    color: #fff;
  }
  .drill-pill.active .drill-pill-dot { background: #fff !important; }
  .drill-pill.active .drill-pill-count { background: rgba(255,255,255,0.25); color: #fff; }
  .drill-pill-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .drill-pill-name { font-weight: var(--font-medium); }
  .drill-pill-count {
    padding: 1px 6px;
    background: var(--gray-100);
    border-radius: var(--border-radius-full);
    font-size: 10px;
    color: var(--text-tertiary);
  }

  .summary-card.accent {
    border-color: var(--color-primary-muted);
    background: var(--color-primary-light);
  }
  .sum-value {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--text-primary);
  }
  .sum-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin-top: var(--space-1);
  }

  /* ── Cohort comparison columns ── */
  .cohort-comparison-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
  }
  .cohort-col {
    min-width: 0;
  }
  .cohort-col-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--border-radius-sm);
    margin-bottom: var(--space-3);
  }
  .cohort-col-header.disease {
    color: #1565C0;
    background: #E3F2FD;
  }
  .cohort-col-header.control {
    color: #424242;
    background: #F5F5F5;
  }
  .cohort-col-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ── Timepoint filter row ─────── */
  .tp-filter-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }
  .filter-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    color: var(--text-tertiary);
    margin-right: var(--space-1);
  }
  .filter-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px;
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-full);
    background: var(--surface-raised);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .filter-pill.active {
    border-color: var(--color-primary-muted);
    background: var(--color-primary-light);
    color: var(--color-primary);
  }
  .filter-pill-sm {
    padding: 3px 10px;
    font-size: 11px;
  }
  .pill-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .pill-name {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Hierarchical sample selector ── */
  .hierarchical-selector {
    margin-bottom: var(--space-4);
  }
  .tp-sample-group {
    margin-bottom: var(--space-2);
  }
  .tp-sample-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-1);
  }
  .tp-sample-label {
    font-size: 11px;
    font-weight: var(--font-semibold);
    color: var(--text-secondary);
    min-width: 32px;
  }
  .tp-all-btn {
    font-size: 10px;
    padding: 1px 8px;
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-full);
    background: var(--gray-50);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .tp-all-btn:hover {
    background: var(--color-primary-light);
    color: var(--color-primary);
  }
  .tp-sample-pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding-left: var(--space-3);
  }

  /* ── Collapsible sections ──────── */
  .collapsible-section {
    margin-bottom: var(--space-4);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    background: var(--surface-raised);
    overflow: hidden;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: var(--gray-50);
    border: none;
    border-bottom: 1px solid var(--border-light);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }
  .section-header:hover { background: var(--gray-100); }
  .section-chevron {
    display: flex; align-items: center; justify-content: center;
    width: 20px; height: 20px;
    color: var(--text-tertiary);
    transition: transform 0.2s ease;
    transform: rotate(0deg);
  }
  .section-chevron.open { transform: rotate(90deg); }
  .section-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    flex: 1;
  }
  .section-badge {
    font-size: var(--text-xs);
    color: var(--color-primary);
    background: var(--color-primary-light);
    padding: 2px 8px;
    border-radius: var(--border-radius-full);
    font-weight: var(--font-medium);
  }
  .section-badge.muted {
    color: var(--text-tertiary);
    background: var(--gray-100);
  }
  .section-body { padding: var(--space-4); }
  .section-hidden { display: none; }

  .section-desc {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    margin: 0 0 var(--space-4) 0;
    line-height: var(--leading-relaxed);
  }

  /* ── Per-timepoint metric cards ── */
  .metric-cards-scroll {
    display: flex;
    gap: var(--space-3);
    overflow-x: auto;
    padding-bottom: var(--space-3);
    margin-bottom: var(--space-4);
  }
  .metric-card {
    flex: 0 0 auto;
    min-width: 200px;
    max-width: 260px;
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-3);
    background: var(--surface-raised);
  }
  .mc-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  .mc-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .mc-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mc-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px 10px;
  }
  .mc-item { display: flex; flex-direction: column; cursor: help; }
  .mc-val {
    font-size: var(--text-sm);
    font-weight: var(--font-bold);
    color: var(--text-primary);
    font-feature-settings: 'tnum' 1;
  }
  .mc-key {
    font-size: 10px;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* ── Charts ──────────────────── */
  .charts-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 560px;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .chart-panel {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-4);
    overflow: hidden;
  }
  .chart-panel.full-width { margin-bottom: var(--space-4); }
  .chart-panel.chart-panel-scroll {
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
  }
  .chart-heading {
    margin: 0 0 var(--space-1) 0;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  .norm-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
    padding: 8px 12px;
    margin-bottom: var(--space-2);
    border: 1px solid var(--border-light, #e5e7eb);
    border-radius: 6px;
    background: var(--surface-raised, #fff);
    font-size: var(--text-xs);
  }
  .norm-bar.norm-on {
    border-color: #93C5FD;
    background: #EFF6FF;
  }
  .norm-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: var(--font-semibold);
    cursor: pointer;
  }
  .norm-depth {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary, #555);
  }
  .norm-depth input {
    width: 68px;
    padding: 2px 6px;
    border: 1px solid var(--border-light, #d1d5db);
    border-radius: 4px;
    font-size: var(--text-xs);
  }
  .norm-reset {
    padding: 2px 8px;
    border: 1px solid var(--border-light, #d1d5db);
    border-radius: 4px;
    background: transparent;
    font-size: 11px;
    color: var(--text-secondary, #555);
    cursor: pointer;
  }
  .norm-reset:hover { background: var(--gray-100, #f3f4f6); }
  .norm-meta { color: var(--text-tertiary, #888); font-size: 11px; }
  .norm-detail {
    display: flex;
    gap: var(--space-4);
    align-items: flex-start;
    padding: 0 12px var(--space-2);
    margin-bottom: var(--space-2);
  }
  .retention-table {
    border-collapse: collapse;
    font-size: 11px;
    flex-shrink: 0;
  }
  .retention-table th, .retention-table td {
    padding: 3px 10px;
    text-align: right;
    border-bottom: 1px solid var(--border-light, #e5e7eb);
    white-space: nowrap;
  }
  .retention-table th:first-child, .retention-table td:first-child { text-align: left; }
  .retention-table th { font-weight: 600; color: var(--text-secondary, #555); }
  .retention-table td.tp { font-weight: 600; color: #444; }
  .retention-table td.thin { color: #B45309; font-weight: 600; }
  .norm-note {
    margin: 0;
    font-size: 11px;
    line-height: 1.55;
    color: var(--text-secondary, #555);
  }
  .diag-tag {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--gray-100, #f3f4f6);
    color: var(--text-tertiary, #6b7280);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    vertical-align: middle;
  }
  .chart-desc {
    margin: 0 0 var(--space-3) 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    line-height: var(--leading-relaxed);
  }

  /* ── Empty states ─────────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .empty-state-sm {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60px;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  /* ── Publication export dropdown ── */
  .export-dropdown-wrapper {
    position: relative;
  }
  .export-pub-btn {
    border-color: var(--color-primary-muted);
    color: var(--color-primary);
  }
  .export-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    box-shadow: var(--shadow-lg);
    z-index: 50;
    min-width: 180px;
    overflow: hidden;
  }
  .export-dropdown-group {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
    gap: var(--space-2);
  }
  .export-dropdown-group + .export-dropdown-group {
    border-top: 1px solid var(--border-light);
  }
  .export-dropdown-label {
    font-size: var(--text-xs);
    color: var(--text-primary);
    font-weight: var(--font-medium);
    white-space: nowrap;
  }
  .export-dropdown-actions {
    display: flex;
    gap: 4px;
  }
  .export-dropdown-item {
    padding: 2px 8px;
    font-size: 10px;
    font-weight: var(--font-medium);
    color: var(--color-primary);
    background: var(--color-primary-light);
    border: 1px solid var(--color-primary-muted);
    border-radius: var(--border-radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }
  .export-dropdown-item:hover {
    background: var(--color-primary-muted);
    color: #fff;
  }
</style>
