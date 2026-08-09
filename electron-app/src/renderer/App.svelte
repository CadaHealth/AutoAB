<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { currentView, analysisState, resultsState, wizardState, studyDesign, processSequenceResults, processDlSequenceResults, addLog, setProgress, saveSession, getSessions, resetWizard, saveStudyDesignImmediate, type CohortResults, type CohortType, type StudyDesign } from './lib/stores/app';
  import Wizard from './routes/wizard/Wizard.svelte';
  import Results from './routes/results/Results.svelte';
  import ThresholdDialog from './lib/components/ThresholdDialog.svelte';
  import DependencyGate from './lib/components/DependencyGate.svelte';
  import SessionSidebar from './lib/components/SessionSidebar.svelte';
  import PasswordGate from './lib/components/PasswordGate.svelte';
  import { loadDemoData } from './lib/demo-loader';

  const IS_DEMO = typeof window !== 'undefined' && !window.electronAPI;
  let demoAuthenticated = IS_DEMO ? sessionStorage.getItem('demo_authenticated') === '1' : false;
  let demoLoading = false;
  let demoError = '';

  let sessionSidebar: SessionSidebar;

  // Setup screen. Opened automatically when a required component is missing,
  // and always dismissible so a user is never trapped behind it.
  let showDependencyGate = false;
  let dependencyGateDismissible = true;
  let depsNeedAttention = false;
  
  // Track fasta_dir from latest result so we can save it to session history
  let lastFastaDir = '';
  let lastFileCount = 0;

  // Accumulate per-cohort results during multi-cohort pipeline runs
  let pendingCohortResults: Map<string, Partial<CohortResults>> = new Map();

  // Label for the threshold dialog when running multi-cohort
  let thresholdCohortLabel: string = '';
  // Distribution plot data (base64 PNGs) keyed by timepoint label
  let thresholdPlots: Record<string, string> = {};

  function getOrCreateCohortAccum(cohortType: CohortType, cohortName?: string): Partial<CohortResults> {
    if (!pendingCohortResults.has(cohortType)) {
      pendingCohortResults.set(cohortType, {
        cohortType,
        cohortName: cohortName || cohortType,
        sequences: [],
        fileGroups: [],
        treeImages: [],
        treeMetadata: [],
        timepointMapping: {},
        outputDir: '',
        fileIdMapping: {},
        covidMatchData: null
      });
    }
    const accum = pendingCohortResults.get(cohortType)!;
    if (cohortName) accum.cohortName = cohortName;
    return accum;
  }
  
  
  // Event listener cleanup functions
  let cleanupFns: (() => void)[] = [];
  
  /** Migrate old single-key persistence into the new sessions array (one-time) */
  function migrateOldPersistence() {
    const OLD_KEY = 'bcr_last_output_dir';
    const oldDir = localStorage.getItem(OLD_KEY);
    if (!oldDir) return;
    // Only migrate if there isn't already a session for this dir
    const existing = getSessions();
    if (existing.some(s => s.outputDir === oldDir)) {
      localStorage.removeItem(OLD_KEY);
      return;
    }
    const dirName = oldDir.split('/').pop() || 'Untitled';
    saveSession({
      name: dirName,
      outputDir: oldDir,
      date: new Date().toISOString(),
      fileCount: 0,   // unknown from old key
      fastaDir: ''
    });
    localStorage.removeItem(OLD_KEY);
    console.log('[App] Migrated old persistence key to session:', dirName);
  }
  
  async function tryRestoreFromStorage() {
    try {
      const sessions = getSessions();
      if (sessions.length === 0 || !window.electronAPI) return;
      
      // Try the most recent session
      const latest = sessions[0];
      const markerPath = latest.outputDir + '/combined.fasta';
      const exists = await window.electronAPI.fileExists(markerPath);
      if (!exists) {
        console.log('[App] Most recent session output missing, skipping auto-restore');
        return;
      }
      
      console.log('[App] Restoring results from', latest.outputDir);
      if (sessionSidebar) sessionSidebar.collapse();
      analysisState.update(s => ({
        ...s,
        isRunning: true,
        isSessionLoad: true,
        pendingLoadOutputDir: latest.outputDir
      }));
      currentView.set('results');
      
      await window.electronAPI.loadResults(latest.outputDir);
      analysisState.update(s => ({ ...s, isRunning: false }));
    } catch (e) {
      console.warn('[App] Restore failed:', e);
      analysisState.update(s => ({ ...s, isRunning: false }));
    }
  }
  
  /**
   * Surface the setup screen on launch when something the pipeline needs is
   * missing, rather than letting the run fail halfway through.
   */
  async function checkDependenciesOnStartup() {
    if (!window.electronAPI?.checkDependencies) return;
    try {
      const report = await window.electronAPI.checkDependencies();
      depsNeedAttention = !report.ok;
      if (!report.ok) showDependencyGate = true;
    } catch (e) {
      console.warn('[App] Dependency check failed:', e);
    }
  }

  onMount(() => {
    // Migrate old single-key persistence to session array (one-time)
    migrateOldPersistence();

    checkDependenciesOnStartup();

    // Debug: Check if electronAPI is available
    console.log('[App] App mounted, checking electronAPI...');
    console.log('[App] window.electronAPI:', window.electronAPI);
    console.log('[App] typeof window.electronAPI:', typeof window.electronAPI);
    
    // Set up pipeline event listeners
    if (window.electronAPI) {
      console.log('[App] Setting up event listeners...');
      console.log('[App] onThresholdRequest available:', typeof window.electronAPI.onThresholdRequest);
      
      cleanupFns.push(
        window.electronAPI.onPipelineProgress((data) => {
          console.log('[App] Received progress event:', data);
          const wizard = get(wizardState);
          const isMultiCohort = wizard.hasControlCohort;
          const nCohorts = Math.max(1, wizard.cohorts.length);

          let scaledPercent = data.percent;
          let displayMessage = data.message;

          if (isMultiCohort && data.cohort_type) {
            // Find this cohort's position in the run order to scale the
            // progress bar across all N cohorts (was hardcoded 50/50 for the
            // old disease+control flow).
            const idx = wizard.cohorts.findIndex(c => c.type === data.cohort_type);
            const cohortIdx = idx >= 0 ? idx : 0;
            const slice = 100 / nCohorts;
            scaledPercent = Math.round(cohortIdx * slice + (data.percent * slice) / 100);
            displayMessage = `[${data.cohort_name || data.cohort_type}] ${data.message}`;
          }

          setProgress({ ...data, percent: scaledPercent, message: displayMessage });

          // Clear old tree data and file mapping when a new analysis starts (only on first cohort)
          if (data.stage === 'fasta' || data.stage === 'setup') {
            const wizardCohorts = get(wizardState).cohorts;
            const firstCohortType = wizardCohorts[0]?.type ?? 'disease';
            const isFirstCohort = !data.cohort_type || data.cohort_type === firstCohortType;
            if (isFirstCohort) {
              console.log('[App] New analysis starting - clearing old tree data');
              pendingCohortResults = new Map();
              resultsState.update(s => ({
                ...s,
                treeImages: [],
                treeMetadata: [],
                fileIdMapping: {},
                timepointMapping: {},
                cohortResults: []
              }));
              if (sessionSidebar) sessionSidebar.clearActive();
            }
          }
        })
      );
      
      cleanupFns.push(
        window.electronAPI.onPipelineLog((data) => {
          console.log('[App] Received log event:', data);
          addLog(data.level as any, data.message);
        })
      );
      
      cleanupFns.push(
        window.electronAPI.onPipelineResult((data) => {
          console.log('[App] Received result event:', data.artifact, data.data ? '(has data)' : '(no data)', data.cohort_type || '');
          const cohortType: CohortType | undefined = data.cohort_type as CohortType | undefined;
          const cohortName: string | undefined = data.cohort_name;

          if (data.artifact === 'sequences' && data.data) {
            // During session load: only accept results for the session we're loading
            const pending = $analysisState.pendingLoadOutputDir;
            if (pending) {
              const received = (data.data.output_dir || '').replace(/\/$/, '');
              const expected = pending.replace(/\/$/, '');
              if (received && expected && received !== expected) {
                console.log('[App] Ignoring stale sequences result for', received, '- expected', expected);
                return;
              }
            }
            try {
              processSequenceResults(data.data);
              console.log('[App] processSequenceResults OK, sequences:', data.data.sequences?.length, 'file_groups:', Object.keys(data.data.file_groups || {}).length);
            } catch (e) {
              console.error('[App] processSequenceResults failed:', e);
            }
            if (data.data.output_dir) {
              console.log('[App] Storing output directory:', data.data.output_dir);
              resultsState.update(s => ({ ...s, outputDir: data.data.output_dir }));
            }
            if (data.data.fasta_dir) lastFastaDir = data.data.fasta_dir;
            if (data.data.file_groups) lastFileCount = Object.keys(data.data.file_groups).length;

            if (cohortType) {
              const accum = getOrCreateCohortAccum(cohortType, cohortName);
              accum.sequences = get(resultsState).sequences;
              accum.fileGroups = get(resultsState).fileGroups;
              if (data.data.output_dir) accum.outputDir = data.data.output_dir;
              if (data.data.file_id_mapping) accum.fileIdMapping = data.data.file_id_mapping;
            }
          }
          if (data.artifact === 'dl_sequences' && data.data) {
            processDlSequenceResults(data.data);
          }
          if (data.artifact === 'tree_images' && data.data?.images) {
            resultsState.update(s => ({
              ...s,
              treeImages: data.data.images,
              treeMetadata: data.data.tree_metadata || []
            }));
            if (cohortType) {
              const accum = getOrCreateCohortAccum(cohortType, cohortName);
              accum.treeImages = data.data.images;
              accum.treeMetadata = data.data.tree_metadata || [];
            }
          }
          if (data.artifact === 'covid_matches' && data.data) {
            const isPublic = data.data?.mode === 'public_clones';
            console.log('[App] Received COVID matching results (mode=%s):', data.data?.mode ?? 'top_n', data.data);
            resultsState.update(s => ({
              ...s,
              ...(isPublic ? { covidMatchDataPublic: data.data } : { covidMatchData: data.data }),
              isAnalyzingCovidMatching: false
            }));
            if (cohortType) {
              const accum = getOrCreateCohortAccum(cohortType, cohortName);
              if (isPublic) accum.covidMatchDataPublic = data.data;
              else accum.covidMatchData = data.data;
            }
          }
          if (data.artifact === 'timepoint_mapping' && data.data) {
            console.log('[App] Received timepoint_mapping artifact with', Object.keys(data.data).length, 'entries');
            resultsState.update(s => ({ ...s, timepointMapping: data.data }));
            if (cohortType) {
              const accum = getOrCreateCohortAccum(cohortType, cohortName);
              accum.timepointMapping = data.data;
            }
          }
          if (data.artifact === 'study_design' && data.data) {
            const design = data.data;
            if (design && (design.groups?.length > 0 || (design.unassigned && design.unassigned.length >= 0))) {
              const parsed: StudyDesign = {
                groups: design.groups || [],
                unassigned: design.unassigned || []
              };
              studyDesign.set(parsed);
              if (cohortType) {
                const accum = getOrCreateCohortAccum(cohortType, cohortName);
                accum.studyDesign = parsed;
              }
            }
          }
        })
      );
      
      console.log('[App] About to register threshold request listener...');
      const thresholdCleanup = window.electronAPI.onThresholdRequest((data) => {
        console.log('[App] THRESHOLD REQUEST received:', data);

        // Set cohort label so the dialog shows which cohort these thresholds belong to
        thresholdCohortLabel = data.cohort_name || data.cohort_type || '';

        // Extract distribution plot base64 data if present
        thresholdPlots = {};
        if (data.timepoint_thresholds && Array.isArray(data.timepoint_thresholds)) {
          for (const tp of data.timepoint_thresholds) {
            if (tp.plot_base64) {
              thresholdPlots[tp.label] = tp.plot_base64;
            }
          }
        }

        // Support both formats:
        //   Old: { calculated: number }
        //   New: { timepoint_thresholds: [{label, calculated}, ...] }
        analysisState.update(s => {
          let thresholdValue: number | { label: string; calculated: number }[];
          if (data.timepoint_thresholds && Array.isArray(data.timepoint_thresholds)) {
            thresholdValue = data.timepoint_thresholds;
            console.log('[App] Multi-timepoint thresholds:', thresholdValue);
          } else {
            thresholdValue = data.calculated;
            console.log('[App] Single threshold:', thresholdValue);
          }
          return { ...s, thresholdRequest: thresholdValue };
        });
      });
      console.log('[App] Threshold request listener registered successfully');
      console.log('[App] Cleanup function type:', typeof thresholdCleanup);
      cleanupFns.push(thresholdCleanup);
      
      cleanupFns.push(
        window.electronAPI.onPipelineComplete((data) => {
          const wasSessionLoad = $analysisState.isSessionLoad;
          const completedCohortType: CohortType | undefined = data.cohort_type as CohortType | undefined;
          console.log('[App] Received complete event:', data, 'isSessionLoad:', wasSessionLoad, 'cohort:', completedCohortType);

          if (completedCohortType && pendingCohortResults.has(completedCohortType)) {
            const accum = pendingCohortResults.get(completedCohortType)!;
            if (data.output_dir) accum.outputDir = data.output_dir;
            // Snapshot current resultsState into this cohort
            const rs = get(resultsState);
            if (!accum.sequences?.length) accum.sequences = rs.sequences;
            if (!accum.fileGroups?.length) accum.fileGroups = rs.fileGroups;
            if (!accum.treeImages?.length) accum.treeImages = rs.treeImages;
            if (!accum.treeMetadata?.length) accum.treeMetadata = rs.treeMetadata;
            if (!Object.keys(accum.timepointMapping || {}).length) accum.timepointMapping = rs.timepointMapping;
            if (!Object.keys(accum.fileIdMapping || {}).length) accum.fileIdMapping = rs.fileIdMapping;
            if (!accum.studyDesign) accum.studyDesign = get(studyDesign);

            resultsState.update(s => ({
              ...s,
              cohortResults: [
                ...s.cohortResults.filter(c => c.cohortType !== completedCohortType),
                accum as CohortResults
              ]
            }));
            console.log('[App] Finalized cohort result:', completedCohortType);

            // Multi-cohort run: if this is NOT the last cohort in the wizard's
            // configured order, hold off on marking the analysis as done, the
            // next cohort's pipeline is about to start. Was hardcoded to "wait
            // for control after disease finishes" in the old 2-cohort flow.
            const wizard = get(wizardState);
            if (wizard.hasControlCohort && wizard.cohorts.length > 1) {
              const idx = wizard.cohorts.findIndex(c => c.type === completedCohortType);
              const isLast = idx === wizard.cohorts.length - 1;
              if (!isLast && idx >= 0) {
                const next = wizard.cohorts[idx + 1];
                const slice = 100 / wizard.cohorts.length;
                console.log(`[App] Cohort ${completedCohortType} complete; waiting for ${next?.type}...`);
                setProgress({
                  stage: 'transition',
                  percent: Math.round((idx + 1) * slice),
                  message: `${wizard.cohorts[idx].name} complete. Starting ${next?.name || next?.type} group...`
                });
                return;
              }
            }
          }

          analysisState.update(s => ({
            ...s,
            isRunning: false,
            isSessionLoad: false,
            pendingLoadOutputDir: null,
            error: data.error || null
          }));
          
          if (data.success && !wasSessionLoad) {
            currentView.set('results');
            
            setTimeout(() => {
              const wizard = get(wizardState);
              const results = get(resultsState);
              
              if (wizard.timepoints.length > 0) {
                const timepointMapping = results.timepointMapping || {};
                const tpLabels = wizard.timepoints.map(tp => tp.label);
                
                const group = {
                  id: Math.random().toString(36).slice(2, 8),
                  name: wizard.studyName || 'Study',
                  color: '#4F46E5',
                  timepoints: tpLabels.map((label, idx) => {
                    const filesForTp = Object.entries(timepointMapping)
                      .filter(([, entry]) => entry.timepoint === label)
                      .map(([stagedFile]) => stagedFile);
                    return { id: Math.random().toString(36).slice(2, 8), label, order: idx, files: filesForTp };
                  })
                };
                
                const newDesign = { groups: [group], unassigned: [] as string[] };
                studyDesign.set(newDesign);
                saveStudyDesignImmediate(newDesign);
              }
            }, 100);
            
            const outputDir = $resultsState.outputDir;
            if (outputDir) {
              const dirName = outputDir.split('/').pop() || 'Untitled';
              const design = $studyDesign;
              const cohortEntries = $resultsState.cohortResults.map(c => ({
                cohortType: c.cohortType,
                cohortName: c.cohortName,
                outputDir: c.outputDir
              }));
              saveSession({
                name: dirName,
                outputDir,
                date: new Date().toISOString(),
                fileCount: lastFileCount || Object.keys($resultsState.fileIdMapping).length,
                fastaDir: lastFastaDir || '',
                studyName: $wizardState.studyName || '',
                ...(design?.groups?.length ? { studyDesign: design } : {}),
                ...(cohortEntries.length > 0 ? { cohorts: cohortEntries } : {})
              });
              if (sessionSidebar) sessionSidebar.refresh();
            }
          }
        })
      );
      
      cleanupFns.push(
        window.electronAPI.onPipelineError((data) => {
          console.log('[App] Received error event:', data);
          analysisState.update(s => ({
            ...s,
            isRunning: false,
            error: data.message
          }));
        })
      );
      
      console.log('[App] All event listeners set up successfully');
      console.log('[App] Total cleanup functions:', cleanupFns.length);
      
      // Disabled: auto-restore was racing with manual session selection and could load wrong session.
      // User can select a session from history sidebar instead.
      // tryRestoreFromStorage();
    } else if (IS_DEMO && demoAuthenticated) {
      // Demo mode: load pre-generated data
      initDemo();
    } else if (IS_DEMO) {
      console.log('[App] Demo mode: waiting for authentication');
    } else {
      console.error('[App] electronAPI not available in onMount!');
    }
  });

  async function initDemo() {
    document.body.classList.add('demo-mode');
    demoLoading = true;
    demoError = '';
    try {
      await loadDemoData();
      currentView.set('results');
    } catch (e: any) {
      demoError = e.message || 'Failed to load demo data';
      console.error('[App] Demo load failed:', e);
    } finally {
      demoLoading = false;
    }
  }

  function handleDemoAuth() {
    demoAuthenticated = true;
    initDemo();
  }
  
  onDestroy(() => {
    cleanupFns.forEach(fn => fn());
  });
  
  // Reactive statement to track threshold request changes
  $: {
    console.log('[App] Reactive statement: thresholdRequest =', $analysisState.thresholdRequest);
    if ($analysisState.thresholdRequest !== null) {
      console.log('[App] ✓ thresholdRequest is NOT null, dialog should show!', $analysisState.thresholdRequest);
    } else {
      console.log('[App] ✗ thresholdRequest is null, dialog will not show');
    }
  }
  
  function handleThresholdConfirm(value: number | Record<string, number>) {
    console.log('[App] handleThresholdConfirm called with value:', value);
    if (window.electronAPI) {
      window.electronAPI.sendThresholdResponse(value);
    }
    thresholdCohortLabel = '';
    thresholdPlots = {};
    analysisState.update(s => ({ ...s, thresholdRequest: null }));
  }
  
  let showFileIdTooltip = false;
  
  $: if ($currentView === 'wizard') {
    showFileIdTooltip = false;
  }
  
  function toggleFileIdTooltip() {
    showFileIdTooltip = !showFileIdTooltip;
  }
  
  let infoButtonWrapper: HTMLDivElement;
  
  function handleClickOutside(event: MouseEvent) {
    const target = event.target as Node;
    if (showFileIdTooltip && infoButtonWrapper && !infoButtonWrapper.contains(target)) {
      showFileIdTooltip = false;
    }
  }
  
</script>

<svelte:window on:click={handleClickOutside} />

{#if IS_DEMO && !demoAuthenticated}
  <PasswordGate on:authenticated={handleDemoAuth} />
{:else if IS_DEMO && demoLoading}
  <div class="demo-loading">
    <h1 class="demo-loading-title">Clono</h1>
    <p class="demo-loading-text">Loading demo data...</p>
    <div class="demo-spinner"></div>
  </div>
{:else if IS_DEMO && demoError}
  <div class="demo-loading">
    <h1 class="demo-loading-title">Clono</h1>
    <p class="demo-loading-error">{demoError}</p>
    <button class="demo-retry" on:click={initDemo}>Retry</button>
  </div>
{:else}
<div class="app-container">
  <!-- Header with drag region for macOS -->
  <header class="app-header">
    <div class="header-content">
      <h1 class="app-title">Clono</h1>
      
      <div class="header-actions">
        {#if $currentView === 'results' && Object.keys($resultsState.fileIdMapping).length > 0}
          <div class="info-button-wrapper" role="group" bind:this={infoButtonWrapper}>
            <button 
              class="btn btn-ghost btn-sm" 
              on:click={toggleFileIdTooltip}
              aria-label="File ID mapping"
              aria-expanded={showFileIdTooltip}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <circle cx="8" cy="8" r="6"/>
                <path d="M8 7v4M8 5v0" stroke-linecap="round"/>
              </svg>
              <span class="info-button-label">File ID mapping</span>
            </button>
            {#if showFileIdTooltip}
              <div class="info-tooltip" role="tooltip">
                <div class="info-tooltip-title">File ID → Filename</div>
                {#each Object.entries($resultsState.fileIdMapping).sort((a, b) => a[0].localeCompare(b[0])) as [id, filename]}
                  <div class="info-tooltip-row"><span class="info-tooltip-id">{id}</span> → {filename}</div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        {#if $currentView === 'results' && !IS_DEMO}
          <button
            class="btn btn-ghost btn-sm"
            on:click={() => { resetWizard(); currentView.set('wizard'); }}
          >
            ← New Analysis
          </button>
        {/if}
        {#if !IS_DEMO}
          <button
            class="btn btn-ghost btn-sm"
            class:deps-attention={depsNeedAttention}
            on:click={() => { showDependencyGate = true; }}
            title="Check the components AutoAB needs"
          >
            {depsNeedAttention ? 'Setup needed' : 'Setup'}
          </button>
        {/if}
      </div>
    </div>
  </header>
  
  <!-- Main content area with session sidebar -->
  <div class="app-body">
    {#if !IS_DEMO}
      <SessionSidebar bind:this={sessionSidebar} />
    {/if}
    <main class="app-content">
      {#if $currentView === 'wizard'}
        <Wizard />
      {:else}
        <Results />
      {/if}
    </main>
  </div>
  
  <!-- Setup / dependency screen -->
  {#if showDependencyGate}
    <DependencyGate
      dismissible={dependencyGateDismissible}
      on:ready={() => { depsNeedAttention = false; }}
      on:close={() => { showDependencyGate = false; dependencyGateDismissible = true; }}
    />
  {/if}

  <!-- Threshold dialog -->
  {#if $analysisState.thresholdRequest !== null}
    <ThresholdDialog
      calculatedValue={typeof $analysisState.thresholdRequest === 'number' ? $analysisState.thresholdRequest : 0}
      timepointThresholds={Array.isArray($analysisState.thresholdRequest) ? $analysisState.thresholdRequest : []}
      cohortLabel={thresholdCohortLabel}
      distributionPlots={thresholdPlots}
      on:confirm={(e) => handleThresholdConfirm(e.detail)}
    />
  {/if}
</div>
{/if}

<style>
  :global(html, body) {
    height: 100%;
    overflow: hidden;
    margin: 0;
    padding: 0;
  }
  
  :global(#app) {
    height: 100%;
    overflow: hidden;
  }
  
  .app-container {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--gray-50);
    overflow: hidden;
  }
  
  .app-header {
    height: 52px;
    background: var(--surface-raised);
    border-bottom: 1px solid var(--border-light);
    display: flex;
    align-items: center;
    padding: 0 var(--space-6);
    padding-left: 80px; /* Space for macOS traffic lights (ignored in web) */
    -webkit-app-region: drag;
    flex-shrink: 0;
  }

  /* In web/demo mode there are no traffic lights, so remove the extra left padding */
  :global(body.demo-mode) .app-header {
    padding-left: var(--space-6);
    -webkit-app-region: auto;
  }
  
  .app-header > * {
    -webkit-app-region: no-drag;
  }
  
  .header-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }
  
  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    -webkit-app-region: no-drag;
  }
  
  .info-button-wrapper {
    position: relative;
    display: inline-flex;
  }
  
  .info-button-wrapper .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    color: var(--gray-600);
  }
  
  .info-button-wrapper .btn:hover {
    color: var(--gray-800);
    background: var(--gray-100);
  }
  
  .info-button-label {
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  
  .info-tooltip {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--gray-200);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    font-size: var(--text-xs);
    min-width: 180px;
    max-width: 280px;
    z-index: 1000;
  }
  
  .info-tooltip-title {
    font-weight: var(--font-semibold);
    color: var(--gray-700);
    margin-bottom: var(--space-2);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--gray-200);
  }
  
  .info-tooltip-row {
    padding: var(--space-1) 0;
    color: var(--gray-600);
    word-break: break-all;
  }
  
  .info-tooltip-id {
    font-family: var(--font-mono);
    font-size: 0.9em;
    color: var(--gray-800);
    font-weight: var(--font-medium);
  }
  
  .app-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
  }

  /* Draws the eye to the Setup button when a component is missing, without
     the alarm of a modal the user has already dismissed once. */
  .deps-attention {
    color: #9a3412;
    background: #fff7ed;
    border-radius: 6px;
  }
  .deps-attention:hover {
    background: #ffedd5;
  }

  .app-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .app-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    width: 100%;
    margin: 0;
    padding: 0;
  }

  /* Demo loading/error states */
  .demo-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
    gap: 12px;
  }

  .demo-loading-title {
    font-size: 28px;
    font-weight: 700;
    color: #1e293b;
    margin: 0;
  }

  .demo-loading-text {
    font-size: 15px;
    color: #64748b;
    margin: 0;
  }

  .demo-loading-error {
    font-size: 15px;
    color: #ef4444;
    margin: 0;
  }

  .demo-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid #e2e8f0;
    border-top-color: #4F46E5;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .demo-retry {
    padding: 8px 20px;
    background: #4F46E5;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .demo-retry:hover {
    background: #4338CA;
  }
</style>

