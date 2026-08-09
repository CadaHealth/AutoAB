<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { resultsState, type CohortType, type CovidMatchData, type CovidCloneData } from '../../lib/stores/app';
  import { covidMatchWorkbook, downloadXlsx } from '../../lib/utils/export-csv';
  import { computePublicClonesPerTimepoint, getTimepointLabels } from '../../lib/utils/public-clones';

  type MatchMode = 'top_n' | 'public_clones';

  let selectedCloneId: number | null = null;
  let isRunning = false;
  let runError: string | null = null;
  /** Progress message during a multi-step run (e.g. "Matching public clones for Disease (step 2/4)") */
  let runProgress: string = '';
  const IS_ELECTRON = typeof window !== 'undefined' && !!window.electronAPI;

  $: hasCohorts = $resultsState.cohortResults.length > 0;
  let selectedCohort: CohortType = 'disease';

  // Mode + timepoint pill state
  let selectedMode: MatchMode = 'top_n';
  /** "" means "all timepoints" (no client-side filter) */
  let selectedTimepoint: string = '';

  // Per-cohort / global data slots for both modes
  $: diseaseCovidTop = $resultsState.cohortResults.find(c => c.cohortType === 'disease')?.covidMatchData || null;
  $: controlCovidTop = $resultsState.cohortResults.find(c => c.cohortType === 'control')?.covidMatchData || null;
  $: diseaseCovidPub = $resultsState.cohortResults.find(c => c.cohortType === 'disease')?.covidMatchDataPublic || null;
  $: controlCovidPub = $resultsState.cohortResults.find(c => c.cohortType === 'control')?.covidMatchDataPublic || null;
  $: diseaseName = $resultsState.cohortResults.find(c => c.cohortType === 'disease')?.cohortName || 'Disease';
  $: controlName = $resultsState.cohortResults.find(c => c.cohortType === 'control')?.cohortName || 'Control';

  // Per-cohort data + mapping for the currently selected mode, each filtered
  // by the currently selected timepoint. Used by the comparison banner so its
  // numbers always track the active filters instead of showing top-N totals.
  function cohortMappingFor(cohortType: CohortType): import('../../lib/stores/app').TimepointMapping {
    const cohort = $resultsState.cohortResults.find(c => c.cohortType === cohortType);
    const cm = cohort?.timepointMapping;
    if (cm && Object.keys(cm).length > 0) return cm;
    return $resultsState.timepointMapping;
  }

  function recomputeStats(data: CovidMatchData): CovidMatchData {
    const filtered = data.top_clones;
    return {
      ...data,
      stats: {
        ...data.stats,
        total_clones_analyzed: filtered.length,
        clones_with_vh_matches: filtered.filter(c => c.vh_matches.length > 0).length,
        clones_with_cdr3_matches: filtered.filter(c => c.cdr3_matches.length > 0).length,
        clones_with_high_matches: filtered.filter(c => c.has_high_vh_match || c.has_high_cdr3_match).length,
      }
    };
  }

  function filterCohortForBanner(
    top: CovidMatchData | null,
    pub: CovidMatchData | null,
    mapping: import('../../lib/stores/app').TimepointMapping,
    mode: MatchMode,
    tp: string
  ): CovidMatchData | null {
    const source = mode === 'public_clones' ? pub : top;
    if (!source) return null;
    if (!tp) return source;
    const filtered = source.top_clones.filter(c => cloneMatchesTimepoint(c, tp, mapping));
    return recomputeStats({ ...source, top_clones: filtered });
  }

  // selectedMode and selectedTimepoint are passed in as args so Svelte picks them
  // up as reactive dependencies, references inside a function body aren't tracked.
  $: diseaseBannerData = filterCohortForBanner(
    diseaseCovidTop, diseaseCovidPub, cohortMappingFor('disease'), selectedMode, selectedTimepoint
  );
  $: controlBannerData = filterCohortForBanner(
    controlCovidTop, controlCovidPub, cohortMappingFor('control'), selectedMode, selectedTimepoint
  );

  // The active CovidMatchData for the selected (cohort, mode) pair
  $: activeCovidData = (() => {
    if (hasCohorts) {
      if (selectedCohort === 'disease') return selectedMode === 'public_clones' ? diseaseCovidPub : diseaseCovidTop;
      return selectedMode === 'public_clones' ? controlCovidPub : controlCovidTop;
    }
    return selectedMode === 'public_clones' ? $resultsState.covidMatchDataPublic : $resultsState.covidMatchData;
  })();

  // Timepoint list + client-side timepoint filter on the clones themselves.
  // Use the active cohort's mapping when multi-cohort, the global one is
  // the last-cohort-wins leftover from the pipeline run and can mismatch.
  $: activeTpMapping = (() => {
    if (!hasCohorts) return $resultsState.timepointMapping;
    const cohort = $resultsState.cohortResults.find(c => c.cohortType === selectedCohort);
    const cm = cohort?.timepointMapping;
    if (cm && Object.keys(cm).length > 0) return cm;
    return $resultsState.timepointMapping;
  })();

  $: timepointLabels = getTimepointLabels(activeTpMapping);

  function cloneMatchesTimepoint(
    clone: CovidCloneData,
    tp: string,
    mapping: import('../../lib/stores/app').TimepointMapping
  ): boolean {
    if (!tp) return true; // "" == all
    for (const f of clone.files) {
      if (mapping[f]?.timepoint === tp) return true;
    }
    return false;
  }

  // Display data = active data with client-side timepoint filter applied to top_clones
  $: covidData = (() => {
    if (!activeCovidData) return null;
    if (!selectedTimepoint) return activeCovidData;
    const filtered = activeCovidData.top_clones.filter(c => cloneMatchesTimepoint(c, selectedTimepoint, activeTpMapping));
    return {
      ...activeCovidData,
      top_clones: filtered,
      stats: {
        ...activeCovidData.stats,
        total_clones_analyzed: filtered.length,
        clones_with_vh_matches: filtered.filter(c => c.vh_matches.length > 0).length,
        clones_with_cdr3_matches: filtered.filter(c => c.cdr3_matches.length > 0).length,
        clones_with_high_matches: filtered.filter(c => c.has_high_vh_match || c.has_high_cdr3_match).length,
      }
    };
  })();

  // Whether ANY covid data exists (across all cohorts × modes)
  $: hasAnyCovidData = hasCohorts
    ? $resultsState.cohortResults.some(c => !!c.covidMatchData || !!c.covidMatchDataPublic)
    : !!($resultsState.covidMatchData || $resultsState.covidMatchDataPublic);

  $: selectedClone = covidData?.top_clones.find(c => c.clone_id === selectedCloneId);

  $: if (covidData && !selectedCloneId && covidData.top_clones.length > 0) {
    selectedCloneId = covidData.top_clones[0].clone_id;
  }

  // When filters change and current selection drops out, pick first available
  $: if (covidData) {
    if (!covidData.top_clones.find(c => c.clone_id === selectedCloneId)) {
      selectedCloneId = covidData.top_clones.length > 0 ? covidData.top_clones[0].clone_id : null;
    }
  }

  function switchCohort(type: CohortType) {
    selectedCohort = type;
    selectedCloneId = null;
  }

  function switchMode(mode: MatchMode) {
    selectedMode = mode;
    selectedCloneId = null;
  }

  function switchTimepoint(tp: string) {
    selectedTimepoint = tp;
    selectedCloneId = null;
  }

  /**
   * Gather the union of public-clone IDs across all timepoints for a given cohort's fileGroups.
   * Returns numeric clone_ids suitable for passing to the backend.
   *
   * IMPORTANT: multi-cohort runs overwrite the global timepointMapping with each
   * cohort's mapping as their results arrive. By the time the user reruns matching,
   * the global mapping reflects only the LAST cohort, so we must pass the
   * cohort-specific mapping explicitly to filter the right files.
   */
  function collectPublicCloneIds(
    fileGroups: import('../../lib/stores/app').FileGroup[],
    tpMapping: import('../../lib/stores/app').TimepointMapping
  ): number[] {
    const tps = getTimepointLabels(tpMapping);
    const ids = new Set<number>();
    // If we have no timepoint mapping, treat as a single pool
    const scopes = tps.length > 0 ? tps : [''];
    for (const tp of scopes) {
      const pc = computePublicClonesPerTimepoint(fileGroups, tpMapping, tp);
      for (const c of pc.public_clones) {
        const m = /^clone_(\d+)$/.exec(c.id);
        if (m) ids.add(parseInt(m[1], 10));
      }
    }
    return Array.from(ids).sort((a, b) => a - b);
  }

  function selectClone(cloneId: number) {
    selectedCloneId = cloneId;
  }

  function formatFileList(files: string[]): string {
    if (files.length <= 3) return files.join(', ');
    return `${files.slice(0, 3).join(', ')} (+${files.length - 3} more)`;
  }

  function highMatchPercent(data: CovidMatchData | null): string {
    if (!data || data.stats.total_clones_analyzed === 0) return '0%';
    return ((data.stats.clones_with_high_matches / data.stats.total_clones_analyzed) * 100).toFixed(1) + '%';
  }

  // ── Run COVID matching post-analysis ──
  let cleanupResult: (() => void) | null = null;
  let cleanupComplete: (() => void) | null = null;
  let cleanupError: (() => void) | null = null;

  // Capture the latest COVID match result from events so the sequential
  // cohort loop can read it after each run completes. Keyed by mode.
  let latestCovidResult: { top_n: CovidMatchData | null; public_clones: CovidMatchData | null } = {
    top_n: null,
    public_clones: null
  };

  onMount(() => {
    if (window.electronAPI) {
      cleanupResult = window.electronAPI.onCovidMatchResult((data: any) => {
        if (data.artifact === 'covid_matches' && data.data) {
          const mode: MatchMode = data.data.mode === 'public_clones' ? 'public_clones' : 'top_n';
          latestCovidResult[mode] = data.data;
          resultsState.update(s => ({
            ...s,
            ...(mode === 'public_clones'
              ? { covidMatchDataPublic: data.data }
              : { covidMatchData: data.data })
          }));
        }
      });

      cleanupComplete = window.electronAPI.onCovidMatchComplete(() => {
        // Don't set isRunning=false here, the runCovidMatching function
        // manages that itself to support sequential multi-cohort runs.
      });

      cleanupError = window.electronAPI.onCovidMatchError((error: any) => {
        isRunning = false;
        runProgress = '';
        runError = typeof error === 'string' ? error : error?.message || 'Unknown error';
      });
    }
  });

  onDestroy(() => {
    cleanupResult?.();
    cleanupComplete?.();
    cleanupError?.();
  });

  /**
   * Run one covid matching call and return the result captured by the listener.
   * The listener fires before the await resolves (result event → complete event),
   * so by the time this awaits returns, latestCovidResult[mode] is populated.
   */
  async function runOneMatching(
    outputDir: string,
    dbPath: string,
    mode: MatchMode,
    specificCloneIds?: number[]
  ): Promise<CovidMatchData | null> {
    latestCovidResult[mode] = null;
    await window.electronAPI!.runCovidMatchingAnalysis({
      output_dir: outputDir,
      cov_abdab_database_path: dbPath,
      top_n_clones: 20,
      mode,
      ...(specificCloneIds ? { specific_clone_ids: specificCloneIds } : {})
    });
    return latestCovidResult[mode];
  }

  async function runCovidMatching() {
    if (!window.electronAPI) return;
    isRunning = true;
    runError = null;
    runProgress = '';

    try {
      // Get the COVID database path
      const dbPath = await window.electronAPI.getCovidDatabase();
      if (!dbPath) {
        runError = 'COVID antibody database (CoV-AbDab) not found. Please ensure it is placed in the application data directory.';
        isRunning = false;
        return;
      }

      const outputDir = $resultsState.outputDir;
      if (!outputDir) {
        runError = 'No output directory found. Run the main analysis first.';
        isRunning = false;
        return;
      }

      if (hasCohorts) {
        // For each cohort: run top-N matching, then public-clones matching (if any).
        const cohorts = $resultsState.cohortResults;
        const totalSteps = cohorts.length * 2;
        let step = 0;
        for (const cohort of cohorts) {
          // (1) Top-N
          step++;
          runProgress = `Matching top 20 clones for ${cohort.cohortName} (${step}/${totalSteps})…`;
          const topResult = await runOneMatching(cohort.outputDir, dbPath, 'top_n');
          if (topResult) {
            resultsState.update(s => ({
              ...s,
              cohortResults: s.cohortResults.map(c =>
                c.cohortType === cohort.cohortType ? { ...c, covidMatchData: topResult } : c
              )
            }));
          }

          // (2) Public clones: compute IDs from this cohort's fileGroups,
          // using the cohort's own timepoint mapping (the global one may
          // reflect a different cohort after the main run completed).
          step++;
          const cohortTpMapping = cohort.timepointMapping && Object.keys(cohort.timepointMapping).length > 0
            ? cohort.timepointMapping
            : $resultsState.timepointMapping;
          const publicIds = collectPublicCloneIds(cohort.fileGroups, cohortTpMapping);
          if (publicIds.length === 0) {
            runProgress = `No public clones discovered for ${cohort.cohortName}, skipping (${step}/${totalSteps})`;
            continue;
          }
          runProgress = `Matching ${publicIds.length} public clones for ${cohort.cohortName} (${step}/${totalSteps})…`;
          const pubResult = await runOneMatching(cohort.outputDir, dbPath, 'public_clones', publicIds);
          if (pubResult) {
            resultsState.update(s => ({
              ...s,
              cohortResults: s.cohortResults.map(c =>
                c.cohortType === cohort.cohortType ? { ...c, covidMatchDataPublic: pubResult } : c
              )
            }));
          }
        }

        // Promote disease cohort to the global slots for the default view
        const disease = $resultsState.cohortResults.find(c => c.cohortType === 'disease');
        if (disease) {
          resultsState.update(s => ({
            ...s,
            covidMatchData: disease.covidMatchData ?? s.covidMatchData,
            covidMatchDataPublic: disease.covidMatchDataPublic ?? s.covidMatchDataPublic
          }));
        }
      } else {
        // Single-cohort: top-N then public clones from global fileGroups
        runProgress = 'Matching top 20 clones…';
        await runOneMatching(outputDir, dbPath, 'top_n');

        const publicIds = collectPublicCloneIds($resultsState.fileGroups, $resultsState.timepointMapping);
        if (publicIds.length > 0) {
          runProgress = `Matching ${publicIds.length} public clones…`;
          await runOneMatching(outputDir, dbPath, 'public_clones', publicIds);
        } else {
          runProgress = 'No public clones discovered, skipping public-clones matching.';
        }
      }
    } catch (err: any) {
      runError = err.message || 'Failed to run COVID matching';
    } finally {
      isRunning = false;
      runProgress = '';
    }
  }

  // ── Export ──
  let isExporting = false;

  async function exportCovidMatches() {
    isExporting = true;
    try {
      // Primary dataset: prefer top-20 (disease in multi-cohort), fall back to public
      // if top-20 hasn't been run. Either way we export the full union below.
      const primary = hasCohorts
        ? (diseaseCovidTop ?? diseaseCovidPub)
        : ($resultsState.covidMatchData ?? $resultsState.covidMatchDataPublic);
      if (!primary) { alert('No COVID matching data to export'); return; }

      const wb = covidMatchWorkbook({
        covidData: primary,
        cohortName: hasCohorts ? diseaseName : undefined,
        controlCovidData: hasCohorts ? controlCovidTop : undefined,
        controlCohortName: hasCohorts ? controlName : undefined,
        // Public-clones datasets (may be null if never run)
        covidDataPublic: hasCohorts ? diseaseCovidPub : $resultsState.covidMatchDataPublic,
        controlCovidDataPublic: hasCohorts ? controlCovidPub : null,
        // Per-cohort timepoint mappings so per-timepoint breakdown is accurate
        timepointMapping: hasCohorts ? cohortMappingFor('disease') : $resultsState.timepointMapping,
        controlTimepointMapping: hasCohorts ? cohortMappingFor('control') : undefined,
      });
      await downloadXlsx(wb, 'covid_db_matches.xlsx');
    } catch (err: any) {
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      isExporting = false;
    }
  }
</script>

<div class="covid-matching-container">
  {#if !hasAnyCovidData}
    <!-- No data at all, show empty state with Run Now -->
    <div class="empty-state">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M3 3v18M21 3v18M9 6l6 3-6 3 6 3-6 3" stroke-width="2"/>
      </svg>
      <h3>No COVID Database Matching Data</h3>
      {#if isRunning}
        <div class="run-status">
          <div class="spinner"></div>
          <p>{runProgress || 'Running COVID database matching...'}</p>
        </div>
      {:else}
        <p>COVID database matching was not run during the initial analysis.</p>
        {#if runError}
          <p class="run-error">{runError}</p>
        {/if}
        {#if IS_ELECTRON}
          <button class="run-now-btn" on:click={runCovidMatching} disabled={isRunning}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <polygon points="4,2 14,8 4,14" fill="currentColor"/>
            </svg>
            Run Now
          </button>
        {/if}
      {/if}
    </div>
  {:else}
    <!-- Cohort selector (when cohorts present) -->
    {#if hasCohorts}
      <div class="covid-cohort-bar">
        <div class="covid-cohort-pills">
          <span class="covid-cohort-label">Cohort:</span>
          {#each $resultsState.cohortResults as cohort (cohort.cohortType)}
            <button
              class="covid-cohort-pill covid-pill-{cohort.cohortType}"
              class:active={selectedCohort === cohort.cohortType}
              class:disabled={!cohort.covidMatchData && !cohort.covidMatchDataPublic}
              on:click={() => { if (cohort.covidMatchData || cohort.covidMatchDataPublic) switchCohort(cohort.cohortType); }}
            >
              <span class="covid-pill-dot covid-dot-{cohort.cohortType}"></span>
              {cohort.cohortName}
              {#if !cohort.covidMatchData && !cohort.covidMatchDataPublic}
                <span class="pill-no-data">(no data)</span>
              {/if}
            </button>
          {/each}
        </div>
        {#if diseaseBannerData && controlBannerData}
          <div class="covid-comparison-banner">
            <span class="banner-context">
              {selectedMode === 'public_clones' ? 'Public clones' : 'Top 20 clones'}{selectedTimepoint ? ` · ${selectedTimepoint}` : ''}:
            </span>
            <span class="comparison-item disease">
              <strong>{diseaseName}:</strong>
              {diseaseBannerData.stats.clones_with_high_matches} high matches ({highMatchPercent(diseaseBannerData)} of {diseaseBannerData.stats.total_clones_analyzed} clones)
            </span>
            <span class="comparison-divider">|</span>
            <span class="comparison-item control">
              <strong>{controlName}:</strong>
              {controlBannerData.stats.clones_with_high_matches} high matches ({highMatchPercent(controlBannerData)} of {controlBannerData.stats.total_clones_analyzed} clones)
            </span>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Mode + Timepoint pills -->
    <div class="covid-mode-bar">
      <div class="covid-mode-pills">
        <span class="covid-mode-label">Source:</span>
        <button
          class="covid-mode-pill"
          class:active={selectedMode === 'top_n'}
          class:disabled={!activeCovidData && selectedMode !== 'top_n' && !(hasCohorts ? (selectedCohort === 'disease' ? diseaseCovidTop : controlCovidTop) : $resultsState.covidMatchData)}
          on:click={() => switchMode('top_n')}
          title="Match CoV-AbDab against the top 20 largest clones"
        >
          Top 20 clones
          {#if !(hasCohorts ? (selectedCohort === 'disease' ? diseaseCovidTop : controlCovidTop) : $resultsState.covidMatchData)}
            <span class="pill-no-data">(no data)</span>
          {/if}
        </button>
        <button
          class="covid-mode-pill"
          class:active={selectedMode === 'public_clones'}
          on:click={() => switchMode('public_clones')}
          title="Match CoV-AbDab against the union of public clones discovered across all timepoints"
        >
          Public clones
          {#if !(hasCohorts ? (selectedCohort === 'disease' ? diseaseCovidPub : controlCovidPub) : $resultsState.covidMatchDataPublic)}
            <span class="pill-no-data">(no data)</span>
          {/if}
        </button>
      </div>

      {#if timepointLabels.length > 0}
        <div class="covid-mode-pills">
          <span class="covid-mode-label">Timepoint:</span>
          <button
            class="covid-mode-pill"
            class:active={selectedTimepoint === ''}
            on:click={() => switchTimepoint('')}
          >
            All
          </button>
          {#each timepointLabels as tp}
            <button
              class="covid-mode-pill"
              class:active={selectedTimepoint === tp}
              on:click={() => switchTimepoint(tp)}
            >
              {tp}
            </button>
          {/each}
        </div>
      {/if}

      {#if IS_ELECTRON}
        <button class="covid-rerun-btn" on:click={runCovidMatching} disabled={isRunning} title="Rerun COVID matching (top 20 + public clones)">
          {#if isRunning}
            <span class="spinner inline-spinner"></span>
            Running…
          {:else}
            Re-run matching
          {/if}
        </button>
      {/if}
    </div>

    {#if isRunning && runProgress}
      <div class="covid-progress">{runProgress}</div>
    {/if}

    {#if !activeCovidData}
      <div class="covid-mode-empty">
        <p>
          No {selectedMode === 'public_clones' ? 'public-clone' : 'top-20'} matching results for this cohort yet.
          {#if selectedMode === 'public_clones'}
            Click <strong>Re-run matching</strong> above to match the union of discovered public clones against CoV-AbDab.
          {:else}
            Click <strong>Re-run matching</strong> above to match the top 20 expanded clones against CoV-AbDab.
          {/if}
        </p>
      </div>
    {:else if covidData}
    <!-- Header with export -->
    <div class="covid-header-row">
      <h3 class="covid-section-title">COVID-DB Matching Results</h3>
      <button
        class="export-view-btn"
        on:click={exportCovidMatches}
        disabled={isExporting}
        title="Export COVID matching results to Excel"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        {isExporting ? 'Exporting...' : 'Export'}
      </button>
    </div>

    <!-- Stats Dashboard -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">{covidData.stats.total_clones_analyzed}</div>
        <div class="stat-label">Clones Analyzed</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{covidData.stats.clones_with_high_matches}</div>
        <div class="stat-label">High Matches (≥90%)</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{covidData.stats.clones_with_vh_matches}</div>
        <div class="stat-label">VH Matches Found</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{covidData.stats.database_size.toLocaleString()}</div>
        <div class="stat-label">CoV-AbDab Antibodies</div>
      </div>
    </div>

    <!-- Two-column layout -->
    <div class="results-content">
      <!-- Left: Clone List -->
      <div class="clones-list">
        <div class="list-header">
          <h3>
            {selectedMode === 'public_clones' ? 'Public clones' : 'Top 20 clones'}
            {#if selectedTimepoint}
              <span class="list-header-tp">· {selectedTimepoint}</span>
            {/if}
          </h3>
          <span class="list-count">{covidData.top_clones.length} clones</span>
        </div>
        <div class="list-content">
          {#each covidData.top_clones as clone}
            <button
              class="clone-card"
              class:active={selectedCloneId === clone.clone_id}
              on:click={() => selectClone(clone.clone_id)}
            >
              <div class="clone-header">
                <span class="clone-id">Clone {clone.clone_id}</span>
                <span class="clone-size">{clone.size} seqs</span>
              </div>
              <div class="clone-cdr3">
                <span class="cdr3-label">CDR3:</span>
                <code class="cdr3-seq">{clone.cdr3_aa_raw}</code>
              </div>
              <div class="clone-indicators">
                {#if clone.has_high_vh_match}
                  <span class="indicator match">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    VH: {clone.vh_matches[0]?.identity.toFixed(1)}%
                  </span>
                {:else if clone.vh_matches.length > 0}
                  <span class="indicator low-match">VH: {clone.vh_matches[0]?.identity.toFixed(1)}%</span>
                {:else}
                  <span class="indicator no-match">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                    VH: No match
                  </span>
                {/if}
                
                {#if clone.has_high_cdr3_match}
                  <span class="indicator match">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    CDR3: {clone.cdr3_matches[0]?.identity.toFixed(1)}%
                  </span>
                {:else if clone.cdr3_matches.length > 0}
                  <span class="indicator low-match">CDR3: {clone.cdr3_matches[0]?.identity.toFixed(1)}%</span>
                {:else}
                  <span class="indicator no-match">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                    CDR3: No match
                  </span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>

      <!-- Right: Details Panel -->
      <div class="details-panel">
        {#if selectedClone}
          <!-- Clone Summary -->
          <div class="clone-summary">
            <h3>Clone {selectedClone.clone_id} Summary</h3>
            <div class="summary-grid">
              <div class="summary-item">
                <span class="label">Junction (AIRR):</span>
                <code class="value">{selectedClone.cdr3_aa_raw}</code>
              </div>
              <div class="summary-item">
                <span class="label">CDR3 (IMGT):</span>
                <code class="value">{selectedClone.cdr3_aa}</code>
              </div>
              <div class="summary-item">
                <span class="label">Size:</span>
                <span class="value">{selectedClone.size} sequences</span>
              </div>
              <div class="summary-item">
                <span class="label">V Gene:</span>
                <span class="value">{selectedClone.v_gene}</span>
              </div>
              <div class="summary-item">
                <span class="label">J Gene:</span>
                <span class="value">{selectedClone.j_gene}</span>
              </div>
              <div class="summary-item full-width">
                <span class="label">Files:</span>
                <span class="value">{formatFileList(selectedClone.files)}</span>
              </div>
            </div>
          </div>

          <!-- VH Matches -->
          <div class="matches-section">
            <h3>
              VH Sequence Matches 
              <span class="match-count">({selectedClone.vh_matches.length} found)</span>
            </h3>
            {#if selectedClone.vh_matches.length > 0}
              <div class="matches-list">
                {#each selectedClone.vh_matches as match, idx}
                  <div class="match-card" class:high-match={match.identity >= 90}>
                    <div class="match-header">
                      <div class="match-title">
                        <span class="match-rank">#{idx + 1}</span>
                        <span class="antibody-name">{match.antibody_name}</span>
                        <span class="ab-type">{match.db_info.ab_or_nb}</span>
                      </div>
                      <span class="identity" class:high={match.identity >= 90}>
                        {match.identity.toFixed(2)}%
                      </span>
                    </div>
                    
                    <div class="alignment-viz">
                      <div class="alignment-header">
                        <span>Query:</span>
                        <span class="alignment-stats">
                          {match.alignment.matches}/{match.alignment.length} matches
                        </span>
                      </div>
                      <div class="alignment-rows">
                        <code class="alignment-row query">{match.alignment.query_aligned}</code>
                        <code class="alignment-row match">{match.alignment.match_string}</code>
                        <code class="alignment-row reference">{match.alignment.reference_aligned}</code>
                      </div>
                      <div class="alignment-footer">
                        <span>Reference: {match.antibody_name}</span>
                      </div>
                    </div>

                    <div class="db-info">
                      {#if match.db_info.binds_to}
                        <div class="info-row">
                          <span class="info-label">Binds to:</span>
                          <span class="info-value">{match.db_info.binds_to}</span>
                        </div>
                      {/if}
                      {#if match.db_info.neutralizes}
                        <div class="info-row">
                          <span class="info-label">Neutralizes:</span>
                          <span class="info-value neutralizes">{match.db_info.neutralizes}</span>
                        </div>
                      {/if}
                      {#if match.db_info.v_gene || match.db_info.j_gene}
                        <div class="info-row">
                          <span class="info-label">Genes:</span>
                          <span class="info-value">{match.db_info.v_gene} / {match.db_info.j_gene}</span>
                        </div>
                      {/if}
                      {#if match.db_info.origin}
                        <div class="info-row">
                          <span class="info-label">Origin:</span>
                          <span class="info-value">{match.db_info.origin}</span>
                        </div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="no-matches">
                <p>No VH sequences of matching length found in database.</p>
                <p class="hint">CoV-AbDab only compares sequences of identical length.</p>
              </div>
            {/if}
          </div>

          <!-- CDR3 Matches -->
          <div class="matches-section">
            <h3>
              CDR3 Sequence Matches 
              <span class="match-count">({selectedClone.cdr3_matches.length} found)</span>
            </h3>
            {#if selectedClone.cdr3_matches.length > 0}
              <div class="matches-list">
                {#each selectedClone.cdr3_matches as match, idx}
                  <div class="match-card" class:high-match={match.identity >= 90}>
                    <div class="match-header">
                      <div class="match-title">
                        <span class="match-rank">#{idx + 1}</span>
                        <span class="antibody-name">{match.antibody_name}</span>
                        <span class="ab-type">{match.db_info.ab_or_nb}</span>
                      </div>
                      <span class="identity" class:high={match.identity >= 90}>
                        {match.identity.toFixed(2)}%
                      </span>
                    </div>
                    
                    <div class="alignment-viz">
                      <div class="alignment-header">
                        <span>Query (IMGT CDR3):</span>
                        <span class="alignment-stats">
                          {match.alignment.matches}/{match.alignment.length} matches
                        </span>
                      </div>
                      <div class="alignment-rows">
                        <code class="alignment-row query">{match.alignment.query_aligned}</code>
                        <code class="alignment-row match">{match.alignment.match_string}</code>
                        <code class="alignment-row reference">{match.alignment.reference_aligned}</code>
                      </div>
                      <div class="alignment-footer">
                        <span>Reference: {match.antibody_name}</span>
                      </div>
                    </div>

                    <div class="db-info">
                      {#if match.db_info.binds_to}
                        <div class="info-row">
                          <span class="info-label">Binds to:</span>
                          <span class="info-value">{match.db_info.binds_to}</span>
                        </div>
                      {/if}
                      {#if match.db_info.neutralizes}
                        <div class="info-row">
                          <span class="info-label">Neutralizes:</span>
                          <span class="info-value neutralizes">{match.db_info.neutralizes}</span>
                        </div>
                      {/if}
                      {#if match.db_info.v_gene || match.db_info.j_gene}
                        <div class="info-row">
                          <span class="info-label">Genes:</span>
                          <span class="info-value">{match.db_info.v_gene} / {match.db_info.j_gene}</span>
                        </div>
                      {/if}
                      {#if match.db_info.origin}
                        <div class="info-row">
                          <span class="info-label">Origin:</span>
                          <span class="info-value">{match.db_info.origin}</span>
                        </div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="no-matches">
                <p>No CDR3 sequences of matching length found in database.</p>
                <p class="hint">CoV-AbDab only compares sequences of identical length.</p>
              </div>
            {/if}
          </div>
        {:else}
          <div class="empty-selection">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
            </svg>
            <h3>Select a Clone</h3>
            <p>Click on a clone from the list to view COVID antibody matches</p>
          </div>
        {/if}
      </div>
    </div>
    {:else}
      <!-- Selected cohort has no data -->
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M3 3v18M21 3v18M9 6l6 3-6 3 6 3-6 3" stroke-width="2"/>
        </svg>
        <h3>No data for this cohort</h3>
        <p>COVID database matching has not been run for this cohort yet.</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .covid-matching-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--background-primary);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    gap: var(--space-3);
    padding: var(--space-8);
    text-align: center;
  }

  .empty-state svg {
    opacity: 0.3;
  }

  .empty-state h3 {
    margin: 0;
    color: var(--text-primary);
  }

  .empty-state p {
    margin: 0;
    max-width: 400px;
  }

  .run-now-btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-5);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: white;
    background: var(--color-primary);
    border: none;
    border-radius: var(--border-radius-md);
    cursor: pointer;
    transition: all var(--transition-fast);
    margin-top: var(--space-2);
  }
  .run-now-btn:hover { opacity: 0.9; }
  .run-now-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .run-now-btn svg { flex-shrink: 0; }

  .run-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
  }

  .run-error {
    color: var(--color-danger, #e53e3e);
    font-size: var(--text-sm);
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 3px solid var(--gray-200);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .covid-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-4);
    margin-bottom: var(--space-3);
  }
  .covid-section-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  .export-view-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }
  .export-view-btn:hover { background: var(--gray-100); color: var(--text-primary); }
  .export-view-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .export-view-btn svg { flex-shrink: 0; }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-4);
    padding: var(--space-4);
  }

  .stat-card {
    background: var(--surface-raised);
    padding: var(--space-4);
    border-radius: var(--border-radius-md);
    text-align: center;
    box-shadow: var(--shadow-sm);
  }

  .stat-value {
    font-size: 2rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--space-2);
  }

  .stat-label {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .results-content {
    flex: 1;
    display: flex;
    gap: var(--space-4);
    padding: 0 var(--space-4) var(--space-4);
    min-height: 0;
  }

  .clones-list {
    width: 400px;
    background: var(--surface-raised);
    border-radius: var(--border-radius-md);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-sm);
  }

  .list-header {
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-default);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .list-header h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .list-count {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .list-content {
    flex: 1;
    overflow-y: auto;
  }

  .clone-card {
    width: 100%;
    padding: var(--space-3);
    border: none;
    border-bottom: 1px solid var(--border-subtle);
    background: transparent;
    cursor: pointer;
    transition: background 0.2s, border-left 0.2s;
    text-align: left;
    font-family: inherit;
    border-left: 3px solid transparent;
  }

  .clone-card:hover {
    background: var(--surface-hover);
  }

  .clone-card.active {
    background: var(--surface-selected);
    border-left-color: var(--accent-primary);
  }

  .clone-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-2);
  }

  .clone-id {
    font-weight: 600;
    color: var(--text-primary);
  }

  .clone-size {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .clone-cdr3 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    font-size: 0.875rem;
  }

  .cdr3-label {
    color: var(--text-muted);
  }

  .cdr3-seq {
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 0.8rem;
    color: var(--text-primary);
    background: var(--surface-base);
    padding: 2px 6px;
    border-radius: var(--border-radius-sm);
  }

  .clone-indicators {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .indicator {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: 0.875rem;
  }

  .indicator.match {
    color: var(--success-text);
    font-weight: 500;
  }

  .indicator.low-match {
    color: var(--text-muted);
  }

  .indicator.no-match {
    color: var(--text-muted);
    opacity: 0.6;
  }

  .indicator svg {
    flex-shrink: 0;
  }

  .details-panel {
    flex: 1;
    background: var(--surface-raised);
    border-radius: var(--border-radius-md);
    overflow-y: auto;
    padding: var(--space-4);
    box-shadow: var(--shadow-sm);
  }

  .empty-selection {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    gap: var(--space-3);
  }

  .empty-selection svg {
    opacity: 0.3;
  }

  .empty-selection h3 {
    margin: 0;
    color: var(--text-primary);
  }

  .clone-summary {
    background: var(--surface-base);
    padding: var(--space-4);
    border-radius: var(--border-radius-md);
    margin-bottom: var(--space-4);
    border: 1px solid var(--border-default);
  }

  .clone-summary h3 {
    margin: 0 0 var(--space-3) 0;
    font-size: 1.125rem;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-3);
  }

  .summary-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .summary-item.full-width {
    grid-column: 1 / -1;
  }

  .summary-item .label {
    font-size: 0.875rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .summary-item .value {
    color: var(--text-primary);
  }

  .summary-item code.value {
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 0.9rem;
    background: var(--surface-raised);
    padding: var(--space-2);
    border-radius: var(--border-radius-sm);
    display: block;
  }

  .matches-section {
    margin-bottom: var(--space-6);
  }

  .matches-section h3 {
    margin: 0 0 var(--space-3) 0;
    font-size: 1.125rem;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .match-count {
    font-size: 0.875rem;
    font-weight: 400;
    color: var(--text-muted);
  }

  .matches-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .match-card {
    background: var(--surface-base);
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-md);
    padding: var(--space-4);
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .match-card:hover {
    border-color: var(--border-hover);
    box-shadow: var(--shadow-md);
  }

  .match-card.high-match {
    border-color: var(--success-border);
    background: var(--success-bg);
  }

  .match-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  .match-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .match-rank {
    font-size: 0.875rem;
    color: var(--text-muted);
    font-weight: 600;
    min-width: 2rem;
  }

  .antibody-name {
    font-weight: 600;
    font-size: 1rem;
    color: var(--text-primary);
  }

  .ab-type {
    font-size: 0.875rem;
    color: var(--text-muted);
    background: var(--surface-raised);
    padding: 2px 8px;
    border-radius: var(--border-radius-sm);
  }

  .identity {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .identity.high {
    color: var(--success-text);
  }

  .alignment-viz {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--border-radius-sm);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .alignment-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-2);
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .alignment-stats {
    font-weight: 500;
  }

  .alignment-rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-x: auto;
  }

  .alignment-row {
    font-family: 'SF Mono', Monaco, 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.4;
    white-space: pre;
    display: block;
    padding: var(--space-1) 0;
  }

  .alignment-row.query {
    color: var(--accent-primary);
  }

  .alignment-row.match {
    color: var(--text-muted);
    opacity: 0.7;
  }

  .alignment-row.reference {
    color: var(--text-secondary);
  }

  .alignment-footer {
    margin-top: var(--space-2);
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .db-info {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .info-row {
    display: flex;
    gap: var(--space-2);
    font-size: 0.875rem;
  }

  .info-label {
    font-weight: 600;
    color: var(--text-muted);
    min-width: 100px;
  }

  .info-value {
    color: var(--text-primary);
    flex: 1;
  }

  .info-value.neutralizes {
    color: var(--success-text);
    font-weight: 500;
  }

  .no-matches {
    background: var(--surface-base);
    border: 1px dashed var(--border-default);
    border-radius: var(--border-radius-md);
    padding: var(--space-6);
    text-align: center;
    color: var(--text-muted);
  }

  .no-matches p {
    margin: var(--space-2) 0;
  }

  .no-matches .hint {
    font-size: 0.875rem;
    font-style: italic;
  }

  /* Scrollbar styling */
  .list-content::-webkit-scrollbar,
  .details-panel::-webkit-scrollbar,
  .alignment-rows::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .list-content::-webkit-scrollbar-track,
  .details-panel::-webkit-scrollbar-track,
  .alignment-rows::-webkit-scrollbar-track {
    background: var(--surface-base);
  }

  .list-content::-webkit-scrollbar-thumb,
  .details-panel::-webkit-scrollbar-thumb,
  .alignment-rows::-webkit-scrollbar-thumb {
    background: var(--border-default);
    border-radius: 4px;
  }

  .list-content::-webkit-scrollbar-thumb:hover,
  .details-panel::-webkit-scrollbar-thumb:hover,
  .alignment-rows::-webkit-scrollbar-thumb:hover {
    background: var(--border-hover);
  }

  /* ── Cohort selector for COVID matching ── */
  .covid-cohort-bar {
    padding: var(--space-3) var(--space-4);
    background: var(--surface-raised);
    border-bottom: 1px solid var(--border-default);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .covid-cohort-pills {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .covid-cohort-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .covid-cohort-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border: 1px solid var(--border-default);
    border-radius: 100px;
    background: var(--surface-raised);
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s;
  }
  .covid-cohort-pill.active { border-color: transparent; }
  .covid-cohort-pill.disabled { opacity: 0.5; cursor: not-allowed; }
  .pill-no-data { font-size: 0.65rem; opacity: 0.6; }
  .covid-pill-disease.active { background: #E3F2FD; color: #1565C0; }
  .covid-pill-control.active { background: #F5F5F5; color: #616161; }
  .covid-pill-dot { width: 6px; height: 6px; border-radius: 50%; }
  .covid-dot-disease { background: #1565C0; }
  .covid-dot-control { background: #757575; }

  .covid-comparison-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-base);
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-sm);
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .comparison-item.disease { color: #1565C0; }
  .comparison-item.control { color: #616161; }
  .comparison-divider { color: var(--border-default); }
  .banner-context {
    color: var(--text-tertiary, #9ca3af);
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-right: 4px;
  }

  /* Mode + Timepoint pill bar */
  .covid-mode-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4, 16px);
    padding: var(--space-3, 12px) var(--space-4, 16px);
    background: var(--gray-50, #f9fafb);
    border-bottom: 1px solid var(--border-light, #e5e7eb);
  }
  .covid-mode-pills {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .covid-mode-label {
    font-size: 0.75rem;
    color: var(--text-secondary, #6b7280);
    font-weight: 600;
    margin-right: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .covid-mode-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    background: #fff;
    border: 1px solid var(--border-light, #e5e7eb);
    border-radius: 999px;
    font-size: 0.82rem;
    font-family: inherit;
    color: var(--text-secondary, #6b7280);
    cursor: pointer;
    transition: all 0.12s;
  }
  .covid-mode-pill:hover:not(.disabled):not(.active) {
    border-color: var(--gray-300, #d1d5db);
    color: var(--text-primary, #1f2937);
  }
  .covid-mode-pill.active {
    background: var(--color-primary, #3b82f6);
    color: #fff;
    border-color: var(--color-primary, #3b82f6);
    font-weight: 600;
  }
  .covid-mode-pill.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .covid-mode-pill .pill-no-data {
    font-size: 0.7rem;
    opacity: 0.7;
    font-weight: normal;
    margin-left: 2px;
  }
  .covid-rerun-btn {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    background: var(--color-primary, #3b82f6);
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 0.8rem;
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.12s;
  }
  .covid-rerun-btn:hover:not(:disabled) {
    opacity: 0.9;
  }
  .covid-rerun-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .inline-spinner {
    width: 10px;
    height: 10px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .covid-progress {
    padding: var(--space-2, 8px) var(--space-4, 16px);
    background: var(--color-primary-light, #dbeafe);
    color: var(--color-primary, #1d4ed8);
    font-size: 0.82rem;
    font-style: italic;
    border-bottom: 1px solid var(--border-light, #e5e7eb);
  }

  .covid-mode-empty {
    padding: var(--space-6, 24px);
    text-align: center;
    color: var(--text-secondary, #6b7280);
    font-size: 0.9rem;
  }

  .list-header-tp {
    font-weight: normal;
    font-size: 0.85em;
    color: var(--text-tertiary, #9ca3af);
    margin-left: 4px;
  }
</style>
