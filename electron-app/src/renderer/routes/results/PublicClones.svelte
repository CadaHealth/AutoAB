<script lang="ts">
  import { onMount } from 'svelte';
  import { resultsState, publicClonesActions, type CohortType, type CohortResults } from '../../lib/stores/app';
  import {
    computePublicClonesPerTimepoint,
    computePublicClones,
    computeClonalDynamicsHeatmap,
    getTimepointLabels,
    getPublicCloneIds
  } from '../../lib/utils/public-clones';
  import type { ClonalDynamicsData, ClonalDynamicsEntry, ClonalStatus } from '../../lib/utils/public-clones';
  import type { TreeMetadata } from '../../lib/stores/app';
  import HeatmapViz from '../../lib/components/visualizations/HeatmapViz.svelte';
  import ClonalDynamicsHeatmap from '../../lib/components/visualizations/ClonalDynamicsHeatmap.svelte';
  import ClonalDynamicsBubbles from '../../lib/components/visualizations/ClonalDynamicsBubbles.svelte';
  import ClonalDynamicsIsotypeTiles from '../../lib/components/visualizations/ClonalDynamicsIsotypeTiles.svelte';
  import { computeIsotypePerCloneTimepoint } from '../../lib/utils/public-clones';
  import type { IsotypeTileEntry } from '../../lib/utils/public-clones';
  import InteractiveTree from './InteractiveTree.svelte';
  import {
    sharedClonesWorkbook,
    clonalDynamicsWorkbook,
    crossCohortClonesWorkbook,
    downloadXlsx
  } from '../../lib/utils/export-csv';
  import { findCrossCohortClones, type CrossCohortCluster } from '../../lib/utils/cross-cohort-clones';
  import { computeLongitudinalAnalysis, type LongitudinalGroupData } from '../../lib/utils/repertoire-metrics';
  import { studyDesign, type StudyDesign, type FileGroup, type TimepointMapping, GROUP_COLORS } from '../../lib/stores/app';
  import ShmAccumulationChart from '../../lib/components/visualizations/ShmAccumulationChart.svelte';

  const DYNAMICS_STATUSES: { value: ClonalStatus; label: string }[] = [
    { value: 'persistent', label: 'Persistent' },
    { value: 'expanding', label: 'Expanding' },
    { value: 'contracting', label: 'Contracting' },
    { value: 'disappeared', label: 'Disappeared' },
    { value: 'late_emerging', label: 'Late emerging' },
    { value: 'transient', label: 'Transient' }
  ];

  // ── Section collapse state (accordion, only one open at a time) ──
  type ClonesSection = 'shared' | 'crosscohort' | 'dynamics' | 'shm' | null;
  let openSection: ClonesSection = 'dynamics';

  $: sharedOpen = openSection === 'shared';
  $: crossCohortOpen = openSection === 'crosscohort';
  $: dynamicsOpen = openSection === 'dynamics';
  $: shmAccumulationOpen = openSection === 'shm';

  function toggleSection(section: ClonesSection) {
    openSection = openSection === section ? null : section;
  }

  // ── Shared Clones state ──
  let topN = 20;
  let selectedCloneId: string | null = null;
  let activeVizTab: 'details' | 'heatmap' = 'heatmap';
  let timepointLabels: string[] = [];
  let selectedTimepoint: string = '';

  // ── Clonal Dynamics state ──
  let dynamicsData: ClonalDynamicsData | null = null;
  let dynamicsTopN = 30;
  let selectedDynamicsEntry: ClonalDynamicsEntry | null = null;
  let activeStatuses: Record<ClonalStatus, boolean> = {
    persistent: true, expanding: true, contracting: true, disappeared: true, late_emerging: true, transient: true
  };

  // ── View mode state ──
  let dynamicsViewMode: 'heatmap' | 'bubbles' | 'isotype' = 'heatmap';
  let bubbleColorMode: 'identity' | 'public_private' = 'identity';
  let bubbleRankingMode: 'overall' | 'per_timepoint' = 'overall';

  $: diseasePublicCloneIds = diseaseCohort
    ? getPublicCloneIds(diseaseCohort.fileGroups, diseaseCohort.timepointMapping)
    : new Set<number>();
  $: controlPublicCloneIds = controlCohort
    ? getPublicCloneIds(controlCohort.fileGroups, controlCohort.timepointMapping)
    : new Set<number>();
  $: singlePublicCloneIds = (!hasCohorts && activeFileGroups.length > 0)
    ? getPublicCloneIds(activeFileGroups, activeTimepointMapping)
    : new Set<number>();

  // ── Isotype tile data ──
  $: diseaseIsotypeTiles = (diseaseDynamicsData && diseaseCohort)
    ? computeIsotypePerCloneTimepoint(
        diseaseDynamicsData.entries.filter(e => activeStatuses[e.status]),
        diseaseCohort.fileGroups, diseaseCohort.timepointMapping, diseaseDynamicsData.timepointLabels
      )
    : [];
  $: controlIsotypeTiles = (controlDynamicsData && controlCohort)
    ? computeIsotypePerCloneTimepoint(
        controlDynamicsData.entries.filter(e => activeStatuses[e.status]),
        controlCohort.fileGroups, controlCohort.timepointMapping, controlDynamicsData.timepointLabels
      )
    : [];
  $: singleIsotypeTiles = (dynamicsData && !hasCohorts)
    ? computeIsotypePerCloneTimepoint(
        filteredDynamicsEntries,
        activeFileGroups, activeTimepointMapping, dynamicsData.timepointLabels
      )
    : [];

  function toggleStatusFilter(status: ClonalStatus) {
    activeStatuses = { ...activeStatuses, [status]: !activeStatuses[status] };
  }

  $: filteredDynamicsEntries = dynamicsData
    ? dynamicsData.entries.filter(e => activeStatuses[e.status])
    : [];
  $: if (selectedDynamicsEntry && !activeStatuses[selectedDynamicsEntry.status]) {
    selectedDynamicsEntry = null;
  }

  // ── Cross-cohort shared lineages (≥2 cohorts) ──
  /** Computed on demand when the section is first opened (expensive on big datasets). */
  let crossCohortClusters: CrossCohortCluster[] = [];
  let crossCohortComputed = false;
  let crossCohortComputing = false;
  /**
   * Per-cohort 2-state filter (exact subset match):
   *   - Pill active   → lineage MUST contain this cohort
   *   - Pill inactive → lineage MUST NOT contain this cohort
   * Default: all pills active → starts on truly-public lineages (all cohorts present).
   * Toggle a pill off to drop that cohort from the required set.
   */
  let activeCohorts: Set<string> = new Set();
  let cohortFilterInit = false;
  let isExportingCrossCohort = false;

  $: crossCohortAvailable = $resultsState.cohortResults.length >= 2;

  $: crossCohortAllCohortNames = $resultsState.cohortResults.map(
    c => c.cohortName || c.cohortType
  );

  // Initialize all pills active on first load and whenever the cohort list changes.
  $: {
    const names = crossCohortAllCohortNames;
    if (!cohortFilterInit && names.length > 0) {
      activeCohorts = new Set(names);
      cohortFilterInit = true;
    } else {
      // Drop entries for cohorts that no longer exist
      const next = new Set([...activeCohorts].filter(n => names.includes(n)));
      if (next.size !== activeCohorts.size) activeCohorts = next;
    }
  }

  function toggleCohortFilter(name: string) {
    const next = new Set(activeCohorts);
    if (next.has(name)) next.delete(name); else next.add(name);
    activeCohorts = next;
  }

  $: filteredCrossCohort = crossCohortClusters.filter(c => {
    // Exact-set match: lineage's cohort set must equal the active-pill set.
    if (c.cohorts.length !== activeCohorts.size) return false;
    for (const cn of c.cohorts) if (!activeCohorts.has(cn)) return false;
    return true;
  });

  /**
   * Total clone-assigned sequences per cohort, the denominator for the
   * "% of repertoire" cells in the table and export. Matches the within-cohort
   * shared_clones.xlsx denominator (sequences with non-null clone_id).
   */
  $: crossCohortTotals = (() => {
    const map: Record<string, number> = {};
    for (const c of $resultsState.cohortResults) {
      const name = c.cohortName || c.cohortType;
      let n = 0;
      for (const fg of c.fileGroups) for (const seq of fg.sequences) {
        if (seq.clone_id != null) n++;
      }
      map[name] = n;
    }
    return map;
  })();

  function ensureCrossCohortComputed() {
    if (crossCohortComputed || crossCohortComputing) return;
    crossCohortComputing = true;
    // Defer to next tick so the spinner can render
    setTimeout(() => {
      try {
        const cohorts = $resultsState.cohortResults.map((c, i) => ({
          cohort: c,
          color: GROUP_COLORS[i % GROUP_COLORS.length],
        }));
        crossCohortClusters = findCrossCohortClones(cohorts, { hammingFraction: 0.10, minCloneSize: 1 });
        crossCohortComputed = true;
      } finally {
        crossCohortComputing = false;
      }
    }, 30);
  }

  $: if (crossCohortOpen && crossCohortAvailable) ensureCrossCohortComputed();

  async function exportCrossCohort(scope: 'all' | 'selection' = 'all') {
    if (!crossCohortComputed) ensureCrossCohortComputed();
    isExportingCrossCohort = true;
    try {
      const data = scope === 'selection' ? filteredCrossCohort : crossCohortClusters;
      const fname = scope === 'selection'
        ? 'cross_cohort_lineages_selection.xlsx'
        : 'cross_cohort_lineages_all.xlsx';
      const wb = crossCohortClonesWorkbook(data, crossCohortAllCohortNames, crossCohortTotals);
      await downloadXlsx(wb, fname);
    } catch (err: any) {
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      isExportingCrossCohort = false;
    }
  }

  // ── Cohort state ──
  $: hasCohorts = $resultsState.cohortResults.length > 0;
  let selectedCohort: CohortType = 'disease';
  /** When the first cohort isn't disease/control (e.g. mouse N-cohort run),
   *  auto-snap selectedCohort to the first available cohort type. */
  $: if (hasCohorts && !$resultsState.cohortResults.find(c => c.cohortType === selectedCohort)) {
    selectedCohort = $resultsState.cohortResults[0].cohortType;
  }

  function getActiveCohort(): CohortResults | null {
    if (!hasCohorts) return null;
    return $resultsState.cohortResults.find(c => c.cohortType === selectedCohort) || null;
  }

  // Active data: uses cohort-specific data when cohorts exist, else global
  $: activeFileGroups = hasCohorts
    ? (getActiveCohort()?.fileGroups ?? $resultsState.fileGroups)
    : $resultsState.fileGroups;
  $: activeTimepointMapping = hasCohorts
    ? (getActiveCohort()?.timepointMapping ?? $resultsState.timepointMapping)
    : $resultsState.timepointMapping;
  $: activeTreeMetadata = hasCohorts
    ? (getActiveCohort()?.treeMetadata ?? $resultsState.treeMetadata)
    : $resultsState.treeMetadata;

  // Control cohort data for side-by-side dynamics
  $: controlCohort = $resultsState.cohortResults.find(c => c.cohortType === 'control') || null;
  $: diseaseCohort = $resultsState.cohortResults.find(c => c.cohortType === 'disease') || null;
  let controlDynamicsData: ClonalDynamicsData | null = null;
  let diseaseDynamicsData: ClonalDynamicsData | null = null;

  // ── SHM Accumulation data (longitudinal, clone-level) ──
  function buildDesignFromTpMapping(tpMapping: TimepointMapping, fileGroups: FileGroup[]): StudyDesign {
    const fileGroupNames = new Set(fileGroups.map(fg => fg.filename));
    const tpMap = new Map<string, string[]>();
    const tpOrder: string[] = [];
    for (const [stagedFile, entry] of Object.entries(tpMapping)) {
      if (!fileGroupNames.has(stagedFile)) continue;
      if (!tpMap.has(entry.timepoint)) { tpMap.set(entry.timepoint, []); tpOrder.push(entry.timepoint); }
      tpMap.get(entry.timepoint)!.push(stagedFile);
    }
    if (tpMap.size === 0) return { groups: [], unassigned: [] };
    return {
      groups: [{ id: 'auto', name: 'All Samples', color: GROUP_COLORS[0],
        timepoints: tpOrder.map((label, i) => ({ id: `tp-${i}`, label, order: i, files: tpMap.get(label) || [] }))
      }],
      unassigned: []
    };
  }

  // Only compute SHM accumulation when lineage_id data exists (cross-timepoint tracking)
  $: hasLineageData = (() => {
    const seqs = hasCohorts
      ? [...(diseaseCohort?.sequences ?? []), ...(controlCohort?.sequences ?? [])]
      : $resultsState.sequences;
    return seqs.some(s => s.lineage_id != null);
  })();

  $: shmLongitudinalData = (() => {
    if (!hasLineageData) return [];
    const result: LongitudinalGroupData[] = [];
    if (hasCohorts) {
      if (diseaseCohort) {
        const design = buildDesignFromTpMapping(diseaseCohort.timepointMapping, diseaseCohort.fileGroups);
        if (design.groups.length > 0 && design.groups[0].timepoints.length >= 2) {
          result.push(...computeLongitudinalAnalysis(design, diseaseCohort.sequences, diseaseCohort.fileGroups).map(g => ({
            ...g, groupName: diseaseCohort!.cohortName + ' – ' + g.groupName, groupColor: '#1565C0'
          })));
        }
      }
      if (controlCohort) {
        const design = buildDesignFromTpMapping(controlCohort.timepointMapping, controlCohort.fileGroups);
        if (design.groups.length > 0 && design.groups[0].timepoints.length >= 2) {
          result.push(...computeLongitudinalAnalysis(design, controlCohort.sequences, controlCohort.fileGroups).map(g => ({
            ...g, groupName: controlCohort!.cohortName + ' – ' + g.groupName, groupColor: '#757575'
          })));
        }
      }
    } else {
      const design = $studyDesign.groups.length > 0 ? $studyDesign
        : buildDesignFromTpMapping($resultsState.timepointMapping, $resultsState.fileGroups);
      if (design.groups.length > 0 && design.groups[0].timepoints.length >= 2) {
        result.push(...computeLongitudinalAnalysis(design, $resultsState.sequences, $resultsState.fileGroups));
      }
    }
    return result;
  })();

  $: hasResults = $resultsState.publicClonesData !== null;
  $: selectedClone = hasResults && selectedCloneId
    ? $resultsState.publicClonesData!.public_clones.find(c => c.id === selectedCloneId) || null
    : null;
  $: hasTimepoints = timepointLabels.length > 0;

  onMount(() => {
    timepointLabels = getTimepointLabels(activeTimepointMapping);
    if (timepointLabels.length > 0 && !selectedTimepoint) {
      selectedTimepoint = timepointLabels[0];
    }
    recomputeShared();
    recomputeDynamics();
  });

  // When cohort or timepoint changes, recompute
  $: if (selectedTimepoint && activeFileGroups.length > 0) {
    recomputeShared();
  }
  $: if (hasCohorts && selectedCohort) {
    timepointLabels = getTimepointLabels(activeTimepointMapping);
    if (timepointLabels.length > 0 && !timepointLabels.includes(selectedTimepoint)) {
      selectedTimepoint = timepointLabels[0];
    }
  }

  function recomputeShared() {
    if (activeFileGroups.length === 0) return;
    const data = hasTimepoints && selectedTimepoint
      ? computePublicClonesPerTimepoint(activeFileGroups, activeTimepointMapping, selectedTimepoint, { topN })
      : computePublicClones(activeFileGroups, activeTimepointMapping, { topN });
    publicClonesActions.updateResults(data);
    selectedCloneId = data.top_x.length > 0 ? data.top_x[0].id : null;
  }

  function recomputeDynamics() {
    if (hasCohorts) {
      if (diseaseCohort && diseaseCohort.fileGroups.length > 0) {
        diseaseDynamicsData = computeClonalDynamicsHeatmap(diseaseCohort.fileGroups, diseaseCohort.timepointMapping, dynamicsTopN);
      }
      if (controlCohort && controlCohort.fileGroups.length > 0) {
        controlDynamicsData = computeClonalDynamicsHeatmap(controlCohort.fileGroups, controlCohort.timepointMapping, dynamicsTopN);
      }
      dynamicsData = diseaseDynamicsData;
    } else {
      if (activeFileGroups.length === 0) return;
      dynamicsData = computeClonalDynamicsHeatmap(activeFileGroups, activeTimepointMapping, dynamicsTopN);
    }
  }

  function selectClone(cloneId: string) {
    selectedCloneId = cloneId;
  }

  function selectCloneByIndex(index: number) {
    if ($resultsState.publicClonesData && index < $resultsState.publicClonesData.public_clones.length) {
      selectedCloneId = $resultsState.publicClonesData.public_clones[index].id;
      activeVizTab = 'details';
    }
  }

  function handleTopNChange() {
    publicClonesActions.clearResults();
    recomputeShared();
  }

  function handleDynamicsTopNChange() {
    recomputeDynamics();
  }

  let selectedDynamicsTimepoint: string | null = null;
  let selectedDynamicsCohortType: CohortType | null = null;

  function handleDynamicsCloneClick(entry: ClonalDynamicsEntry, timepoint?: string) {
    selectedDynamicsEntry = entry;
    selectedDynamicsTimepoint = timepoint ?? null;
  }

  function handleDiseaseCloneClick(entry: ClonalDynamicsEntry, timepoint?: string) {
    selectedDynamicsEntry = entry;
    selectedDynamicsTimepoint = timepoint ?? null;
    selectedDynamicsCohortType = 'disease';
  }

  function handleControlCloneClick(entry: ClonalDynamicsEntry, timepoint?: string) {
    selectedDynamicsEntry = entry;
    selectedDynamicsTimepoint = timepoint ?? null;
    selectedDynamicsCohortType = 'control';
  }

  // Find matching tree for the selected dynamics entry + timepoint
  function findDynamicsTree(
    entry: ClonalDynamicsEntry | null,
    tp: string | null,
    treeMeta: TreeMetadata[]
  ): { index: number; meta: TreeMetadata } | null {
    if (!entry || !treeMeta?.length) return null;

    const cloneIds = new Set<number>();

    if (tp && entry.cloneIdsByTimepoint?.[tp]) {
      for (const cid of entry.cloneIdsByTimepoint[tp]) cloneIds.add(cid);
    } else {
      if (entry.cloneIdsByTimepoint) {
        for (const cids of Object.values(entry.cloneIdsByTimepoint)) {
          for (const cid of cids) cloneIds.add(cid);
        }
      }
      if (cloneIds.size === 0) cloneIds.add(entry.cloneId);
    }

    let best: { index: number; meta: TreeMetadata } | null = null;
    treeMeta.forEach((m, i) => {
      if (m.clone_id == null || !cloneIds.has(m.clone_id)) return;
      if (tp && m.timepoint && m.timepoint !== tp) return;
      if (!best || (m.clone_size ?? 0) > (best.meta.clone_size ?? 0)) {
        best = { index: i, meta: m };
      }
    });

    if (!best && tp) {
      treeMeta.forEach((m, i) => {
        if (m.clone_id == null || !cloneIds.has(m.clone_id)) return;
        if (!best || (m.clone_size ?? 0) > (best.meta.clone_size ?? 0)) {
          best = { index: i, meta: m };
        }
      });
    }

    return best;
  }

  $: dynamicsTreeMetadata = (() => {
    if (hasCohorts && selectedDynamicsCohortType) {
      const cohort = $resultsState.cohortResults.find(c => c.cohortType === selectedDynamicsCohortType);
      return cohort?.treeMetadata ?? [];
    }
    return activeTreeMetadata;
  })();

  $: selectedDynamicsTree = findDynamicsTree(
    selectedDynamicsEntry,
    selectedDynamicsTimepoint,
    dynamicsTreeMetadata
  );

  function getTreeNewickPath(pngPath: string): string {
    return pngPath.replace('.png', '.newick');
  }

  function getTreeLabel(meta: TreeMetadata): string {
    const cid = meta.clone_id;
    const size = meta.clone_size;
    const tp = meta.timepoint;
    let label = cid != null ? `Clone ${cid}` : 'Tree';
    if (size > 0) label += ` (${size} seqs)`;
    if (tp) label += `, ${tp}`;
    return label;
  }

  function getPatientColor(index: number): string {
    const colors = [
      '#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9B27B0',
      '#00BCD4', '#CDDC39', '#FF5722', '#795548', '#607D8B'
    ];
    return colors[index % colors.length];
  }

  function cloneDisplayId(id: string): string {
    return id.replace('clone_', 'Clone ');
  }

  function pct(count: number, total: number): string {
    if (total === 0) return '0%';
    return (count / total * 100).toFixed(1) + '%';
  }

  // ── Figure export refs ──
  let diseaseHeatmapRef: ClonalDynamicsHeatmap;
  let diseaseBubblesRef: ClonalDynamicsBubbles;
  let diseaseIsotypeRef: ClonalDynamicsIsotypeTiles;
  let controlHeatmapRef: ClonalDynamicsHeatmap;
  let controlBubblesRef: ClonalDynamicsBubbles;
  let controlIsotypeRef: ClonalDynamicsIsotypeTiles;
  let singleHeatmapRef: ClonalDynamicsHeatmap;
  let singleBubblesRef: ClonalDynamicsBubbles;
  let singleIsotypeRef: ClonalDynamicsIsotypeTiles;

  async function exportCurrentFigure(cohort: 'disease' | 'control' | 'single') {
    try {
      if (cohort === 'disease') {
        if (dynamicsViewMode === 'heatmap') await diseaseHeatmapRef?.exportPng();
        else if (dynamicsViewMode === 'bubbles') await diseaseBubblesRef?.exportPng();
        else await diseaseIsotypeRef?.exportPng();
      } else if (cohort === 'control') {
        if (dynamicsViewMode === 'heatmap') await controlHeatmapRef?.exportPng();
        else if (dynamicsViewMode === 'bubbles') await controlBubblesRef?.exportPng();
        else await controlIsotypeRef?.exportPng();
      } else {
        if (dynamicsViewMode === 'heatmap') await singleHeatmapRef?.exportPng();
        else if (dynamicsViewMode === 'bubbles') await singleBubblesRef?.exportPng();
        else await singleIsotypeRef?.exportPng();
      }
    } catch (err: any) {
      alert(`Figure export failed: ${err.message || 'Unknown error'}`);
    }
  }

  // ── Export functions ──
  let isExportingShared = false;
  let isExportingDynamics = false;

  async function exportSharedClones() {
    isExportingShared = true;
    try {
      const wb = sharedClonesWorkbook({
        fileGroups: $resultsState.fileGroups,
        timepointMapping: $resultsState.timepointMapping,
        cohortResults: $resultsState.cohortResults
      });
      if (!wb.SheetNames.length) { alert('No shared clones to export'); return; }
      await downloadXlsx(wb, 'shared_clones.xlsx');
    } catch (err: any) {
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      isExportingShared = false;
    }
  }

  async function exportClonalDynamics() {
    isExportingDynamics = true;
    try {
      const primaryDynamics = hasCohorts ? diseaseDynamicsData : dynamicsData;
      const tpLabels = primaryDynamics?.timepointLabels ?? [];

      // Recompute isotype tiles from ALL entries (not just topN) for the export
      const allDiseaseTiles = (primaryDynamics && (hasCohorts ? diseaseCohort : true))
        ? computeIsotypePerCloneTimepoint(
            primaryDynamics.allEntries,
            hasCohorts ? diseaseCohort!.fileGroups : activeFileGroups,
            hasCohorts ? diseaseCohort!.timepointMapping : activeTimepointMapping,
            tpLabels
          )
        : [];
      const allControlTiles = (hasCohorts && controlDynamicsData && controlCohort)
        ? computeIsotypePerCloneTimepoint(
            controlDynamicsData.allEntries,
            controlCohort.fileGroups, controlCohort.timepointMapping,
            controlDynamicsData.timepointLabels
          )
        : undefined;

      const wb = clonalDynamicsWorkbook({
        dynamicsData: primaryDynamics,
        cohortName: hasCohorts ? (diseaseCohort?.cohortName ?? 'Disease') : undefined,
        controlDynamicsData: hasCohorts ? controlDynamicsData : undefined,
        controlCohortName: hasCohorts ? (controlCohort?.cohortName ?? 'Control') : undefined,
        isotypeTiles: allDiseaseTiles,
        isotypeTimepointLabels: tpLabels,
        controlIsotypeTiles: allControlTiles,
        controlIsotypeTimepointLabels: hasCohorts ? (controlDynamicsData?.timepointLabels ?? []) : undefined
      });
      if (!wb) { alert('No clonal dynamics data to export'); return; }
      await downloadXlsx(wb, 'clonal_dynamics.xlsx');
    } catch (err: any) {
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      isExportingDynamics = false;
    }
  }

</script>

<div class="public-clones-container">
  {#if $resultsState.sequences.length === 0}
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <circle cx="20" cy="28" r="8" stroke="currentColor" stroke-width="2"/>
          <circle cx="44" cy="28" r="8" stroke="currentColor" stroke-width="2"/>
          <path d="M28 28h8M32 16v4M32 44v4M20 42c4 4 20 4 24 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <h3 class="empty-title">No Analysis Data</h3>
      <p class="empty-description">
        Run the main analysis first to identify public clones shared across patients.
      </p>
    </div>
  {:else}
    <div class="sections-scroll">

      <!-- ═══════════════════════════════════════════════════════════════════
           SECTION 1: Shared Clones (per timepoint)
           ═══════════════════════════════════════════════════════════════════ -->
      <section class="collapsible-section">
        <button class="section-header" on:click={() => toggleSection('shared')}>
          <span class="section-chevron" class:open={sharedOpen}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <h2 class="section-title">Shared Clones</h2>
          <span class="section-subtitle">per timepoint</span>
          {#if $resultsState.publicClonesData}
            <span class="section-badge">{$resultsState.publicClonesData.stats.total_public_clones} found</span>
          {/if}
          <button
            class="section-export-btn"
            on:click|stopPropagation={exportSharedClones}
            disabled={isExportingShared}
            title="Export shared clones (all timepoints, all cohorts) to CSV"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            {isExportingShared ? '...' : 'Export All'}
          </button>
        </button>

        {#if sharedOpen}
          <div class="section-body">
            {#if hasTimepoints}
              <div class="info-banner-subtle">
                Clones shared across 2+ patients within a timepoint. Select a timepoint below.
              </div>
            {/if}

            <!-- Cohort selector (when cohorts present). Colours come from
                 GROUP_COLORS by cohort index so N-cohort studies (e.g. mouse
                 treatment arms) get distinct hues instead of all-blue. -->
            {#if hasCohorts}
              <div class="cohort-selector">
                <span class="cohort-selector-label">Group:</span>
                {#each $resultsState.cohortResults as cohort, ci (cohort.cohortType)}
                  {@const color = GROUP_COLORS[ci % GROUP_COLORS.length]}
                  <button
                    class="cohort-pill"
                    class:active={selectedCohort === cohort.cohortType}
                    style="--cohort-color: {color}; {selectedCohort === cohort.cohortType ? `background: ${color}1a; border-color: ${color}; color: ${color};` : ''}"
                    on:click={() => { selectedCohort = cohort.cohortType; recomputeShared(); }}
                  >
                    <span class="cohort-pill-dot" style="background: {color}"></span>
                    {cohort.cohortName}
                  </button>
                {/each}
              </div>
            {/if}

            <!-- Timepoint selector -->
            {#if hasTimepoints}
              <div class="tp-selector">
                {#each timepointLabels as tp}
                  <button
                    class="tp-pill"
                    class:active={selectedTimepoint === tp}
                    on:click={() => { selectedTimepoint = tp; }}
                  >
                    {tp}
                  </button>
                {/each}
              </div>
            {/if}

            {#if !hasResults}
              <div class="loading-state">
                <div class="spinner"></div>
                <span>Computing shared clones...</span>
              </div>
            {:else if $resultsState.publicClonesData && $resultsState.publicClonesData.public_clones.length === 0}
              <div class="empty-inline">
                No clones are shared across multiple patients in {selectedTimepoint || 'this dataset'}.
              </div>
            {:else}
              <!-- Stats row -->
              <div class="stats-dashboard">
                <div class="stat-card">
                  <div class="stat-value">{$resultsState.publicClonesData?.stats.total_public_clones ?? 0}</div>
                  <div class="stat-label">Shared Clones</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{$resultsState.publicClonesData?.stats.total_patients ?? 0}</div>
                  <div class="stat-label">Patients</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{$resultsState.publicClonesData?.stats.max_patient_sharing ?? 0}</div>
                  <div class="stat-label">Max Sharing</div>
                </div>
                <div class="stat-card">
                  <div class="stat-value">{$resultsState.publicClonesData?.stats.total_sequences_in_public_clones ?? 0}</div>
                  <div class="stat-label">Total Sequences</div>
                </div>
              </div>

              <!-- Split view -->
              <div class="shared-content">
                <!-- Left: Clone list -->
                <div class="clones-list">
                  <div class="list-header">
                    <h3>Shared Clones</h3>
                    <label class="topn-label">
                      Top
                      <select bind:value={topN} on:change={handleTopNChange}>
                        <option value={10}>10</option>
                        <option value={20}>20</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                      </select>
                    </label>
                  </div>
                  <div class="clone-cards">
                    {#each ($resultsState.publicClonesData?.top_x ?? []) as clone, index}
                      <button
                        class="clone-card"
                        class:selected={selectedCloneId === clone.id}
                        on:click={() => selectClone(clone.id)}
                      >
                        <div class="clone-rank">#{index + 1}</div>
                        <div class="clone-info">
                          <div class="clone-id-label">{cloneDisplayId(clone.id)}</div>
                          <code class="cdr3-subtitle">{clone.cdr3_aa || '(no CDR3)'}</code>
                          <div class="clone-genes">
                            {#if clone.v_gene}<span class="gene-badge v-gene">{clone.v_gene}</span>{/if}
                            {#if clone.j_gene}<span class="gene-badge j-gene">{clone.j_gene}</span>{/if}
                          </div>
                          <div class="clone-metrics">
                            <span class="metric">{clone.patient_count} patients</span>
                            <span class="metric">{clone.sequence_count} seqs</span>
                          </div>
                        </div>
                      </button>
                    {/each}
                  </div>
                </div>

                <!-- Right: Detail/Heatmap -->
                <div class="details-panel">
                  <div class="detail-tabs">
                    <button class="tab" class:active={activeVizTab === 'heatmap'} on:click={() => activeVizTab = 'heatmap'}>
                      Patient &times; Clone Heatmap
                    </button>
                    <button class="tab" class:active={activeVizTab === 'details'} on:click={() => activeVizTab = 'details'}>
                      Clone Details
                    </button>
                  </div>

                  <div class="detail-content" class:heatmap-active={activeVizTab === 'heatmap'}>
                    {#if activeVizTab === 'heatmap' && $resultsState.publicClonesData}
                      <div class="heatmap-wrapper">
                        <HeatmapViz
                          data={$resultsState.publicClonesData.visualizations.heatmap}
                          onCloneClick={selectCloneByIndex}
                        />
                      </div>
                    {:else if activeVizTab === 'details'}
                      {#if selectedClone}
                        <div class="clone-detail">
                          <h2 class="detail-title">{cloneDisplayId(selectedClone.id)}</h2>
                          <div class="detail-card">
                            <h3>CDR3 Region</h3>
                            <div class="detail-row">
                              <span class="detail-label">Amino Acid:</span>
                              <code>{selectedClone.cdr3_aa}</code>
                            </div>
                            {#if selectedClone.cdr3_dna}
                              <div class="detail-row">
                                <span class="detail-label">DNA:</span>
                                <code class="dna">{selectedClone.cdr3_dna}</code>
                              </div>
                            {/if}
                            <div class="detail-row">
                              <span class="detail-label">Length:</span>
                              <span>{selectedClone.cdr3_aa.length} aa</span>
                            </div>
                          </div>
                          <div class="detail-card">
                            <h3>Gene Usage</h3>
                            <div class="detail-row">
                              <span class="detail-label">V Gene:</span>
                              <span>{selectedClone.v_gene}</span>
                            </div>
                            <div class="detail-row">
                              <span class="detail-label">J Gene:</span>
                              <span>{selectedClone.j_gene}</span>
                            </div>
                          </div>
                          <div class="detail-card">
                            <h3>Patient Distribution ({selectedClone.patient_count} patients, {selectedClone.sequence_count} sequences)</h3>
                            <div class="patient-list">
                              {#each selectedClone.patients as patient, pidx}
                                <div class="patient-item" style="border-left: 4px solid {getPatientColor(pidx)}">
                                  <div class="patient-name">{patient}</div>
                                  <div class="patient-count">
                                    {(selectedClone.sequences_by_patient?.[patient]?.length ?? 0)} sequences
                                  </div>
                                </div>
                              {/each}
                            </div>
                          </div>
                        </div>
                      {:else}
                        <div class="empty-selection">
                          <p>Select a clone from the list to view details</p>
                        </div>
                      {/if}
                    {/if}
                  </div>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </section>

      <!-- ═══════════════════════════════════════════════════════════════════
           SECTION 1B: Cross-Cohort Shared Lineages
           Pools clones across cohorts and re-clusters by V/J/CDR3 similarity
           to detect lineages that genuinely span treatment groups (vs. just
           convergent rearrangements within one group).
           ═══════════════════════════════════════════════════════════════════ -->
      {#if crossCohortAvailable}
        <section class="collapsible-section">
          <button class="section-header" on:click={() => toggleSection('crosscohort')}>
            <span class="section-chevron" class:open={crossCohortOpen}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <h2 class="section-title">Cross-Cohort Shared Lineages</h2>
            <span class="section-subtitle">re-clustered across groups</span>
            {#if crossCohortComputed}
              <span class="section-badge">{filteredCrossCohort.length} lineages</span>
            {/if}
            <button
              class="section-export-btn"
              on:click|stopPropagation={() => exportCrossCohort('selection')}
              disabled={isExportingCrossCohort || !crossCohortComputed || filteredCrossCohort.length === 0}
              title="Export only the lineages matching the current cohort filter"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              {isExportingCrossCohort ? '...' : 'Export Selection'}
            </button>
            <button
              class="section-export-btn"
              on:click|stopPropagation={() => exportCrossCohort('all')}
              disabled={isExportingCrossCohort || !crossCohortComputed}
              title="Export all cross-cohort shared lineages (every spanning combination) to XLSX"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              {isExportingCrossCohort ? '...' : 'Export All'}
            </button>
          </button>

          {#if crossCohortOpen}
            <div class="section-body">
              <div class="info-banner-subtle">
                Per-cohort clones are re-bucketed by V-family + J-family + CDR3 length, then
                clustered by CDR3 amino-acid Hamming distance (≤10% of CDR3 length).
                A lineage spanning ≥2 cohorts is shown here. Lineages spanning <em>all</em>
                cohorts are likely constitutive public clones (not treatment-driven);
                lineages restricted to a subset of cohorts are candidate group-specific responses.
              </div>

              {#if crossCohortComputing}
                <div class="empty-state-sm"><p>Clustering cross-cohort lineages…</p></div>
              {:else if !crossCohortComputed}
                <div class="empty-state-sm"><p>Preparing…</p></div>
              {:else if crossCohortClusters.length === 0}
                <div class="empty-state-sm"><p>No cross-cohort lineages detected.</p></div>
              {:else}
                <!-- Per-cohort 2-state filter (exact subset match):
                     active pill = cohort MUST be in the lineage,
                     inactive pill = cohort MUST NOT be in the lineage.
                     Toggle pills to ask "in A,B,C but not D?" etc. -->
                <div class="cc-filter-row">
                  <span class="filter-label">Show lineages present in:</span>
                  {#each crossCohortAllCohortNames as cn, ci}
                    {@const isActive = activeCohorts.has(cn)}
                    {@const color = GROUP_COLORS[ci % GROUP_COLORS.length]}
                    <button
                      class="cc-pill"
                      class:cc-pill-active={isActive}
                      style={isActive ? `--cc-color: ${color}` : ''}
                      on:click={() => toggleCohortFilter(cn)}
                      title={isActive
                        ? `${cn} must be present, click to exclude`
                        : `${cn} must be absent, click to require`}
                    >
                      {cn}
                    </button>
                  {/each}
                  <span class="cc-count">({filteredCrossCohort.length} shown)</span>
                </div>

                <div class="cc-table-wrap">
                  <table class="cc-table">
                    <thead>
                      <tr>
                        <th>V / J</th>
                        <th>CDR3 len</th>
                        <th>Cohorts</th>
                        <th class="num">Total seqs</th>
                        <th class="num">Unique CDR3s</th>
                        {#each crossCohortAllCohortNames as cn, ci}
                          <th class="num" style="color: {GROUP_COLORS[ci % GROUP_COLORS.length]}" colspan="2">{cn}</th>
                        {/each}
                        <th>Top CDR3 (largest member)</th>
                      </tr>
                      <tr class="cc-subhead">
                        <th colspan="5"></th>
                        {#each crossCohortAllCohortNames as cn}
                          <th class="num cc-subhead-cell">seqs</th>
                          <th class="num cc-subhead-cell" title={`Total clone-assigned sequences in ${cn}: ${(crossCohortTotals[cn] ?? 0).toLocaleString()}`}>% rep.</th>
                        {/each}
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each filteredCrossCohort.slice(0, 200) as c (c.id)}
                        <tr>
                          <td>{c.v_family} / {c.j_family}</td>
                          <td class="num">{c.cdr3_length}</td>
                          <td>
                            <span class="cc-cohort-badge" class:full={c.cohorts.length === crossCohortAllCohortNames.length}>
                              {c.cohorts.length}/{crossCohortAllCohortNames.length}
                            </span>
                          </td>
                          <td class="num"><strong>{c.total_sequences.toLocaleString()}</strong></td>
                          <td class="num">{c.unique_cdr3_count}</td>
                          {#each crossCohortAllCohortNames as cn}
                            {@const b = c.cohort_breakdown[cn]}
                            {@const tot = crossCohortTotals[cn] ?? 0}
                            {@const pct = b && tot > 0 ? (b.sequences / tot) * 100 : 0}
                            <td class="num cc-cell" class:cc-cell-empty={!b}>
                              {b ? b.sequences.toLocaleString() : '-'}
                            </td>
                            <td class="num cc-cell cc-cell-pct" class:cc-cell-empty={!b || tot === 0}>
                              {b && tot > 0 ? (pct >= 1 ? pct.toFixed(2) : pct.toFixed(3)) + '%' : '-'}
                            </td>
                          {/each}
                          <td class="cdr3-cell">{c.members[0]?.cdr3_aa ?? '-'}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                  {#if filteredCrossCohort.length > 200}
                    <p class="cc-truncated">Showing top 200 of {filteredCrossCohort.length} lineages, use Export for the full list.</p>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      <!-- ═══════════════════════════════════════════════════════════════════
           SECTION 2: Clonal Dynamics (across timepoints)
           ═══════════════════════════════════════════════════════════════════ -->
      {#if hasTimepoints}
        <section class="collapsible-section">
          <button class="section-header" on:click={() => toggleSection('dynamics')}>
            <span class="section-chevron" class:open={dynamicsOpen}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <h2 class="section-title">Clonal Dynamics</h2>
            <span class="section-subtitle">across timepoints</span>
            {#if dynamicsData}
              <span class="section-badge">{dynamicsData.stats.total} tracked</span>
            {/if}
            {#if dynamicsData && dynamicsData.entries.length > 0}
              <button
                class="section-export-btn"
                on:click|stopPropagation={exportClonalDynamics}
                disabled={isExportingDynamics}
                title="Export all clonal dynamics data (heatmap, bubbles, isotype) to CSV"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                {isExportingDynamics ? '...' : 'Export All'}
              </button>
            {/if}
          </button>

          {#if dynamicsOpen}
            <div class="section-body">

              {#if dynamicsData && dynamicsData.entries.length > 0}
                <!-- Status filter pills + Top-N control -->
                <div class="status-filter-row">
                  <span class="status-filter-label">Show:</span>
                  <div class="status-pills">
                    {#each DYNAMICS_STATUSES as { value, label }}
                      <button
                        type="button"
                        class="status-pill-filter"
                        class:active={activeStatuses[value]}
                        class:inactive={!activeStatuses[value]}
                        class:persistent={value === 'persistent'}
                        class:expanding={value === 'expanding'}
                        class:contracting={value === 'contracting'}
                        class:disappeared={value === 'disappeared'}
                        class:late_emerging={value === 'late_emerging'}
                        class:transient={value === 'transient'}
                        on:click={() => toggleStatusFilter(value)}
                      >
                        {label}
                      </button>
                    {/each}
                  </div>
                  {#if dynamicsViewMode === 'bubbles'}
                    <label class="bubble-control-label">
                      Color:
                      <select bind:value={bubbleColorMode}>
                        <option value="identity">Clone Identity</option>
                        <option value="public_private">Public / Private</option>
                      </select>
                    </label>
                    <label class="bubble-control-label">
                      Rank:
                      <select bind:value={bubbleRankingMode}>
                        <option value="overall">Top N overall</option>
                        <option value="per_timepoint">Top N per timepoint</option>
                      </select>
                    </label>
                  {/if}

                  <label class="topn-label">
                    Show top
                    <select bind:value={dynamicsTopN} on:change={handleDynamicsTopNChange}>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={30}>30</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={250}>250</option>
                    </select>
                    clones
                  </label>

                  <div class="dynamics-view-toggle">
                    <button
                      type="button"
                      class="view-toggle-btn"
                      class:active={dynamicsViewMode === 'heatmap'}
                      on:click={() => dynamicsViewMode = 'heatmap'}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>
                      Heatmap
                    </button>
                    <button
                      type="button"
                      class="view-toggle-btn"
                      class:active={dynamicsViewMode === 'bubbles'}
                      on:click={() => dynamicsViewMode = 'bubbles'}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="11" r="3" stroke="currentColor" stroke-width="1.5"/><circle cx="3" cy="13" r="2" stroke="currentColor" stroke-width="1.5"/></svg>
                      Bubbles
                    </button>
                    <button
                      type="button"
                      class="view-toggle-btn"
                      class:active={dynamicsViewMode === 'isotype'}
                      on:click={() => dynamicsViewMode = 'isotype'}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="14" height="4" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1" y="7" width="14" height="4" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1" y="11" width="8" height="4" rx="1" stroke="currentColor" stroke-width="1.3" fill="currentColor" fill-opacity="0.15"/></svg>
                      Isotype
                    </button>
                  </div>
                </div>

                <!-- Stats (only shown when no cohorts; cohort stats are inline with heatmaps below) -->
                {#if !(hasCohorts && diseaseDynamicsData && controlDynamicsData)}
                  <div class="dynamics-stats">
                    <div class="dstat persistent"><span class="dstat-val">{dynamicsData.stats.persistent}</span><span class="dstat-pct">{pct(dynamicsData.stats.persistent, dynamicsData.stats.total)}</span><span class="dstat-label">Persistent</span></div>
                    <div class="dstat expanding"><span class="dstat-val">{dynamicsData.stats.expanding}</span><span class="dstat-pct">{pct(dynamicsData.stats.expanding, dynamicsData.stats.total)}</span><span class="dstat-label">Expanding</span></div>
                    <div class="dstat contracting"><span class="dstat-val">{dynamicsData.stats.contracting}</span><span class="dstat-pct">{pct(dynamicsData.stats.contracting, dynamicsData.stats.total)}</span><span class="dstat-label">Contracting</span></div>
                    <div class="dstat disappeared"><span class="dstat-val">{dynamicsData.stats.disappeared}</span><span class="dstat-pct">{pct(dynamicsData.stats.disappeared, dynamicsData.stats.total)}</span><span class="dstat-label">Disappeared</span></div>
                    <div class="dstat late-emerging"><span class="dstat-val">{dynamicsData.stats.lateEmerging}</span><span class="dstat-pct">{pct(dynamicsData.stats.lateEmerging, dynamicsData.stats.total)}</span><span class="dstat-label">Late Emerging</span></div>
                  </div>
                {/if}

                {#if hasCohorts && diseaseDynamicsData && controlDynamicsData}
                  <!-- 2-column layout: side-by-side heatmaps (left) | detail + tree (right) -->
                  <div class="dynamics-cohort-split">
                    <!-- Left: side-by-side heatmaps/bubbles with inline stats -->
                    <div class="dynamics-cohort-heatmaps">
                      <div class="dynamics-cohort-hm">
                        <div class="dynamics-dual-label cohort-label-disease">
                          {diseaseCohort?.cohortName || 'Disease'}
                          <button class="fig-export-btn" on:click={() => exportCurrentFigure('disease')} title="Export figure as PNG">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            PNG
                          </button>
                        </div>
                        <div class="dynamics-inline-stats">
                          <div class="dstat-inline persistent"><span class="dstat-val">{diseaseDynamicsData.stats.persistent} <span class="dstat-pct-inline">({pct(diseaseDynamicsData.stats.persistent, diseaseDynamicsData.stats.total)})</span></span><span class="dstat-label">Pers.</span></div>
                          <div class="dstat-inline expanding"><span class="dstat-val">{diseaseDynamicsData.stats.expanding} <span class="dstat-pct-inline">({pct(diseaseDynamicsData.stats.expanding, diseaseDynamicsData.stats.total)})</span></span><span class="dstat-label">Exp.</span></div>
                          <div class="dstat-inline contracting"><span class="dstat-val">{diseaseDynamicsData.stats.contracting} <span class="dstat-pct-inline">({pct(diseaseDynamicsData.stats.contracting, diseaseDynamicsData.stats.total)})</span></span><span class="dstat-label">Contr.</span></div>
                          <div class="dstat-inline disappeared"><span class="dstat-val">{diseaseDynamicsData.stats.disappeared} <span class="dstat-pct-inline">({pct(diseaseDynamicsData.stats.disappeared, diseaseDynamicsData.stats.total)})</span></span><span class="dstat-label">Disapp.</span></div>
                          <div class="dstat-inline late-emerging"><span class="dstat-val">{diseaseDynamicsData.stats.lateEmerging} <span class="dstat-pct-inline">({pct(diseaseDynamicsData.stats.lateEmerging, diseaseDynamicsData.stats.total)})</span></span><span class="dstat-label">Late</span></div>
                        </div>
                        {#if dynamicsViewMode === 'heatmap'}
                          <div style="max-height: calc(100vh - 420px); overflow-y: auto; overflow-x: auto; border: 1px solid var(--border-light); border-radius: 8px;">
                            <ClonalDynamicsHeatmap
                              bind:this={diseaseHeatmapRef}
                              entries={diseaseDynamicsData.entries.filter(e => activeStatuses[e.status])}
                              timepointLabels={diseaseDynamicsData.timepointLabels}
                              timepointTotals={diseaseDynamicsData.timepointTotals}
                              onCloneClick={handleDiseaseCloneClick}
                              cohortLabel={diseaseCohort?.cohortName || 'Disease'}
                            />
                          </div>
                        {:else if dynamicsViewMode === 'bubbles'}
                          <div style="max-height: calc(100vh - 420px); overflow-y: auto; border: 1px solid var(--border-light); border-radius: 8px; padding: 8px;">
                            <ClonalDynamicsBubbles
                              bind:this={diseaseBubblesRef}
                              entries={diseaseDynamicsData.entries.filter(e => activeStatuses[e.status])}
                              timepointLabels={diseaseDynamicsData.timepointLabels}
                              timepointTotals={diseaseDynamicsData.timepointTotals}
                              onCloneClick={handleDiseaseCloneClick}
                              colorMode={bubbleColorMode}
                              rankingMode={bubbleRankingMode}
                              publicCloneIds={diseasePublicCloneIds}
                              cohortLabel={diseaseCohort?.cohortName || 'Disease'}
                            />
                          </div>
                        {:else}
                          <div style="max-height: calc(100vh - 420px); overflow-y: auto; overflow-x: auto; border: 1px solid var(--border-light); border-radius: 8px; padding: 8px;">
                            <ClonalDynamicsIsotypeTiles
                              bind:this={diseaseIsotypeRef}
                              tileEntries={diseaseIsotypeTiles}
                              timepointLabels={diseaseDynamicsData.timepointLabels}
                              onCloneClick={handleDiseaseCloneClick}
                              dynamicsEntries={diseaseDynamicsData.entries.filter(e => activeStatuses[e.status])}
                              cohortLabel={diseaseCohort?.cohortName || 'Disease'}
                            />
                          </div>
                        {/if}
                      </div>
                      <div class="dynamics-cohort-hm">
                        <div class="dynamics-dual-label cohort-label-control">
                          {controlCohort?.cohortName || 'Control'}
                          <button class="fig-export-btn" on:click={() => exportCurrentFigure('control')} title="Export figure as PNG">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            PNG
                          </button>
                        </div>
                        <div class="dynamics-inline-stats">
                          <div class="dstat-inline persistent"><span class="dstat-val">{controlDynamicsData.stats.persistent} <span class="dstat-pct-inline">({pct(controlDynamicsData.stats.persistent, controlDynamicsData.stats.total)})</span></span><span class="dstat-label">Pers.</span></div>
                          <div class="dstat-inline expanding"><span class="dstat-val">{controlDynamicsData.stats.expanding} <span class="dstat-pct-inline">({pct(controlDynamicsData.stats.expanding, controlDynamicsData.stats.total)})</span></span><span class="dstat-label">Exp.</span></div>
                          <div class="dstat-inline contracting"><span class="dstat-val">{controlDynamicsData.stats.contracting} <span class="dstat-pct-inline">({pct(controlDynamicsData.stats.contracting, controlDynamicsData.stats.total)})</span></span><span class="dstat-label">Contr.</span></div>
                          <div class="dstat-inline disappeared"><span class="dstat-val">{controlDynamicsData.stats.disappeared} <span class="dstat-pct-inline">({pct(controlDynamicsData.stats.disappeared, controlDynamicsData.stats.total)})</span></span><span class="dstat-label">Disapp.</span></div>
                          <div class="dstat-inline late-emerging"><span class="dstat-val">{controlDynamicsData.stats.lateEmerging} <span class="dstat-pct-inline">({pct(controlDynamicsData.stats.lateEmerging, controlDynamicsData.stats.total)})</span></span><span class="dstat-label">Late</span></div>
                        </div>
                        {#if dynamicsViewMode === 'heatmap'}
                          <div style="max-height: calc(100vh - 420px); overflow-y: auto; overflow-x: auto; border: 1px solid var(--border-light); border-radius: 8px;">
                            <ClonalDynamicsHeatmap
                              bind:this={controlHeatmapRef}
                              entries={controlDynamicsData.entries.filter(e => activeStatuses[e.status])}
                              timepointLabels={controlDynamicsData.timepointLabels}
                              timepointTotals={controlDynamicsData.timepointTotals}
                              onCloneClick={handleControlCloneClick}
                              cohortLabel={controlCohort?.cohortName || 'Control'}
                            />
                          </div>
                        {:else if dynamicsViewMode === 'bubbles'}
                          <div style="max-height: calc(100vh - 420px); overflow-y: auto; border: 1px solid var(--border-light); border-radius: 8px; padding: 8px;">
                            <ClonalDynamicsBubbles
                              bind:this={controlBubblesRef}
                              entries={controlDynamicsData.entries.filter(e => activeStatuses[e.status])}
                              timepointLabels={controlDynamicsData.timepointLabels}
                              timepointTotals={controlDynamicsData.timepointTotals}
                              onCloneClick={handleControlCloneClick}
                              colorMode={bubbleColorMode}
                              rankingMode={bubbleRankingMode}
                              publicCloneIds={controlPublicCloneIds}
                              cohortLabel={controlCohort?.cohortName || 'Control'}
                            />
                          </div>
                        {:else}
                          <div style="max-height: calc(100vh - 420px); overflow-y: auto; overflow-x: auto; border: 1px solid var(--border-light); border-radius: 8px; padding: 8px;">
                            <ClonalDynamicsIsotypeTiles
                              bind:this={controlIsotypeRef}
                              tileEntries={controlIsotypeTiles}
                              timepointLabels={controlDynamicsData.timepointLabels}
                              onCloneClick={handleControlCloneClick}
                              dynamicsEntries={controlDynamicsData.entries.filter(e => activeStatuses[e.status])}
                              cohortLabel={controlCohort?.cohortName || 'Control'}
                            />
                          </div>
                        {/if}
                      </div>
                    </div>

                    <!-- Right: detail bar + tree (heatmap mode only) -->
                    {#if dynamicsViewMode === 'heatmap'}
                    <div class="dynamics-cohort-right">
                      {#if selectedDynamicsEntry}
                        <div class="dynamics-detail-strip">
                          <div class="dynamics-detail-strip-top">
                            <h3>{selectedDynamicsEntry.cloneLabel}</h3>
                            <span class="status-pill {selectedDynamicsEntry.status}">{selectedDynamicsEntry.status.replace('_', ' ')}</span>
                            {#if selectedDynamicsCohortType}
                              <span class="cohort-tag-inline cohort-tag-{selectedDynamicsCohortType}">{selectedDynamicsCohortType === 'disease' ? (diseaseCohort?.cohortName || 'Disease') : (controlCohort?.cohortName || 'Control')}</span>
                            {/if}
                          </div>
                          <div class="dynamics-detail-strip-body">
                            <span><strong>CDR3:</strong> <code>{selectedDynamicsEntry.cdr3Aa || '(none)'}</code></span>
                            <span><strong>V:</strong> {selectedDynamicsEntry.vGene}</span>
                            <span><strong>J:</strong> {selectedDynamicsEntry.jGene}</span>
                            <span><strong>Total:</strong> {selectedDynamicsEntry.totalRawCount} seqs</span>
                            {#each selectedDynamicsEntry.timepointSizes as tpSize}
                              <span class="strip-tp"><strong>{tpSize.label}:</strong> {(tpSize.frequency * 100).toFixed(1)}% ({tpSize.rawCount})</span>
                            {/each}
                          </div>
                        </div>
                      {/if}

                        <div class="dynamics-cohort-tree">
                          {#if selectedDynamicsEntry}
                            {#if selectedDynamicsTree}
                              <div class="dynamics-tree-section">
                                <div class="dynamics-tree-header">
                                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                                    <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                                  </svg>
                                  <span class="dynamics-tree-title">Phylogenetic Tree</span>
                                  <span class="dynamics-tree-label">{getTreeLabel(selectedDynamicsTree.meta)}</span>
                                </div>
                                <div class="dynamics-tree-container">
                                  <InteractiveTree
                                    newickPath={getTreeNewickPath(selectedDynamicsTree.meta.path)}
                                    treeName={getTreeLabel(selectedDynamicsTree.meta)}
                                    cloneSize={selectedDynamicsTree.meta.clone_size || 0}
                                  />
                                </div>
                              </div>
                            {:else}
                              <div class="dynamics-tree-empty-full">
                                <svg width="32" height="32" viewBox="0 0 16 16" fill="none">
                                  <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                                </svg>
                                <span>No phylogenetic tree available{selectedDynamicsTimepoint ? ` for ${selectedDynamicsTimepoint}` : ''}</span>
                                <span class="dynamics-tree-hint">Trees are built for the top 20 clones per timepoint. Click a timepoint cell to look up trees.</span>
                              </div>
                            {/if}
                          {:else}
                            <div class="dynamics-tree-empty-full">
                              <svg width="32" height="32" viewBox="0 0 16 16" fill="none">
                                <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                              </svg>
                              <span>Select a clone to view its phylogenetic tree</span>
                            </div>
                          {/if}
                        </div>
                    </div>
                    {/if}
                  </div>
                {:else}
                  <!-- Original 3-column layout: Heatmap/Bubbles/Isotype | Tree | Detail -->
                  <div class="dynamics-split">
                    <div class="dynamics-heatmap-section">
                      <div class="dynamics-fig-export-row">
                        <button class="fig-export-btn" on:click={() => exportCurrentFigure('single')} title="Export figure as PNG">
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                          Export PNG
                        </button>
                      </div>
                      {#if dynamicsViewMode === 'heatmap'}
                        <ClonalDynamicsHeatmap
                          bind:this={singleHeatmapRef}
                          entries={filteredDynamicsEntries}
                          timepointLabels={dynamicsData.timepointLabels}
                          timepointTotals={dynamicsData.timepointTotals}
                          onCloneClick={handleDynamicsCloneClick}
                        />
                      {:else if dynamicsViewMode === 'bubbles'}
                        <div style="padding: 8px;">
                          <ClonalDynamicsBubbles
                            bind:this={singleBubblesRef}
                            entries={filteredDynamicsEntries}
                            timepointLabels={dynamicsData.timepointLabels}
                            timepointTotals={dynamicsData.timepointTotals}
                            onCloneClick={handleDynamicsCloneClick}
                            colorMode={bubbleColorMode}
                            rankingMode={bubbleRankingMode}
                            publicCloneIds={singlePublicCloneIds}
                          />
                        </div>
                      {:else}
                        <div style="padding: 8px;">
                          <ClonalDynamicsIsotypeTiles
                            bind:this={singleIsotypeRef}
                            tileEntries={singleIsotypeTiles}
                            timepointLabels={dynamicsData.timepointLabels}
                            onCloneClick={handleDynamicsCloneClick}
                            dynamicsEntries={filteredDynamicsEntries}
                          />
                        </div>
                      {/if}
                    </div>

                    {#if dynamicsViewMode === 'heatmap'}
                      <div class="dynamics-tree-panel">
                        {#if selectedDynamicsEntry}
                          {#if selectedDynamicsTree}
                            <div class="dynamics-tree-section">
                              <div class="dynamics-tree-header">
                                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                                  <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                                </svg>
                                <span class="dynamics-tree-title">Phylogenetic Tree</span>
                                <span class="dynamics-tree-label">{getTreeLabel(selectedDynamicsTree.meta)}</span>
                              </div>
                              <div class="dynamics-tree-container">
                                <InteractiveTree
                                  newickPath={getTreeNewickPath(selectedDynamicsTree.meta.path)}
                                  treeName={getTreeLabel(selectedDynamicsTree.meta)}
                                  cloneSize={selectedDynamicsTree.meta.clone_size || 0}
                                />
                              </div>
                            </div>
                          {:else}
                            <div class="dynamics-tree-empty-full">
                              <svg width="32" height="32" viewBox="0 0 16 16" fill="none">
                                <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                              </svg>
                              <span>No phylogenetic tree available{selectedDynamicsTimepoint ? ` for ${selectedDynamicsTimepoint}` : ''}</span>
                              <span class="dynamics-tree-hint">Trees are built for the top 20 clones per timepoint. Click a timepoint cell to look up trees.</span>
                            </div>
                          {/if}
                        {:else}
                          <div class="dynamics-tree-empty-full">
                            <svg width="32" height="32" viewBox="0 0 16 16" fill="none">
                              <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                            </svg>
                            <span>Select a clone to view its phylogenetic tree</span>
                          </div>
                        {/if}
                      </div>
                    {/if}

                    {#if dynamicsViewMode === 'heatmap'}
                      <div class="dynamics-detail-panel">
                        {#if selectedDynamicsEntry}
                          <div class="dynamics-detail-card">
                            <div class="dynamics-detail-header">
                              <h3>{selectedDynamicsEntry.cloneLabel}</h3>
                              <span class="status-pill {selectedDynamicsEntry.status}">{selectedDynamicsEntry.status.replace('_', ' ')}</span>
                            </div>
                            <div class="dynamics-detail-body">
                              <div class="detail-row"><span class="detail-label">CDR3 AA:</span><code>{selectedDynamicsEntry.cdr3Aa || '(none)'}</code></div>
                              <div class="detail-row"><span class="detail-label">V Gene:</span><span>{selectedDynamicsEntry.vGene}</span></div>
                              <div class="detail-row"><span class="detail-label">J Gene:</span><span>{selectedDynamicsEntry.jGene}</span></div>
                              <div class="detail-row"><span class="detail-label">Total seqs:</span><span>{selectedDynamicsEntry.totalRawCount} sequences</span></div>
                              <h4 class="tp-sizes-heading">Timepoint Frequencies</h4>
                              <div class="tp-sizes">
                                {#each selectedDynamicsEntry.timepointSizes as tpSize}
                                  <div class="tp-size-item">
                                    <span class="tp-size-label">{tpSize.label}</span>
                                    <div class="tp-size-bar-bg">
                                      <div class="tp-size-bar" style="width: {Math.max(2, tpSize.frequency / Math.max(0.001, ...selectedDynamicsEntry.timepointSizes.map(t => t.frequency)) * 100)}%"></div>
                                    </div>
                                    <span class="tp-size-val">{(tpSize.frequency * 100).toFixed(2)}%</span>
                                    <span class="tp-size-raw">({tpSize.rawCount})</span>
                                  </div>
                                {/each}
                              </div>
                              {#if selectedDynamicsEntry.cloneIdsByTimepoint}
                                <h4 class="tp-sizes-heading">Clone IDs by Timepoint</h4>
                                <div class="clone-ids-by-tp">
                                  {#each Object.entries(selectedDynamicsEntry.cloneIdsByTimepoint) as [tp, cids]}
                                    <div class="clone-tp-row">
                                      <span class="clone-tp-label">{tp}:</span>
                                      <span class="clone-tp-ids">{cids.join(', ')}</span>
                                    </div>
                                  {/each}
                                </div>
                              {/if}
                            </div>
                          </div>
                        {:else}
                          <div class="dynamics-empty-detail">
                            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                              <rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" stroke-width="1.5"/>
                              <path d="M4 14h32M14 14v18" stroke="currentColor" stroke-width="1.5"/>
                            </svg>
                            <p>Select a lineage from the heatmap to view details</p>
                          </div>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/if}
              {:else}
                <div class="empty-inline">
                  Clonal dynamics require at least 2 timepoints with clonal data.
                </div>
              {/if}
            </div>
          {/if}
        </section>

        <!-- SHM Accumulation (moved from Dashboard Longitudinal section) -->
        {#if shmLongitudinalData.length > 0}
          <section class="collapsible-section">
            <button class="section-header" on:click={() => toggleSection('shm')}>
              <span class="section-chevron" class:open={shmAccumulationOpen}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <h3 class="section-title">SHM Accumulation</h3>
              <span class="section-badge">{shmLongitudinalData.length} group{shmLongitudinalData.length !== 1 ? 's' : ''}</span>
            </button>

            {#if shmAccumulationOpen}
              <div class="section-body">
                <p class="section-desc">
                  SHM change per clone: for each clone tracked across ≥2 timepoints via lineage mapping, the change in mean SHM from first to last appearance is computed (ΔSHM = last − first).
                  Positive values indicate ongoing affinity maturation; negative values suggest selection against mutated variants.
                  {#if hasCohorts}Both cohorts are shown side-by-side with a Wilcoxon rank-sum test.{/if}
                </p>
                <div class="shm-chart-wrapper">
                  <ShmAccumulationChart data={shmLongitudinalData} />
                </div>
              </div>
            {/if}
          </section>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .shm-chart-wrapper {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-4);
  }
  .public-clones-container {
    height: 100%;
    background: var(--gray-50);
    overflow: hidden;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .sections-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-2) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* ── Empty / Loading states ── */
  .empty-state, .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: var(--space-8);
    text-align: center;
    gap: var(--space-4);
    color: var(--text-tertiary);
  }

  .empty-icon { color: var(--gray-300); margin-bottom: var(--space-2); }
  .empty-title { font-size: var(--text-xl); font-weight: var(--font-semibold); color: var(--text-primary); margin: 0; }
  .empty-description { font-size: var(--text-sm); color: var(--text-tertiary); max-width: 400px; margin: 0; }

  .spinner {
    width: 24px; height: 24px;
    border: 3px solid var(--gray-200);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty-inline {
    text-align: center;
    padding: var(--space-8);
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  /* ── Collapsible sections ── */
  .collapsible-section {
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    background: var(--surface-raised);
    overflow: hidden;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    font-family: var(--font-sans);
    transition: background var(--transition-fast);
  }
  .section-header:hover { background: var(--gray-50); }

  .section-export-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    margin-left: auto;
    font-size: 11px;
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
    font-family: var(--font-sans);
  }
  .section-export-btn:hover { background: var(--gray-100); color: var(--text-primary); }
  .section-export-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .section-export-btn svg { flex-shrink: 0; }

  .section-chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    transition: transform var(--transition-fast);
    transform: rotate(0deg);
  }
  .section-chevron.open { transform: rotate(90deg); }

  .section-title {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    margin: 0;
    color: var(--text-primary);
  }

  .section-subtitle {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }

  .section-badge {
    margin-left: auto;
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--border-radius-full);
    background: var(--color-primary-light);
    color: var(--color-primary);
  }

  .section-body {
    padding: 0 var(--space-4) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* ── Info banner ── */
  .info-banner {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-info-light);
    border-radius: var(--border-radius-md);
    font-size: var(--text-xs);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: var(--leading-relaxed);
  }
  .info-banner-subtle {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    padding: 0 var(--space-1);
    margin-bottom: var(--space-1);
  }

  /* ── Cross-cohort table ── */
  /* Pill styles duplicated here because Svelte component CSS is scoped, the
   * .filter-pill class in RepertoireDashboard.svelte doesn't bleed in. Without
   * this block the cohort-span filter buttons render as unstyled defaults and
   * the active state is invisible. */
  .cc-filter-row :global(.filter-pill),
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
  .filter-pill:hover { color: var(--text-primary); border-color: var(--color-primary); }
  .filter-pill.active {
    border-color: var(--color-primary-muted);
    background: var(--color-primary-light);
    color: var(--color-primary);
  }
  .filter-pill-sm {
    padding: 3px 10px;
    font-size: 11px;
  }
  .filter-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .cc-filter-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-3) 0 var(--space-2);
    flex-wrap: wrap;
  }

  /* 2-state cohort filter pills (inactive → cohort must be absent;
     active → cohort must be present). */
  .cc-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 12px;
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-full);
    background: var(--surface-raised);
    font-size: 11px;
    font-weight: var(--font-medium);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-decoration: line-through;
    opacity: 0.55;
  }
  .cc-pill:hover { color: var(--text-primary); opacity: 0.85; }
  .cc-pill.cc-pill-active {
    background: var(--cc-color, var(--color-primary));
    border-color: var(--cc-color, var(--color-primary));
    color: #fff;
    text-decoration: none;
    opacity: 1;
  }
  .cc-pill.cc-pill-active:hover { opacity: 0.9; }
  .cc-count {
    margin-left: auto;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }
  .cc-table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
  }
  .cc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-xs);
    font-feature-settings: 'tnum' 1;
  }
  .cc-table th, .cc-table td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-light);
    text-align: left;
    white-space: nowrap;
  }
  .cc-table thead th {
    background: var(--gray-50);
    font-weight: var(--font-semibold);
    color: var(--text-secondary);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .cc-table .cc-subhead th {
    top: 24px;
    font-weight: var(--font-medium);
    font-size: 10px;
    color: var(--text-tertiary);
    padding: 3px 10px;
  }
  .cc-subhead-cell { border-bottom-color: var(--border-light) !important; }
  .cc-cell-pct { color: var(--text-secondary); font-style: italic; }
  .cc-table td.num, .cc-table th.num { text-align: right; }
  .cc-table tbody tr:hover { background: var(--gray-50); }
  .cc-cell-empty { color: var(--text-tertiary); }
  .cdr3-cell {
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
  .cc-cohort-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--border-radius-full);
    background: var(--gray-200);
    color: var(--text-secondary);
    font-weight: var(--font-medium);
  }
  .cc-cohort-badge.full {
    background: var(--color-warning-light);
    color: var(--color-warning);
  }
  .cc-truncated {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    padding: var(--space-2);
    text-align: center;
    margin: 0;
  }
  .info-icon {
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--color-info);
  }

  /* ── Timepoint pill selector ── */
  .tp-selector {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .tp-pill {
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-full);
    background: var(--surface-raised);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    font-family: var(--font-sans);
  }
  .tp-pill:hover { border-color: var(--color-primary-muted); color: var(--color-primary); }
  .tp-pill.active {
    background: var(--color-primary);
    color: white;
    border-color: var(--color-primary);
  }

  /* ── Stats Dashboard ── */
  .stats-dashboard {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-3);
  }
  .stat-card {
    background: var(--gray-50);
    padding: var(--space-3);
    border-radius: var(--border-radius-md);
    text-align: center;
  }
  .stat-value {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--color-primary);
  }
  .stat-label {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin-top: var(--space-1);
  }

  /* ── Shared Content Split View ── */
  .shared-content {
    display: flex;
    gap: var(--space-4);
    min-height: 350px;
    max-height: 500px;
  }

  .clones-list {
    width: 340px;
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
  }
  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-light);
  }
  .list-header h3 { font-size: var(--text-sm); font-weight: var(--font-semibold); margin: 0; }

  .topn-label {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .topn-label select {
    padding: 2px 4px;
    font-size: var(--text-xs);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-sm);
  }

  .clone-cards { flex: 1; overflow-y: auto; padding: var(--space-2); }

  .clone-card {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--surface-raised);
    border: 2px solid var(--border-light);
    border-radius: var(--border-radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    width: 100%;
    text-align: left;
    margin-bottom: var(--space-2);
    font-family: var(--font-sans);
  }
  .clone-card:hover { border-color: var(--color-primary-light); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
  .clone-card.selected { border-color: var(--color-primary); background: var(--color-primary-light); }

  .clone-rank { font-size: var(--text-lg); font-weight: var(--font-bold); color: var(--color-primary); min-width: 30px; }
  .clone-info { flex: 1; min-width: 0; }

  .clone-id-label {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin-bottom: 2px;
  }

  .cdr3-subtitle {
    display: block;
    background: var(--gray-100);
    padding: 2px 6px;
    border-radius: var(--border-radius-sm);
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-secondary);
    word-break: break-all;
    margin-bottom: var(--space-1);
  }

  .clone-genes { display: flex; gap: var(--space-2); margin-bottom: var(--space-1); }
  .gene-badge { padding: 2px 6px; border-radius: var(--border-radius-sm); font-size: 10px; font-weight: var(--font-medium); }
  .v-gene { background: #E3F2FD; color: #1976D2; }
  .j-gene { background: #F3E5F5; color: #7B1FA2; }

  .clone-metrics { display: flex; gap: var(--space-3); font-size: var(--text-xs); color: var(--text-secondary); }
  .metric { display: flex; align-items: center; gap: 4px; }

  /* ── Details panel ── */
  .details-panel {
    flex: 1;
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .detail-tabs { display: flex; border-bottom: 1px solid var(--border-light); flex-shrink: 0; }
  .tab {
    padding: var(--space-3) var(--space-4);
    background: none; border: none;
    font-size: var(--text-sm); font-weight: var(--font-medium);
    color: var(--text-secondary); cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all var(--transition-fast);
    font-family: var(--font-sans);
  }
  .tab:hover { color: var(--text-primary); }
  .tab.active { color: var(--color-primary); border-bottom-color: var(--color-primary); }

  .detail-content { flex: 1; overflow: auto; min-height: 0; padding: var(--space-4); }
  .detail-content.heatmap-active { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
  .heatmap-wrapper { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; }

  .detail-title {
    font-size: var(--text-lg); font-weight: var(--font-bold);
    margin-bottom: var(--space-4);
    color: var(--text-primary);
  }
  .detail-card {
    background: var(--gray-50);
    padding: var(--space-4);
    border-radius: var(--border-radius-md);
    margin-bottom: var(--space-4);
  }
  .detail-card h3 { font-size: var(--text-sm); font-weight: var(--font-semibold); margin-bottom: var(--space-3); color: var(--text-secondary); }
  .detail-row { display: flex; gap: var(--space-3); margin-bottom: var(--space-2); align-items: baseline; }
  .detail-label { min-width: 100px; color: var(--text-secondary); font-size: var(--text-sm); flex-shrink: 0; }
  .detail-row code { background: white; padding: 2px 6px; border-radius: var(--border-radius-sm); font-size: var(--text-sm); }
  .detail-row code.dna { word-break: break-all; font-size: var(--text-xs); }

  .patient-list { display: flex; flex-direction: column; gap: var(--space-2); }
  .patient-item {
    padding: var(--space-3);
    background: white;
    border-radius: var(--border-radius-sm);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .patient-name { font-weight: var(--font-medium); font-size: var(--text-sm); }
  .patient-count { color: var(--text-secondary); font-size: var(--text-sm); }

  .empty-selection { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-tertiary); font-size: var(--text-sm); }

  /* ═══════════════════════════════════════
     Section 2: Clonal Dynamics styles
     ═══════════════════════════════════════ */

  /* ── Status filter pills (like timepoint selector) ── */
  .status-filter-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: 0;
  }
  .status-filter-row {
    flex-wrap: wrap;
  }
  .status-filter-row .topn-label {
    margin-left: auto;
  }
  /* ── View mode toggle (Heatmap | Bubbles) ── */
  .dynamics-view-toggle {
    display: inline-flex;
    border: 1px solid var(--gray-300);
    border-radius: 6px;
    overflow: hidden;
    margin-left: var(--space-3);
    flex-shrink: 0;
  }
  .view-toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 10px;
    border: none;
    background: var(--gray-50);
    color: var(--gray-600);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .view-toggle-btn:not(:last-child) {
    border-right: 1px solid var(--gray-300);
  }
  .view-toggle-btn.active {
    background: var(--color-primary);
    color: white;
  }
  .view-toggle-btn:hover:not(.active) {
    background: var(--gray-200);
  }

  /* ── Bubble-specific controls ── */
  .bubble-controls {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }
  .bubble-control-label {
    font-size: 11px;
    color: var(--gray-600);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .bubble-control-label select {
    font-size: 11px;
    padding: 2px 4px;
    border: 1px solid var(--gray-300);
    border-radius: 4px;
    background: white;
  }
  .status-filter-label {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .status-pills {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .status-pill-filter {
    padding: var(--space-1) var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--border-radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    cursor: pointer;
    transition: all var(--transition-fast);
    font-family: var(--font-sans);
  }
  .status-pill-filter.inactive {
    opacity: 0.45;
    background: var(--gray-100);
    color: var(--text-tertiary);
    border-color: var(--border-light);
  }
  .status-pill-filter.inactive:hover {
    opacity: 0.7;
  }
  .status-pill-filter.active.persistent { background: #E3F2FD; color: #1565C0; border-color: #1565C0; }
  .status-pill-filter.active.expanding { background: #E8F5E9; color: #2E7D32; border-color: #2E7D32; }
  .status-pill-filter.active.contracting { background: #FFEBEE; color: #C62828; border-color: #C62828; }
  .status-pill-filter.active.disappeared { background: #F5F5F5; color: #616161; border-color: #616161; }
  .status-pill-filter.active.late_emerging { background: #FFF3E0; color: #E65100; border-color: #E65100; }
  .status-pill-filter.active.transient { background: #F3E5F5; color: #7B1FA2; border-color: #7B1FA2; }

  .dynamics-stats {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .dstat {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-3) var(--space-5);
    border-radius: var(--border-radius-md);
    min-width: 100px;
  }
  .dstat-val { font-size: var(--text-2xl); font-weight: var(--font-bold); }
  .dstat-pct { font-size: var(--text-xs); font-weight: var(--font-medium); opacity: 0.7; }
  .dstat-label { font-size: var(--text-xs); font-weight: var(--font-medium); margin-top: 2px; }

  .dstat.persistent { background: #E3F2FD; }
  .dstat.persistent .dstat-val { color: #1565C0; }
  .dstat.persistent .dstat-label { color: #1565C0; }

  .dstat.expanding { background: #E8F5E9; }
  .dstat.expanding .dstat-val { color: #2E7D32; }
  .dstat.expanding .dstat-label { color: #2E7D32; }

  .dstat.contracting { background: #FFEBEE; }
  .dstat.contracting .dstat-val { color: #C62828; }
  .dstat.contracting .dstat-label { color: #C62828; }

  .dstat.disappeared { background: #F5F5F5; }
  .dstat.disappeared .dstat-val { color: #616161; }
  .dstat.disappeared .dstat-label { color: #616161; }

  .dstat.late-emerging { background: #FFF3E0; }
  .dstat.late-emerging .dstat-val { color: #E65100; }
  .dstat.late-emerging .dstat-label { color: #E65100; }

  /* ── Dynamics 3-column layout (heatmap | tree | detail) ── */
  .dynamics-split {
    display: flex;
    gap: var(--space-4);
    height: 500px;
    overflow: hidden;
  }

  .dynamics-heatmap-section {
    flex: 0 0 auto;
    min-width: 0;
    height: 100%;
    overflow: auto;
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
  }

  .dynamics-tree-panel {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .dynamics-detail-panel {
    width: 300px;
    flex-shrink: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .dynamics-empty-detail {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
    border: 1px dashed var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-6);
  }

  .dynamics-empty-detail p { margin: 0; }

  /* ── Dynamics detail card ── */
  .dynamics-detail-card {
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    overflow: hidden;
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .dynamics-detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--gray-50);
    border-bottom: 1px solid var(--border-light);
  }
  .dynamics-detail-header h3 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    margin: 0;
  }

  .status-pill {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--border-radius-full);
    text-transform: capitalize;
  }
  .status-pill.persistent { background: #E3F2FD; color: #1565C0; }
  .status-pill.expanding { background: #E8F5E9; color: #2E7D32; }
  .status-pill.contracting { background: #FFEBEE; color: #C62828; }
  .status-pill.disappeared { background: #F5F5F5; color: #616161; }
  .status-pill.late_emerging { background: #FFF3E0; color: #E65100; }
  .status-pill.transient { background: #F3E5F5; color: #7B1FA2; }

  .dynamics-detail-body {
    padding: var(--space-4);
    flex: 1;
    overflow-y: auto;
  }

  .tp-sizes {
    margin-top: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .tp-size-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .tp-size-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    min-width: 40px;
    color: var(--text-secondary);
  }
  .tp-size-bar-bg {
    flex: 1;
    height: 14px;
    background: var(--gray-100);
    border-radius: var(--border-radius-full);
    overflow: hidden;
  }
  .tp-size-bar {
    height: 100%;
    background: var(--color-primary);
    border-radius: var(--border-radius-full);
    transition: width var(--transition-normal);
  }
  .tp-size-val {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    min-width: 48px;
    text-align: right;
    color: var(--text-primary);
  }
  .tp-size-raw {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    min-width: 40px;
  }

  /* ── Dynamics tree section ── */
  .dynamics-tree-section {
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .dynamics-tree-header {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-2);
    background: var(--gray-50);
    border-bottom: 1px solid var(--border-light);
    color: var(--text-secondary);
    flex-shrink: 0;
    line-height: 1;
  }

  .dynamics-tree-title {
    font-size: 10px;
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .dynamics-tree-label {
    font-size: 10px;
    color: var(--text-tertiary);
    margin-left: auto;
  }

  .dynamics-tree-container {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: white;
  }

  .dynamics-tree-empty-full {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
    border: 1px dashed var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-6);
  }

  .dynamics-tree-hint {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    max-width: 240px;
  }

  .tp-sizes-heading {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--text-secondary);
    margin: var(--space-3) 0 var(--space-2) 0;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .clone-ids-by-tp {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .clone-tp-row {
    display: flex;
    gap: var(--space-2);
    font-size: var(--text-xs);
  }
  .clone-tp-label {
    color: var(--text-secondary);
    font-weight: var(--font-medium);
    min-width: 28px;
  }
  .clone-tp-ids {
    color: var(--text-tertiary);
    font-family: var(--font-mono, monospace);
  }

  /* ── Cohort selector pills ── */
  .cohort-selector {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .cohort-selector-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .cohort-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-full);
    background: var(--surface-raised);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .cohort-pill.active {
    border-color: transparent;
  }
  .cohort-pill-disease.active { background: #E3F2FD; color: #1565C0; }
  .cohort-pill-control.active { background: #F5F5F5; color: #616161; }
  .cohort-pill:hover { opacity: 0.85; }
  .cohort-pill-dot { width: 6px; height: 6px; border-radius: 50%; }
  .cohort-dot-disease { background: #1565C0; }
  .cohort-dot-control { background: #757575; }

  /* ── Cohort dynamics: 2-column (heatmaps | detail+tree) ── */
  .dynamics-cohort-split {
    display: flex;
    gap: var(--space-4);
    flex: 1;
    min-height: 0;
    height: calc(100vh - 280px);
    overflow: hidden;
  }

  .dynamics-cohort-heatmaps {
    display: flex;
    gap: var(--space-3);
    flex: 2;
    min-width: 0;
    height: 100%;
  }

  .dynamics-cohort-hm {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 280px;
    height: 100%;
    overflow: hidden;
  }

  .dynamics-dual-label {
    font-size: var(--text-xs);
    font-weight: var(--font-bold);
    padding: 2px var(--space-3);
    border-radius: var(--border-radius-sm) var(--border-radius-sm) 0 0;
    text-align: center;
    flex-shrink: 0;
  }
  .cohort-label-disease { background: #E3F2FD; color: #1565C0; }
  .cohort-label-control { background: #F5F5F5; color: #616161; }

  .dynamics-cohort-right {
    flex: 1;
    min-width: 280px;
    max-width: 420px;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    overflow: hidden;
  }

  .dynamics-detail-strip {
    flex-shrink: 0;
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-2) var(--space-4);
  }
  .dynamics-detail-strip-top {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .dynamics-detail-strip-top h3 {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    margin: 0;
  }
  .dynamics-detail-strip-body {
    display: flex;
    gap: var(--space-4);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin-top: var(--space-1);
    flex-wrap: wrap;
  }
  .dynamics-detail-strip-body code {
    font-size: 10px;
    background: var(--gray-100);
    padding: 1px 4px;
    border-radius: var(--border-radius-sm);
  }
  .strip-tp {
    white-space: nowrap;
  }

  .cohort-tag-inline {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    padding: 1px var(--space-2);
    border-radius: var(--border-radius-full);
  }
  .cohort-tag-disease { background: #E3F2FD; color: #1565C0; }
  .cohort-tag-control { background: #F5F5F5; color: #616161; }

  .dynamics-cohort-tree {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Inline stats inside each heatmap column ── */
  .dynamics-inline-stats {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
    padding: var(--space-1) 0;
  }
  .dstat-inline {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 3px 2px;
    border-radius: var(--border-radius-sm);
  }
  .dstat-inline .dstat-val {
    font-size: var(--text-sm);
    font-weight: var(--font-bold);
  }
  .dstat-inline .dstat-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.8;
  }
  .dstat-pct-inline {
    font-weight: var(--font-medium);
    font-size: 0.85em;
    opacity: 0.7;
  }

  .fig-export-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: var(--font-medium);
    color: var(--text-tertiary);
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
    margin-left: auto;
  }
  .fig-export-btn:hover { background: var(--gray-100); color: var(--text-primary); }
  .fig-export-btn svg { flex-shrink: 0; }

  .dynamics-fig-export-row {
    display: flex;
    justify-content: flex-end;
    padding: 0 4px 4px;
  }
  .dstat-inline.persistent { background: #E3F2FD; color: #1565C0; }
  .dstat-inline.expanding { background: #E8F5E9; color: #2E7D32; }
  .dstat-inline.contracting { background: #FFF3E0; color: #E65100; }
  .dstat-inline.disappeared { background: #F5F5F5; color: #757575; }
  .dstat-inline.late-emerging { background: #FFF8E1; color: #F57F17; }

</style>
