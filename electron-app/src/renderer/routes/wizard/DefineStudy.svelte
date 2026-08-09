<script lang="ts">
  import { wizardState, canProceedStep1, GROUP_COLORS,
           type WizardTimepoint, type WizardCohort,
           type InputFormat, type SampleTagAssignment } from '../../lib/stores/app';

  let isLoading = false;
  /** Holds the user-facing summary line shown after the SampleTag CSV is parsed. */
  let airrParseError: string = '';

  function genId(): string {
    return Math.random().toString(36).slice(2, 8);
  }

  /** Visual color for a cohort, looked up by its position in the cohorts array. */
  function cohortColor(index: number): string {
    return GROUP_COLORS[index % GROUP_COLORS.length];
  }

  /** Default cohort name for the Nth cohort when none is provided. */
  function defaultCohortName(index: number): string {
    if (index === 0) return 'Disease';
    if (index === 1) return 'Control';
    return `Cohort ${index + 1}`;
  }

  // ── Multi-cohort management ──

  /**
   * Enable multi-cohort mode. Creates two starter cohorts ("Disease" + "Control")
   * preserving the historical 2-cohort UX for human studies. From there the
   * user can add more via "+ Add cohort" for N-cohort studies (e.g. mouse
   * treatment groups).
   */
  function enableMultiCohort() {
    wizardState.update(s => {
      if (s.cohorts.length >= 2) return s;
      const c1: WizardCohort = {
        id: genId(),
        name: 'Disease',
        type: 'disease',
        timepoints: s.timepoints.length > 0 ? [...s.timepoints] : []
      };
      const c2: WizardCohort = {
        id: genId(), name: 'Control', type: 'control', timepoints: []
      };
      return { ...s, hasControlCohort: true, cohorts: [c1, c2] };
    });
  }

  function disableMultiCohort() {
    wizardState.update(s => {
      // Promote the first cohort's timepoints back into the flat timepoints array
      const primaryTps = s.cohorts[0]?.timepoints ?? s.timepoints;
      return { ...s, hasControlCohort: false, cohorts: [], timepoints: primaryTps };
    });
  }

  function toggleMultiCohort() {
    if ($wizardState.hasControlCohort) disableMultiCohort();
    else enableMultiCohort();
  }

  /** Add an extra cohort (beyond the first two). */
  function addCohort() {
    wizardState.update(s => {
      const idx = s.cohorts.length;
      const name = defaultCohortName(idx);
      // Reserve 'cohort_<id>' as type for N>2 cohorts so the type field stays
      // a stable identifier without colliding with 'disease' / 'control'.
      const id = genId();
      return {
        ...s,
        cohorts: [...s.cohorts, { id, name, type: `cohort_${id}`, timepoints: [] }]
      };
    });
  }

  /** Remove a single cohort by id. If this leaves <2 cohorts, drop back into single-cohort mode. */
  function removeCohort(cohortId: string) {
    wizardState.update(s => {
      const remaining = s.cohorts.filter(c => c.id !== cohortId);
      if (remaining.length < 2) {
        const primaryTps = remaining[0]?.timepoints ?? s.timepoints;
        return { ...s, hasControlCohort: false, cohorts: [], timepoints: primaryTps };
      }
      return { ...s, cohorts: remaining };
    });
  }

  // Keep top-level timepoints in sync with the first cohort's timepoints
  // (needed because canProceedStep1 looks at both shapes for backwards compat).
  $: if ($wizardState.hasControlCohort && $wizardState.cohorts.length >= 1) {
    const firstTps = $wizardState.cohorts[0]?.timepoints ?? [];
    if (firstTps !== $wizardState.timepoints) {
      wizardState.update(s => ({ ...s, timepoints: firstTps }));
    }
  }

  // ── Folder selection (per timepoint) ──

  function extractFilesFromResult(result: any): { fastaFiles: string[]; annotationFiles: string[] } {
    if (result.mode === '10x' && result.filePairs?.length > 0) {
      return {
        fastaFiles: result.filePairs.map((p: any) => p.fasta),
        annotationFiles: result.filePairs.map((p: any) => p.annotations)
      };
    }
    const fastaFiles = result.files.length > 0
      ? result.files.map((f: string) => result.path + '/' + f)
      : (result.detectedTimepoints || []).flatMap((tp: any) => tp.files.map((f: string) => tp.dir + '/' + f));
    return { fastaFiles, annotationFiles: [] };
  }

  async function handleSelectTimepointFolder(tpIndex: number) {
    if (!window.electronAPI) return;
    isLoading = true;
    try {
      const result = await window.electronAPI.selectDirectory();
      if (!result) return;

      const { fastaFiles, annotationFiles } = extractFilesFromResult(result);

      wizardState.update(s => {
        const tps = [...s.timepoints];
        tps[tpIndex] = { ...tps[tpIndex], fastaDir: result.path, fastaFiles, annotationFiles };
        return { ...s, timepoints: tps };
      });
    } catch (error) {
      console.error('Error selecting directory:', error);
    } finally {
      isLoading = false;
    }
  }

  async function handleSelectTimepointFolderForCohort(cohortId: string, tpIndex: number) {
    if (!window.electronAPI) return;
    isLoading = true;
    try {
      const result = await window.electronAPI.selectDirectory();
      if (!result) return;

      const { fastaFiles, annotationFiles } = extractFilesFromResult(result);

      wizardState.update(s => {
        const cohorts = s.cohorts.map(c => {
          if (c.id !== cohortId) return c;
          const tps = [...c.timepoints];
          tps[tpIndex] = { ...tps[tpIndex], fastaDir: result.path, fastaFiles, annotationFiles };
          return { ...c, timepoints: tps };
        });
        return { ...s, cohorts };
      });
    } catch (error) {
      console.error('Error selecting directory:', error);
    } finally {
      isLoading = false;
    }
  }

  // ── Timepoint CRUD (single cohort) ──

  function addEmptyTimepoint() {
    wizardState.update(s => ({
      ...s,
      timepoints: [...s.timepoints, { id: genId(), label: `T${s.timepoints.length + 1}`, fastaDir: null, fastaFiles: [], annotationFiles: [] }]
    }));
  }

  function removeTimepoint(index: number) {
    wizardState.update(s => ({ ...s, timepoints: s.timepoints.filter((_, i) => i !== index) }));
  }

  function updateTimepointLabel(index: number, label: string) {
    wizardState.update(s => {
      const tps = [...s.timepoints];
      tps[index] = { ...tps[index], label };
      return { ...s, timepoints: tps };
    });
  }

  // ── Timepoint CRUD (cohort-aware, by id) ──

  function addEmptyTimepointForCohort(cohortId: string) {
    wizardState.update(s => {
      const cohorts = s.cohorts.map(c => {
        if (c.id !== cohortId) return c;
        return { ...c, timepoints: [...c.timepoints, { id: genId(), label: `T${c.timepoints.length + 1}`, fastaDir: null, fastaFiles: [], annotationFiles: [] }] };
      });
      return { ...s, cohorts };
    });
  }

  function removeTimepointForCohort(cohortId: string, index: number) {
    wizardState.update(s => {
      const cohorts = s.cohorts.map(c => {
        if (c.id !== cohortId) return c;
        return { ...c, timepoints: c.timepoints.filter((_, i) => i !== index) };
      });
      return { ...s, cohorts };
    });
  }

  function updateTimepointLabelForCohort(cohortId: string, index: number, label: string) {
    wizardState.update(s => {
      const cohorts = s.cohorts.map(c => {
        if (c.id !== cohortId) return c;
        const tps = [...c.timepoints];
        tps[index] = { ...tps[index], label };
        return { ...c, timepoints: tps };
      });
      return { ...s, cohorts };
    });
  }

  function updateCohortName(cohortId: string, name: string) {
    wizardState.update(s => ({
      ...s,
      cohorts: s.cohorts.map(c => c.id === cohortId ? { ...c, name } : c)
    }));
  }

  // ── Other ──

  function handleStudyNameChange(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    wizardState.update(s => ({ ...s, studyName: val }));
  }

  // ── Input-format toggle ──

  function setInputFormat(fmt: InputFormat) {
    wizardState.update(s => ({ ...s, inputFormat: fmt }));
  }

  // ── AIRR file pickers + tag-table ──

  async function pickAirrFile(field: 'airrTsvPath' | 'sampleTagCsvPath') {
    if (!window.electronAPI) return;
    isLoading = true;
    airrParseError = '';
    try {
      const exts = field === 'airrTsvPath' ? ['tsv', 'gz', 'txt'] : ['csv', 'txt'];
      const result = await window.electronAPI.selectFile({
        filters: [
          { name: field === 'airrTsvPath' ? 'AIRR TSV (possibly gzipped)' : 'Sample_Tag_Calls.csv', extensions: exts },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (!result) return;

      wizardState.update(s => {
        const airrInput = s.airrInput ?? { airrTsvPath: '', sampleTagCsvPath: '', tagAssignments: [] };
        return { ...s, airrInput: { ...airrInput, [field]: result } };
      });

      // If the user just picked the Sample_Tag_Calls.csv, auto-populate the
      // tag-assignment table by scanning the file for tag names.
      if (field === 'sampleTagCsvPath') {
        await refreshAirrTagAssignments();
      }
    } catch (err: any) {
      airrParseError = err.message || 'Failed to pick file';
    } finally {
      isLoading = false;
    }
  }

  /** Read the Sample_Tag_Calls.csv to extract the distinct SampleTag names. */
  async function refreshAirrTagAssignments() {
    const path = $wizardState.airrInput?.sampleTagCsvPath;
    if (!path || !window.electronAPI) return;
    try {
      // Cast: the preload's typed interface declares `content` but the main
      // process actually returns `data` (long-standing mismatch, see
      // InteractiveTree.svelte for the canonical correct reader).
      const res = await window.electronAPI.readFile(path) as { success: boolean; data?: string; error?: string };
      if (!res.success || !res.data) {
        airrParseError = res.error || 'Could not read Sample_Tag_Calls.csv';
        return;
      }
      const tags = parseSampleTagsFromCsv(res.data);
      // Build a fresh assignment list; if some assignments already exist
      // (e.g. user came back to the screen), preserve them.
      const existing = new Map(
        ($wizardState.airrInput?.tagAssignments ?? []).map(a => [a.sampleTag, a])
      );
      const fresh: SampleTagAssignment[] = tags.map(tag =>
        existing.get(tag) ?? { sampleTag: tag, group: '', mouseLabel: '', timepoint: 'endpoint' }
      );
      wizardState.update(s => {
        const airrInput = s.airrInput ?? { airrTsvPath: '', sampleTagCsvPath: path, tagAssignments: [] };
        return { ...s, airrInput: { ...airrInput, tagAssignments: fresh } };
      });
    } catch (err: any) {
      airrParseError = err.message || 'Could not parse Sample_Tag_Calls.csv';
    }
  }

  /** Pull the distinct SampleTag values out of the BD Rhapsody CSV (skips '#' headers + Multiplet/Undetermined). */
  function parseSampleTagsFromCsv(content: string): string[] {
    const lines = content.split(/\r?\n/);
    const tags = new Set<string>();
    let headerSeen = false;
    let tagIdx = -1;
    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) continue;
      const cols = line.split(',');
      if (!headerSeen) {
        tagIdx = cols.findIndex(c => c.trim() === 'Sample_Tag');
        headerSeen = true;
        continue;
      }
      const tag = cols[tagIdx]?.trim();
      if (!tag || tag === 'Multiplet' || tag === 'Undetermined') continue;
      tags.add(tag);
    }
    return Array.from(tags).sort();
  }

  function updateTagAssignment(sampleTag: string, field: keyof SampleTagAssignment, value: string) {
    wizardState.update(s => {
      if (!s.airrInput) return s;
      const tagAssignments = s.airrInput.tagAssignments.map(a =>
        a.sampleTag === sampleTag ? { ...a, [field]: value } : a
      );
      return { ...s, airrInput: { ...s.airrInput, tagAssignments } };
    });
  }

  /** Cohort names derived from the user-entered group fields, in first-seen order. */
  $: derivedCohorts = (() => {
    const seen: string[] = [];
    for (const a of $wizardState.airrInput?.tagAssignments ?? []) {
      const g = a.group.trim();
      if (g && !seen.includes(g)) seen.push(g);
    }
    return seen;
  })();

  /** Per-cohort SampleTag count for the preview. */
  $: cohortTagCounts = (() => {
    const counts: Record<string, number> = {};
    for (const a of $wizardState.airrInput?.tagAssignments ?? []) {
      const g = a.group.trim();
      if (g) counts[g] = (counts[g] ?? 0) + 1;
    }
    return counts;
  })();

  function handleCleanFastaChange(e: Event) {
    const target = e.target as HTMLInputElement;
    wizardState.update(s => ({ ...s, cleanFasta: target.checked }));
  }

  function handleNext() {
    wizardState.update(s => ({ ...s, step: 2 as 1 | 2 | 3 }));
  }

  function totalFileCount(tps: WizardTimepoint[]): number {
    return tps.reduce((sum, tp) => sum + tp.fastaFiles.length, 0);
  }

</script>

<div class="step-container">
  <header class="step-header">
    <span class="step-number">Step 1</span>
    <h1 class="step-title">Define Study</h1>
    <p class="step-description">
      Name your study, add timepoints, and select FASTA files for each timepoint.
    </p>
  </header>

  <div class="step-content">
    <!-- Study name -->
    <div class="field-group">
      <label class="field-label" for="study-name">Study Name</label>
      <input
        id="study-name"
        type="text"
        class="text-input"
        placeholder="e.g. Memory Loss, COVID Recovery..."
        value={$wizardState.studyName}
        on:input={handleStudyNameChange}
      />
    </div>

    <!-- Input format toggle (top of step 1) -->
    <div class="input-format-section">
      <div class="input-format-label">Input format</div>
      <div class="input-format-pills">
        <button class="input-format-pill" class:active={$wizardState.inputFormat === 'fasta'}
                on:click={() => setInputFormat('fasta')}>
          <strong>Per-sample FASTA files</strong>
          <span class="input-format-hint">One FASTA per sample / patient. Standard 10x or pre-staged input.</span>
        </button>
        <button class="input-format-pill" class:active={$wizardState.inputFormat === 'airr_tsv'}
                on:click={() => setInputFormat('airr_tsv')}>
          <strong>AIRR TSV + Sample Tag CSV</strong>
          <span class="input-format-hint">BD Rhapsody output: one combined AIRR TSV across all samples + the BD per-cell sample-tag calls.</span>
        </button>
      </div>
    </div>

    {#if $wizardState.inputFormat === 'fasta'}
    <!-- Multi-cohort toggle (always visible, prominent) -->
    <div class="control-toggle-section">
      <label class="checkbox-option">
        <input type="checkbox" checked={$wizardState.hasControlCohort} on:change={toggleMultiCohort} />
        <div class="checkbox-content">
          <span class="checkbox-label">Multi-cohort study</span>
          <span class="checkbox-description">
            Compare two or more groups (e.g. disease vs control, or multiple treatment arms).
            Each cohort is analysed independently and compared side-by-side.
          </span>
        </div>
      </label>
    </div>
    {/if}

    {#if $wizardState.inputFormat === 'fasta'}
    {#if !$wizardState.hasControlCohort}
      <!-- ═══ SINGLE COHORT MODE ═══ -->
      <div class="timepoints-section">
        <div class="section-header">
          <h3 class="section-title">Timepoints</h3>
          <button class="btn btn-secondary btn-sm" on:click={addEmptyTimepoint}>+ Add Timepoint</button>
        </div>

        {#if $wizardState.timepoints.length > 0}
          <div class="timepoints-list">
            {#each $wizardState.timepoints as tp, i (tp.id)}
              <div class="tp-card">
                <div class="tp-header">
                  <input type="text" class="tp-label-input" value={tp.label}
                    on:input={(e) => updateTimepointLabel(i, e.currentTarget.value)} placeholder="Timepoint name" />
                  <div class="tp-actions">
                    {#if tp.fastaFiles.length > 0}
                      <span class="tp-badge">
                        {tp.fastaFiles.length}
                        {tp.annotationFiles.length > 0 ? 'sample' : 'file'}{tp.fastaFiles.length !== 1 ? 's' : ''}
                        {#if tp.annotationFiles.length > 0}<span class="tp-badge-10x">10x</span>{/if}
                      </span>
                    {/if}
                    <button class="btn btn-ghost btn-sm" on:click={() => handleSelectTimepointFolder(i)} disabled={isLoading}>
                      {tp.fastaDir ? 'Change' : 'Select'} Folder
                    </button>
                    <button class="btn btn-ghost btn-sm btn-danger" on:click={() => removeTimepoint(i)} title="Remove timepoint">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                      </svg>
                    </button>
                  </div>
                </div>
                {#if tp.fastaDir}<div class="tp-dir">{tp.fastaDir.split('/').pop()}</div>{/if}
                {#if tp.fastaFiles.length > 0}
                  <div class="tp-files">
                    {#each tp.fastaFiles.slice(0, 5) as file}
                      <span class="tp-file">{file.split('/').pop()}</span>
                    {/each}
                    {#if tp.fastaFiles.length > 5}
                      <span class="tp-file more">+{tp.fastaFiles.length - 5} more</span>
                    {/if}
                  </div>
                {:else}
                  <div class="tp-empty">No files selected, click "Select Folder"</div>
                {/if}
              </div>
            {/each}
          </div>
        {:else}
          <div class="empty-hint">
            <p>Add timepoints and select FASTA files for each one.</p>
            <button class="btn btn-primary" on:click={addEmptyTimepoint}>+ Add First Timepoint</button>
          </div>
        {/if}

        {#if $wizardState.timepoints.length > 0}
          <div class="timepoints-summary">
            {$wizardState.timepoints.length} timepoint{$wizardState.timepoints.length !== 1 ? 's' : ''} &middot; {totalFileCount($wizardState.timepoints)} files total
          </div>
        {/if}
      </div>

    {:else}
      <!-- ═══ MULTI-COHORT MODE (N cohorts) ═══ -->
      {#each $wizardState.cohorts as cohort, ci (cohort.id)}
        <div class="cohort-section" style="border-left-color: {cohortColor(ci)}">
          <div class="cohort-header">
            <div class="cohort-indicator" style="background: {cohortColor(ci)}"></div>
            <input type="text" class="cohort-name-input" value={cohort.name}
              on:input={(e) => updateCohortName(cohort.id, e.currentTarget.value)}
              placeholder={defaultCohortName(ci)} />
            <span class="cohort-type-badge" style="background: {cohortColor(ci)}1a; color: {cohortColor(ci)}">cohort {ci + 1}</span>
            {#if $wizardState.cohorts.length > 1}
              <button class="btn btn-ghost btn-sm btn-danger" on:click={() => removeCohort(cohort.id)} title="Remove this cohort">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
            {/if}
          </div>

          <div class="timepoints-section">
            <div class="section-header">
              <h3 class="section-title">Timepoints</h3>
              <button class="btn btn-secondary btn-sm" on:click={() => addEmptyTimepointForCohort(cohort.id)}>+ Add Timepoint</button>
            </div>

            {#if cohort.timepoints.length > 0}
              <div class="timepoints-list">
                {#each cohort.timepoints as tp, i (tp.id)}
                  <div class="tp-card">
                    <div class="tp-header">
                      <input type="text" class="tp-label-input" value={tp.label}
                        on:input={(e) => updateTimepointLabelForCohort(cohort.id, i, e.currentTarget.value)} placeholder="Timepoint name" />
                      <div class="tp-actions">
                        {#if tp.fastaFiles.length > 0}
                          <span class="tp-badge">
                            {tp.fastaFiles.length}
                            {tp.annotationFiles.length > 0 ? 'sample' : 'file'}{tp.fastaFiles.length !== 1 ? 's' : ''}
                            {#if tp.annotationFiles.length > 0}<span class="tp-badge-10x">10x</span>{/if}
                          </span>
                        {/if}
                        <button class="btn btn-ghost btn-sm" on:click={() => handleSelectTimepointFolderForCohort(cohort.id, i)} disabled={isLoading}>
                          {tp.fastaDir ? 'Change' : 'Select'} Folder
                        </button>
                        <button class="btn btn-ghost btn-sm btn-danger" on:click={() => removeTimepointForCohort(cohort.id, i)} title="Remove timepoint">
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                    {#if tp.fastaDir}<div class="tp-dir">{tp.fastaDir.split('/').pop()}</div>{/if}
                    {#if tp.fastaFiles.length > 0}
                      <div class="tp-files">
                        {#each tp.fastaFiles.slice(0, 5) as file}
                          <span class="tp-file">{file.split('/').pop()}</span>
                        {/each}
                        {#if tp.fastaFiles.length > 5}
                          <span class="tp-file more">+{tp.fastaFiles.length - 5} more</span>
                        {/if}
                      </div>
                    {:else}
                      <div class="tp-empty">No files selected, click "Select Folder"</div>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <div class="empty-hint">
                <button class="btn btn-secondary btn-sm" on:click={() => addEmptyTimepointForCohort(cohort.id)}>+ Add First Timepoint</button>
              </div>
            {/if}

            {#if cohort.timepoints.length > 0}
              <div class="timepoints-summary">
                {cohort.timepoints.length} timepoint{cohort.timepoints.length !== 1 ? 's' : ''} &middot; {totalFileCount(cohort.timepoints)} files
              </div>
            {/if}
          </div>
        </div>
      {/each}

      <!-- + Add cohort (extending beyond the default 2-cohort starter) -->
      <div class="add-cohort-row">
        <button class="btn btn-secondary" on:click={addCohort}>
          + Add another cohort
        </button>
        <span class="add-cohort-hint">
          For studies with more than two treatment groups (e.g. mouse treatment arms).
        </span>
      </div>
    {/if}

    {:else}
      <!-- ═══ AIRR + SAMPLE-TAG MODE ═══ -->
      <div class="airr-section">
        <div class="field-group">
          <label class="field-label">AIRR TSV (BD <code>VDJ_Dominant_Contigs_AIRR.tsv</code> or <code>VDJ_Unfiltered_Contigs_AIRR.tsv.gz</code>)</label>
          <div class="file-picker-row">
            <input class="file-picker-display" type="text" readonly
                   value={$wizardState.airrInput?.airrTsvPath ?? ''}
                   placeholder="No file selected" />
            <button class="btn btn-secondary btn-sm" on:click={() => pickAirrFile('airrTsvPath')} disabled={isLoading}>
              {$wizardState.airrInput?.airrTsvPath ? 'Change' : 'Select'} file
            </button>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Sample_Tag_Calls.csv (BD per-cell tag assignments)</label>
          <div class="file-picker-row">
            <input class="file-picker-display" type="text" readonly
                   value={$wizardState.airrInput?.sampleTagCsvPath ?? ''}
                   placeholder="No file selected" />
            <button class="btn btn-secondary btn-sm" on:click={() => pickAirrFile('sampleTagCsvPath')} disabled={isLoading}>
              {$wizardState.airrInput?.sampleTagCsvPath ? 'Change' : 'Select'} file
            </button>
          </div>
        </div>

        {#if airrParseError}
          <div class="airr-error">{airrParseError}</div>
        {/if}

        {#if $wizardState.airrInput?.tagAssignments?.length}
          <div class="airr-table-section">
            <div class="airr-table-header">
              <h3 class="section-title">Sample-tag &rarr; treatment legend</h3>
              <span class="airr-table-hint">
                Assign each SampleTag to a treatment group and (optionally) a mouse label.
                Tags left empty are dropped from analysis.
              </span>
            </div>
            <div class="airr-table">
              <div class="airr-row airr-row-header">
                <span>Sample Tag</span>
                <span>Group (cohort)</span>
                <span>Mouse label</span>
                <span>Timepoint</span>
              </div>
              {#each $wizardState.airrInput.tagAssignments as a (a.sampleTag)}
                <div class="airr-row">
                  <span class="airr-tag-name">{a.sampleTag}</span>
                  <input type="text" class="airr-cell-input" value={a.group}
                         placeholder="e.g. IgG, CTLA-4…"
                         on:input={(e) => updateTagAssignment(a.sampleTag, 'group', e.currentTarget.value)} />
                  <input type="text" class="airr-cell-input" value={a.mouseLabel}
                         placeholder="Mouse1, Mouse2…"
                         on:input={(e) => updateTagAssignment(a.sampleTag, 'mouseLabel', e.currentTarget.value)} />
                  <input type="text" class="airr-cell-input" value={a.timepoint}
                         placeholder="endpoint"
                         on:input={(e) => updateTagAssignment(a.sampleTag, 'timepoint', e.currentTarget.value)} />
                </div>
              {/each}
            </div>
          </div>

          {#if derivedCohorts.length > 0}
            <div class="airr-preview">
              <strong>Derived cohorts:</strong>
              {#each derivedCohorts as c, ci}
                <span class="airr-preview-chip" style="background: {cohortColor(ci)}1a; color: {cohortColor(ci)}; border-color: {cohortColor(ci)}">
                  {c} <span class="airr-preview-count">({cohortTagCounts[c]} tag{cohortTagCounts[c] !== 1 ? 's' : ''})</span>
                </span>
              {/each}
            </div>
          {/if}
        {:else if $wizardState.airrInput?.sampleTagCsvPath}
          <div class="airr-error">No SampleTag values found in the CSV.</div>
        {/if}
      </div>
    {/if}

    <!-- Options -->
    <div class="options-section">
      <h3 class="options-title">Processing Options</h3>
      <label class="checkbox-option">
        <input type="checkbox" checked={$wizardState.cleanFasta} on:change={handleCleanFastaChange} />
        <div class="checkbox-content">
          <span class="checkbox-label">Clean FASTA files</span>
          <span class="checkbox-description">
            Remove IMGT formatting and standardize sequence headers.
            Recommended for IMGT-formatted files.
          </span>
        </div>
      </label>
    </div>
  </div>

  <footer class="step-footer">
    <div class="footer-spacer"></div>
    <button class="btn btn-primary btn-lg" disabled={!$canProceedStep1} on:click={handleNext}>
      Continue
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </footer>
</div>

<style>
  .step-container {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .step-header { margin-bottom: var(--space-8); }

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

  .field-group { display: flex; flex-direction: column; gap: var(--space-2); }

  .field-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
  }

  .text-input {
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    font-size: var(--text-base);
    color: var(--text-primary);
    background: var(--surface-raised);
    transition: border-color var(--transition-fast);
  }
  .text-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-muted); }
  .text-input::placeholder { color: var(--text-tertiary); }

  /* ── Timepoints ── */
  .timepoints-section { display: flex; flex-direction: column; gap: var(--space-3); }
  .section-header { display: flex; justify-content: space-between; align-items: center; }

  .section-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }

  .timepoints-list { display: flex; flex-direction: column; gap: var(--space-3); }

  .tp-card {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }

  .tp-header { display: flex; align-items: center; gap: var(--space-3); }

  .tp-label-input {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    background: transparent;
    min-width: 0;
  }
  .tp-label-input:focus { outline: none; border-color: var(--color-primary); }

  .tp-actions { display: flex; align-items: center; gap: var(--space-2); flex-shrink: 0; }

  .tp-badge { font-size: var(--text-xs); color: var(--color-success); font-weight: var(--font-medium); white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
  .tp-badge-10x { font-size: 9px; background: var(--color-primary); color: #fff; border-radius: 3px; padding: 1px 4px; font-weight: 600; letter-spacing: 0.3px; }
  .btn-danger { color: var(--color-error) !important; }
  .btn-danger:hover { background: rgba(239, 68, 68, 0.08) !important; }

  .tp-dir { font-size: var(--text-xs); color: var(--text-tertiary); margin-top: var(--space-2); padding-left: var(--space-3); }

  .tp-files { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-2); padding-left: var(--space-3); }

  .tp-file {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    background: var(--gray-100);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
  }
  .tp-file.more { color: var(--text-tertiary); font-style: italic; background: none; }

  .tp-empty {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin-top: var(--space-2);
    padding-left: var(--space-3);
    font-style: italic;
  }

  .timepoints-summary {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-align: right;
    padding-top: var(--space-1);
  }

  .empty-hint { text-align: center; color: var(--text-tertiary); font-size: var(--text-sm); padding: var(--space-6) 0; }
  .empty-hint p { margin: 0 0 var(--space-3) 0; }

  /* ── Cohort sections ── */
  .cohort-section {
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    background: var(--surface-raised);
  }
  .cohort-section.cohort-disease { border-left: 3px solid #0066CC; }
  .cohort-section.cohort-control { border-left: 3px solid #7F8C8D; }

  .cohort-header { display: flex; align-items: center; gap: var(--space-3); }

  .cohort-indicator { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .cohort-indicator-disease { background: #0066CC; }
  .cohort-indicator-control { background: #7F8C8D; }

  .cohort-name-input {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    background: transparent;
    min-width: 0;
  }
  .cohort-name-input:focus { outline: none; border-color: var(--color-primary); }

  .cohort-type-badge {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--border-radius-full);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }
  .cohort-type-disease { background: #E3F2FD; color: #1565C0; }
  .cohort-type-control { background: #F5F5F5; color: #616161; }

  /* ── Input-format pills (top of step 1) ── */
  .input-format-section {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .input-format-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .input-format-pills {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }
  .input-format-pill {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-default);
    background: var(--surface-base);
    color: var(--text-primary);
    font-family: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .input-format-pill:hover { border-color: var(--color-primary); }
  .input-format-pill.active { background: var(--color-primary-light); border-color: var(--color-primary); }
  .input-format-pill strong { font-weight: var(--font-semibold); }
  .input-format-hint {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    font-weight: normal;
    line-height: var(--leading-snug);
  }

  /* ── AIRR mode UI ── */
  .airr-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .file-picker-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .file-picker-display {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: var(--gray-50);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--text-secondary);
    min-width: 0;
  }
  .airr-error {
    color: var(--color-error);
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
    background: rgba(239,68,68,0.05);
    border-radius: var(--radius-sm);
    border-left: 3px solid var(--color-error);
  }
  .airr-table-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .airr-table-header { display: flex; flex-direction: column; gap: var(--space-1); }
  .airr-table-hint { font-size: var(--text-xs); color: var(--text-tertiary); }
  .airr-table {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-light);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .airr-row {
    display: grid;
    grid-template-columns: 140px 1fr 1fr 1fr;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-light);
    align-items: center;
  }
  .airr-row:last-child { border-bottom: none; }
  .airr-row-header {
    background: var(--gray-50);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .airr-tag-name {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
  }
  .airr-cell-input {
    padding: 4px var(--space-2);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    background: var(--surface-raised);
    color: var(--text-primary);
    min-width: 0;
  }
  .airr-cell-input:focus { outline: none; border-color: var(--color-primary); }

  .airr-preview {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--gray-50);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }
  .airr-preview strong { margin-right: var(--space-1); }
  .airr-preview-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid;
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .airr-preview-count { opacity: 0.7; font-weight: normal; }

  /* ── Add-cohort row (multi-cohort mode) ── */
  .add-cohort-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
  }
  .add-cohort-hint {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    line-height: var(--leading-snug);
  }

  /* ── Control toggle ── */
  .control-toggle-section {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    padding: var(--space-4) var(--space-5);
  }

  /* ── Options ── */
  .options-section {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    padding: var(--space-5);
  }
  .options-title { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--text-primary); margin: 0 0 var(--space-4) 0; }

  .checkbox-option { display: flex; gap: var(--space-3); cursor: pointer; }
  .checkbox-option input[type="checkbox"] {
    appearance: none;
    width: 20px; height: 20px;
    border: 2px solid var(--border-default);
    border-radius: var(--border-radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
    position: relative;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .checkbox-option input[type="checkbox"]:checked { background: var(--color-primary); border-color: var(--color-primary); }
  .checkbox-option input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    left: 6px; top: 2px;
    width: 4px; height: 9px;
    border: solid white;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  .checkbox-content { display: flex; flex-direction: column; gap: var(--space-1); }
  .checkbox-label { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--text-primary); }
  .checkbox-description { font-size: var(--text-xs); color: var(--text-tertiary); line-height: var(--leading-relaxed); }

  /* Footer */
  .step-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: var(--space-8);
    padding-top: var(--space-6);
    border-top: 1px solid var(--border-light);
  }
  .footer-spacer { flex: 1; }
  .btn svg { margin-left: var(--space-2); }
</style>
