<script lang="ts">
  import { wizardState, analysisState, resetAnalysis } from '../../lib/stores/app';
  
  let stagingError = '';
  
  function handleBack() {
    wizardState.update(s => ({
      ...s,
      step: 2
    }));
  }
  
  function totalFileCount(): number {
    if ($wizardState.hasControlCohort) {
      return $wizardState.cohorts.reduce((sum, c) => sum + c.timepoints.reduce((s, tp) => s + tp.fastaFiles.length, 0), 0);
    }
    return $wizardState.timepoints.reduce((sum, tp) => sum + tp.fastaFiles.length, 0);
  }

  function buildPipelineConfig(stagingDir: string, cohortType?: string) {
    return {
      fasta_dir: stagingDir,
      clean_fasta: $wizardState.cleanFasta,
      database_type: $wizardState.databaseType,
      species: $wizardState.species,
      database_v: $wizardState.customDatabaseV || undefined,
      database_d: $wizardState.customDatabaseD || undefined,
      database_j: $wizardState.customDatabaseJ || undefined,
      clone_mode: $wizardState.cloneMode,
      linkage_method: $wizardState.linkageMethod,
      run_covid_matching: $wizardState.runCovidMatching,
      cov_abdab_database_path: $wizardState.covAbdabPath || undefined,
      study_name: $wizardState.studyName,
      cohort_type: cohortType
    };
  }
  
  async function handleStartAnalysis() {
    if (!window.electronAPI) return;
    
    if ($wizardState.runCovidMatching && !$wizardState.covAbdabPath) {
      alert('Please select a CoV-AbDab database file to enable COVID matching.');
      return;
    }
    
    stagingError = '';
    resetAnalysis();
    analysisState.update(s => ({ ...s, isRunning: true }));
    
    try {
      if ($wizardState.inputFormat === 'airr_tsv') {
        await runAirrAnalysis();
      } else if ($wizardState.hasControlCohort && $wizardState.cohorts.length >= 2) {
        await runMultiCohortAnalysis();
      } else {
        await runSingleCohortAnalysis();
      }
    } catch (error: any) {
      analysisState.update(s => ({
        ...s,
        isRunning: false,
        error: error.message || 'An unexpected error occurred'
      }));
    }
  }

  async function runSingleCohortAnalysis() {
    const timepointsForStaging = $wizardState.timepoints.map(tp => ({
      label: tp.label,
      files: tp.fastaFiles,
      annotationFiles: tp.annotationFiles
    }));
    
    const stageResult = await window.electronAPI.stageFiles(timepointsForStaging, $wizardState.studyName);
    
    if (!stageResult.success || !stageResult.stagingDir) {
      stagingError = stageResult.error || 'Failed to stage files';
      analysisState.update(s => ({ ...s, isRunning: false, error: stagingError }));
      return;
    }
    
    console.log('[ReviewStart] Files staged to:', stageResult.stagingDir);
    await window.electronAPI.startPipeline({
      ...buildPipelineConfig(stageResult.stagingDir),
      timepoints: timepointsForStaging
    });
  }

  /**
   * Filesystem-safe slug from a cohort name: lowercase, alphanumerics + dashes.
   * Used to disambiguate staging-dir suffix and as a backup cohort_type when
   * the cohort was created beyond the original 2-cohort flow (where type is
   * literally 'disease' or 'control').
   */
  function cohortSlug(name: string, fallback: string): string {
    const slug = name.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || fallback;
  }

  /**
   * Run each cohort sequentially. Generalised from the old 2-cohort
   * (disease → control) flow to N cohorts so multi-arm studies (e.g. mouse
   * treatment groups: IgG, CTLA-4, LC, LCP) can run end-to-end.
   *
   * Each cohort gets:
   *   - its own staging directory (suffixed by a slug of the cohort name)
   *   - its own pipeline invocation
   *   - a cohort_type identifier that downstream code uses to key results
   * Cohorts run one at a time because they share output infrastructure
   * (IgBLAST scratch dirs, threshold dialog), parallelising is a separate
   * project.
   */
  async function runMultiCohortAnalysis() {
    if ($wizardState.cohorts.length < 2) {
      stagingError = 'Multi-cohort mode needs at least two cohorts';
      analysisState.update(s => ({ ...s, isRunning: false, error: stagingError }));
      return;
    }

    for (let i = 0; i < $wizardState.cohorts.length; i++) {
      const cohort = $wizardState.cohorts[i];
      const slug = cohortSlug(cohort.name, `cohort${i + 1}`);

      // Prefer the explicit type ('disease' | 'control' | 'cohort_<id>') so
      // back-compat with the old 2-cohort flow is preserved; fall back to slug
      // for any cohort missing one.
      const cohortType = cohort.type || slug;

      const tps = cohort.timepoints.map(tp => ({
        label: tp.label,
        files: tp.fastaFiles,
        annotationFiles: tp.annotationFiles
      }));

      const stage = await window.electronAPI.stageFiles(tps, `${$wizardState.studyName}_${slug}`);
      if (!stage.success || !stage.stagingDir) {
        stagingError = stage.error || `Failed to stage ${cohort.name} files`;
        analysisState.update(s => ({ ...s, isRunning: false, error: stagingError }));
        return;
      }

      console.log(`[ReviewStart] ${cohort.name} (${cohortType}) files staged to:`, stage.stagingDir);
      await window.electronAPI.startPipeline({
        ...buildPipelineConfig(stage.stagingDir, cohortType),
        cohort_name: cohort.name,
        timepoints: tps
      });
    }
  }

  /**
   * AIRR + SampleTag input mode (BD Rhapsody): one preprocess call splits
   * the combined AIRR TSV into per-cohort, per-mouse staging dirs, then
   * each cohort is run through the regular pipeline just like FASTA mode.
   * Cohorts are derived from the user-filled group field on each SampleTag.
   */
  async function runAirrAnalysis() {
    const ai = $wizardState.airrInput;
    if (!ai?.airrTsvPath || !ai?.sampleTagCsvPath) {
      stagingError = 'AIRR TSV and Sample_Tag_Calls.csv must both be selected';
      analysisState.update(s => ({ ...s, isRunning: false, error: stagingError }));
      return;
    }
    const assignments = (ai.tagAssignments ?? []).filter(a => a.group?.trim());
    if (assignments.length === 0) {
      stagingError = 'At least one SampleTag must be assigned to a treatment group';
      analysisState.update(s => ({ ...s, isRunning: false, error: stagingError }));
      return;
    }

    // 1. Stage all cohorts in one pass
    console.log('[ReviewStart] Calling stageFromAirr with', assignments.length, 'tag assignments');
    const stage = await window.electronAPI.stageFromAirr({
      airrTsvPath: ai.airrTsvPath,
      sampleTagCsvPath: ai.sampleTagCsvPath,
      tagAssignments: assignments,
      studyName: $wizardState.studyName
    });
    if (!stage.success || !stage.cohorts) {
      stagingError = stage.error || 'Failed to stage AIRR input';
      analysisState.update(s => ({ ...s, isRunning: false, error: stagingError }));
      return;
    }
    console.log('[ReviewStart] AIRR staging summary:', stage.summary);

    // 2. Mirror multi-cohort: push the derived cohorts into wizardState so
    //    the orchestrator's downstream code (progress scaler, result keying)
    //    knows about them.
    const derivedCohorts = stage.cohorts.map((c, i) => ({
      id: `airr_${i}`,
      name: c.name,
      type: `cohort_airr_${i}`,
      timepoints: []   // not used downstream when staging dir is given directly
    }));
    wizardState.update(s => ({
      ...s,
      hasControlCohort: derivedCohorts.length > 1,
      cohorts: derivedCohorts
    }));

    // 3. Run each cohort's pipeline using the AIRR-derived staging dir
    for (let i = 0; i < stage.cohorts.length; i++) {
      const c = stage.cohorts[i];
      const cohortType = derivedCohorts[i].type;
      // Convert the timepoint_mapping into the wizard's per-timepoint shape so
      // the downstream pipeline gets the same `timepoints` list it expects.
      const tpMap = c.timepointMapping;
      const tpsByLabel = new Map<string, { label: string; files: string[]; annotationFiles: string[] }>();
      for (const [stagedName, entry] of Object.entries(tpMap)) {
        let bucket = tpsByLabel.get(entry.timepoint);
        if (!bucket) {
          bucket = { label: entry.timepoint, files: [], annotationFiles: [] };
          tpsByLabel.set(entry.timepoint, bucket);
        }
        bucket.files.push(stagedName);
      }
      const tps = Array.from(tpsByLabel.values());

      console.log(`[ReviewStart] AIRR cohort ${c.name} → ${c.stagingDir} (${tps.length} timepoint(s))`);
      await window.electronAPI.startPipeline({
        ...buildPipelineConfig(c.stagingDir, cohortType),
        cohort_name: c.name,
        timepoints: tps
      });
    }
  }

  async function selectCovidDatabase() {
    if (!window.electronAPI) return;
    
    try {
      const result = await window.electronAPI.selectFile({
        filters: [
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      
      if (result) {
        wizardState.update(s => ({
          ...s,
          covAbdabPath: result
        }));
      }
    } catch (error: any) {
      console.error('Error selecting COVID database:', error);
    }
  }
  
  function getFileName(path: string): string {
    return path.split('/').pop() || path;
  }
</script>

<div class="step-container">
  <header class="step-header">
    <span class="step-number">Step 3</span>
    <h1 class="step-title">Review & Start</h1>
    <p class="step-description">
      Review your analysis settings before starting. The analysis may take several minutes 
      depending on the number of sequences.
    </p>
  </header>
  
  <div class="step-content">
    <!-- Summary card -->
    <div class="summary-card">
      <div class="summary-header">
        <h2 class="summary-title">Analysis Configuration</h2>
        <span class="ready-badge">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M11.5 4L5.5 10L2.5 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Ready to Start
        </span>
      </div>
      
      <div class="summary-sections">
        <!-- Study & Timepoints Section -->
        <div class="summary-section">
          <div class="section-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="5" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
              <path d="M2 8h16" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </div>
          <div class="section-content">
            <h3 class="section-title">Study: {$wizardState.studyName}</h3>
            <div class="section-details">
              {#if $wizardState.hasControlCohort}
                <div class="detail-row">
                  <span class="detail-label">Cohorts</span>
                  <span class="detail-value">{$wizardState.cohorts.length} (Disease + Control)</span>
                </div>
                {#each $wizardState.cohorts as cohort}
                  <div class="detail-row">
                    <span class="detail-label tp-indent">{cohort.name} ({cohort.type})</span>
                    <span class="detail-value">{cohort.timepoints.length} timepoint{cohort.timepoints.length !== 1 ? 's' : ''}</span>
                  </div>
                  {#each cohort.timepoints as tp}
                    <div class="detail-row">
                      <span class="detail-label" style="padding-left: 2rem; font-style: italic;">{tp.label}</span>
                      <span class="detail-value">{tp.fastaFiles.length} file{tp.fastaFiles.length !== 1 ? 's' : ''}</span>
                    </div>
                  {/each}
                {/each}
              {:else}
                <div class="detail-row">
                  <span class="detail-label">Timepoints</span>
                  <span class="detail-value">{$wizardState.timepoints.length}</span>
                </div>
                {#each $wizardState.timepoints as tp}
                  <div class="detail-row">
                    <span class="detail-label tp-indent">{tp.label}</span>
                    <span class="detail-value">{tp.fastaFiles.length} file{tp.fastaFiles.length !== 1 ? 's' : ''}</span>
                  </div>
                {/each}
              {/if}
              <div class="detail-row">
                <span class="detail-label">Total Files</span>
                <span class="detail-value">{totalFileCount()} FASTA file{totalFileCount() !== 1 ? 's' : ''}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Clean Files</span>
                <span class="detail-value">{$wizardState.cleanFasta ? 'Yes' : 'No'}</span>
              </div>
            </div>
          </div>
          <button class="edit-btn" on:click={() => wizardState.update(s => ({...s, step: 1}))}>
            Edit
          </button>
        </div>
        
        <!-- Database Section -->
        <div class="summary-section">
          <div class="section-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <ellipse cx="10" cy="5" rx="7" ry="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M3 5v10c0 1.66 3.13 3 7 3s7-1.34 7-3V5" stroke="currentColor" stroke-width="1.5"/>
              <path d="M3 10c0 1.66 3.13 3 7 3s7-1.34 7-3" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </div>
          <div class="section-content">
            <h3 class="section-title">Reference Database</h3>
            <div class="section-details">
              <div class="detail-row">
                <span class="detail-label">Type</span>
                <span class="detail-value">
                  {$wizardState.databaseType === 'IMGT' ? 'IMGT Human Database' : 'Custom Database'}
                </span>
              </div>
              {#if $wizardState.databaseType === 'Custom'}
                <div class="detail-row">
                  <span class="detail-label">V Gene</span>
                  <span class="detail-value file">{getFileName($wizardState.customDatabaseV || '')}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">D Gene</span>
                  <span class="detail-value file">{getFileName($wizardState.customDatabaseD || '')}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">J Gene</span>
                  <span class="detail-value file">{getFileName($wizardState.customDatabaseJ || '')}</span>
                </div>
              {/if}
            </div>
          </div>
          <button class="edit-btn" on:click={() => wizardState.update(s => ({...s, step: 2}))}>
            Edit
          </button>
        </div>
        
        <!-- Clone Definition Settings Section -->
        <div class="summary-section">
          <div class="section-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="6" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="14" cy="6" r="2" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="6" cy="14" r="2" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="14" cy="14" r="2" stroke="currentColor" stroke-width="1.5"/>
              <path d="M8 6h4M8 14h4M6 8v4M14 8v4" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </div>
          <div class="section-content">
            <h3 class="section-title">Clone Definition Settings</h3>
            <div class="section-details">
              <div class="detail-row">
                <span class="detail-label">V/J Mode</span>
                <div class="setting-control">
                  <select 
                    class="select-sm" 
                    bind:value={$wizardState.cloneMode}
                  >
                    <option value="allele">Allele (Strict - Recommended)</option>
                    <option value="gene">Gene (Permissive)</option>
                  </select>
                </div>
              </div>
              <div class="detail-row">
                <span class="detail-label">Linkage</span>
                <div class="setting-control">
                  <select 
                    class="select-sm" 
                    bind:value={$wizardState.linkageMethod}
                  >
                    <option value="complete">Complete (Strictest)</option>
                    <option value="average">Average (Recommended)</option>
                    <option value="single">Single (Permissive)</option>
                  </select>
                </div>
              </div>
            </div>
            <div class="settings-help">
              <p class="help-text">
                <strong>V/J Mode:</strong> 'Allele' requires exact allele matches (e.g., IGKV3-20*01). 
                'Gene' groups all alleles of a gene (e.g., IGKV3-20*01, *02, *03).
              </p>
              <p class="help-text">
                <strong>Linkage:</strong> Determines how sequences are clustered. 
                'Average' balances sensitivity and specificity (recommended for most analyses).
              </p>
            </div>
          </div>
        </div>

        <!-- COVID Database Matching Section -->
        <div class="summary-section">
          <div class="section-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M3 3v14M17 3v14M7 5l6 2.5-6 2.5 6 2.5-6 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="section-content">
            <h3 class="section-title">COVID-19 Database Matching (Optional)</h3>
            <div class="section-details">
              <div class="detail-row">
                <label class="checkbox-label">
                  <input 
                    type="checkbox" 
                    bind:checked={$wizardState.runCovidMatching}
                  />
                  <span>Compare top clones against CoV-AbDab database</span>
                </label>
              </div>
              
              {#if $wizardState.runCovidMatching}
                <div class="detail-row file-input-row">
                  <span class="detail-label">Database File</span>
                  <div class="file-input-group">
                    {#if $wizardState.covAbdabPath}
                      <span class="file-selected">{getFileName($wizardState.covAbdabPath)}</span>
                    {:else}
                      <span class="file-placeholder">No file selected</span>
                    {/if}
                    <button 
                      class="btn-file-select"
                      on:click={selectCovidDatabase}
                    >
                      Browse...
                    </button>
                  </div>
                </div>
              {/if}
            </div>
            <div class="settings-help">
              <p class="help-text">
                Matches your largest 20 clones against <strong>12,918 known COVID-19 antibodies</strong> from the 
                <a href="http://opig.stats.ox.ac.uk/webapps/covabdab/" target="_blank" rel="noopener noreferrer">CoV-AbDab database</a>.
                Compares both full VH sequences and CDR3 regions.
              </p>
              {#if $wizardState.runCovidMatching && !$wizardState.covAbdabPath}
                <p class="help-text warning">
                  <strong>⚠ Please select a CoV-AbDab CSV file to enable matching.</strong>
                </p>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>
    
    {#if stagingError}
      <div class="staging-error">
        <strong>Staging Error:</strong> {stagingError}
      </div>
    {/if}
    
    <!-- Analysis steps info -->
    <div class="analysis-info">
      <h3 class="info-title">Analysis Pipeline</h3>
      <p class="info-description">
        The following steps will be performed:
      </p>
      <div class="pipeline-steps">
        <div class="pipeline-step">
          <span class="step-marker">1</span>
          <div class="step-info">
            <span class="step-name">IgBLAST Alignment</span>
            <span class="step-desc">Align sequences against germline database</span>
          </div>
        </div>
        <div class="pipeline-step">
          <span class="step-marker">2</span>
          <div class="step-info">
            <span class="step-name">Distance Calculation</span>
            <span class="step-desc">Calculate pairwise sequence distances</span>
          </div>
        </div>
        <div class="pipeline-step">
          <span class="step-marker">3</span>
          <div class="step-info">
            <span class="step-name">Clone Definition</span>
            <span class="step-desc">Identify clonal families using threshold</span>
          </div>
        </div>
        <div class="pipeline-step">
          <span class="step-marker">4</span>
          <div class="step-info">
            <span class="step-name">Germline Reconstruction</span>
            <span class="step-desc">Generate inferred germline sequences</span>
          </div>
        </div>
        <div class="pipeline-step">
          <span class="step-marker">5</span>
          <div class="step-info">
            <span class="step-name">Phylogenetic Trees</span>
            <span class="step-desc">Build lineage trees for top clones</span>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <footer class="step-footer">
    <button class="btn btn-ghost" on:click={handleBack}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 4l-4 4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Back
    </button>
    <button 
      class="btn btn-primary btn-lg start-btn"
      on:click={handleStartAnalysis}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M4 3l11 6-11 6V3z" fill="currentColor"/>
      </svg>
      Start Analysis
    </button>
  </footer>
</div>

<style>
  .step-container {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }
  
  .step-header {
    margin-bottom: var(--space-8);
  }
  
  .step-number {
    display: inline-block;
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--color-primary);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: var(--space-2);
  }
  
  .step-title {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--text-primary);
    margin: 0 0 var(--space-2) 0;
  }
  
  .step-description {
    font-size: var(--text-base);
    color: var(--text-secondary);
    line-height: var(--leading-relaxed);
    margin: 0;
  }
  
  .step-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  
  .summary-card {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    overflow: hidden;
  }
  
  .summary-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4) var(--space-5);
    background: var(--gray-50);
    border-bottom: 1px solid var(--border-light);
  }
  
  .summary-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
  }
  
  .ready-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    background: var(--color-success-light);
    color: var(--color-success);
    border-radius: var(--border-radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }
  
  .summary-sections {
    padding: var(--space-2);
  }
  
  .summary-section {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4);
    border-radius: var(--border-radius-md);
    transition: background var(--transition-fast);
  }
  
  .summary-section:hover {
    background: var(--gray-50);
  }
  
  .section-icon {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-primary-light);
    color: var(--color-primary);
    border-radius: var(--border-radius-md);
    flex-shrink: 0;
  }
  
  .section-content {
    flex: 1;
    min-width: 0;
  }
  
  .section-title {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
    margin: 0 0 var(--space-2) 0;
  }
  
  .section-details {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  
  .detail-row {
    display: flex;
    gap: var(--space-3);
    font-size: var(--text-xs);
  }
  
  .detail-label {
    color: var(--text-tertiary);
    min-width: 80px;
  }
  
  .detail-label.tp-indent {
    padding-left: var(--space-3);
    font-style: italic;
  }
  
  .detail-value {
    color: var(--text-secondary);
    font-weight: var(--font-medium);
  }
  
  .detail-value.file {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  
  .edit-btn {
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-md);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    cursor: pointer;
    opacity: 0;
    transition: all var(--transition-fast);
    align-self: flex-start;
  }
  
  .summary-section:hover .edit-btn {
    opacity: 1;
  }
  
  .edit-btn:hover {
    background: var(--gray-100);
    color: var(--text-primary);
  }
  
  .analysis-info {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    padding: var(--space-5);
  }
  
  .info-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0 0 var(--space-1) 0;
  }
  
  .info-description {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin: 0 0 var(--space-4) 0;
  }
  
  .pipeline-steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  
  .pipeline-step {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }
  
  .step-marker {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--gray-100);
    color: var(--text-tertiary);
    border-radius: var(--border-radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    flex-shrink: 0;
  }
  
  .step-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .step-name {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
  }
  
  .step-desc {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  
  .step-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: var(--space-8);
    padding-top: var(--space-6);
    border-top: 1px solid var(--border-light);
  }
  
  .btn svg {
    margin-right: var(--space-2);
  }
  
  .start-btn {
    padding-left: var(--space-6);
    padding-right: var(--space-6);
  }
  
  .start-btn svg {
    margin-right: var(--space-3);
  }
  
  .setting-control {
    flex: 1;
  }
  
  .select-sm {
    width: 100%;
    padding: var(--space-1) var(--space-2);
    background: var(--surface-base);
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-sm);
    font-size: var(--text-xs);
    color: var(--text-primary);
    cursor: pointer;
    transition: border-color var(--transition-fast);
  }
  
  .select-sm:hover {
    border-color: var(--color-primary);
  }
  
  .select-sm:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-light);
  }
  
  .settings-help {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-light);
  }
  
  .help-text {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    line-height: var(--leading-relaxed);
    margin: 0 0 var(--space-2) 0;
  }
  
  .help-text:last-child {
    margin-bottom: 0;
  }
  
  .help-text strong {
    color: var(--text-secondary);
    font-weight: var(--font-medium);
  }
  
  .help-text.warning {
    color: var(--warning-text, #d97706);
    background: var(--warning-bg, #fef3c7);
    padding: var(--space-2);
    border-radius: var(--border-radius-sm);
    border-left: 3px solid var(--warning-border, #f59e0b);
  }
  
  .help-text a {
    color: var(--color-primary);
    text-decoration: underline;
  }
  
  .help-text a:hover {
    color: var(--color-primary-dark);
  }
  
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  
  .checkbox-label input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
  
  .file-input-row {
    flex-direction: column;
    align-items: stretch;
  }
  
  .file-input-group {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }
  
  .file-selected {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-base);
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-sm);
    font-size: var(--text-xs);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .file-placeholder {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-base);
    border: 1px dashed var(--border-default);
    border-radius: var(--border-radius-sm);
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-style: italic;
  }
  
  .btn-file-select {
    padding: var(--space-2) var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-sm);
    font-size: var(--text-xs);
    color: var(--text-primary);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }
  
  .btn-file-select:hover {
    background: var(--surface-hover);
    border-color: var(--color-primary);
  }
  
  .btn-file-select:active {
    transform: translateY(1px);
  }
  
  .staging-error {
    padding: var(--space-3) var(--space-4);
    background: var(--color-error-light, #fef2f2);
    color: var(--color-error, #dc2626);
    border: 1px solid var(--color-error, #dc2626);
    border-radius: var(--border-radius-md);
    font-size: var(--text-sm);
  }
</style>

