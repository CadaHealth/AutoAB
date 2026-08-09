<script lang="ts">
  import { resultsState, filteredFileGroups, sequenceSearchQuery, toggleFileGroup, toggleCloneGroup, selectSequence, type FileGroup, type TimepointMapping, type CohortResults } from '../../lib/stores/app';
  
  // Function to clean the sequence name for display (remove file ID suffix)
  function cleanSequenceName(name: string): string {
    if (name.includes('|||')) {
      return name.split('|||')[0];
    }
    const match = name.match(/^(.+)_(\d{4,})$/);
    if (match && parseInt(match[2]) >= 1001) {
      return match[1];
    }
    if (name.includes('_') && (name.endsWith('.fasta') || name.endsWith('.fa'))) {
      const parts = name.split('_');
      if (parts[parts.length - 1].includes('.fasta') || parts[parts.length - 1].includes('.fa')) {
        return parts.slice(0, -1).join('_');
      }
    }
    return name;
  }

  interface TimepointGroup {
    label: string;
    expanded: boolean;
    fileGroups: FileGroup[];
    totalSeqs: number;
  }

  // Build timepoint groups from filtered file groups + mapping
  function buildTimepointGroups(fileGroups: FileGroup[], tpMapping: TimepointMapping): TimepointGroup[] {
    if (!tpMapping || Object.keys(tpMapping).length === 0) {
      console.log('[SequenceBrowser] buildTimepointGroups: empty mapping, returning []');
      return [];
    }

    console.log('[SequenceBrowser] buildTimepointGroups called with', fileGroups.length, 'file groups and', Object.keys(tpMapping).length, 'mapping entries');

    const tpMap = new Map<string, FileGroup[]>();
    const unmapped: FileGroup[] = [];

    for (const fg of fileGroups) {
      // Try to find the timepoint for this file
      const entry = tpMapping[fg.filename];
      if (entry) {
        const label = entry.timepoint;
        if (!tpMap.has(label)) tpMap.set(label, []);
        tpMap.get(label)!.push(fg);
      } else {
        console.log('[SequenceBrowser] File not in mapping:', fg.filename);
        unmapped.push(fg);
      }
    }

    console.log('[SequenceBrowser] Mapped to timepoints:', Array.from(tpMap.keys()));
    console.log('[SequenceBrowser] Unmapped files:', unmapped.length);

    const groups: TimepointGroup[] = [];
    // Preserve timepoint order from mapping (insertion order)
    const seenLabels = new Set<string>();
    for (const entry of Object.values(tpMapping)) {
      if (!seenLabels.has(entry.timepoint)) {
        seenLabels.add(entry.timepoint);
        const fgs = tpMap.get(entry.timepoint) || [];
        if (fgs.length > 0) {
          groups.push({
            label: entry.timepoint,
            expanded: true,
            fileGroups: fgs,
            totalSeqs: fgs.reduce((sum, fg) => sum + fg.sequences.length, 0)
          });
        }
      }
    }

    if (unmapped.length > 0) {
      groups.push({
        label: 'Unassigned',
        expanded: true,
        fileGroups: unmapped,
        totalSeqs: unmapped.reduce((sum, fg) => sum + fg.sequences.length, 0)
      });
    }

    console.log('[SequenceBrowser] Built', groups.length, 'timepoint groups');
    return groups;
  }

  // Toggle timepoint expansion
  let timepointExpanded: Record<string, boolean> = {};
  
  function toggleTimepoint(label: string) {
    const currentState = timepointExpanded[label] !== false; // default to true if undefined
    console.log('[SequenceBrowser] toggleTimepoint:', label, 'from', currentState, 'to', !currentState);
    timepointExpanded = { ...timepointExpanded, [label]: !currentState };
  }

  $: hasTimepointMapping = Object.keys($resultsState.timepointMapping).length > 0;
  $: {
    console.log('[SequenceBrowser] timepointMapping keys:', Object.keys($resultsState.timepointMapping).length);
    console.log('[SequenceBrowser] hasTimepointMapping:', hasTimepointMapping);
    console.log('[SequenceBrowser] filteredFileGroups count:', $filteredFileGroups.length);
    if (hasTimepointMapping && $filteredFileGroups.length > 0) {
      console.log('[SequenceBrowser] Sample file group:', $filteredFileGroups[0]?.filename);
      console.log('[SequenceBrowser] Sample mapping entry:', Object.entries($resultsState.timepointMapping)[0]);
    }
  }
  $: timepointGroups = hasTimepointMapping ? buildTimepointGroups($filteredFileGroups, $resultsState.timepointMapping) : [];
  $: {
    console.log('[SequenceBrowser] timepointExpanded state:', timepointExpanded);
  }

  // Initialize timepoint expansion states (all expanded by default)
  $: if (timepointGroups.length > 0) {
    let needsUpdate = false;
    const newState = { ...timepointExpanded };
    for (const tg of timepointGroups) {
      if (newState[tg.label] === undefined) {
        newState[tg.label] = true;
        needsUpdate = true;
      }
    }
    if (needsUpdate) {
      timepointExpanded = newState;
    }
  }

  // Removed isTpExpanded function - use timepointExpanded[label] directly in template for reactivity

  // ── Cohort grouping ──
  $: hasCohorts = $resultsState.cohortResults.length > 0;
  let cohortExpanded: Record<string, boolean> = {};
  function toggleCohort(type: string) {
    const current = cohortExpanded[type] !== false;
    cohortExpanded = { ...cohortExpanded, [type]: !current };
  }
  $: if (hasCohorts) {
    let needsInit = false;
    const newState = { ...cohortExpanded };
    for (const cr of $resultsState.cohortResults) {
      if (newState[cr.cohortType] === undefined) { newState[cr.cohortType] = true; needsInit = true; }
    }
    if (needsInit) cohortExpanded = newState;
  }

  function buildCohortTimepointGroups(cohort: CohortResults): TimepointGroup[] {
    return buildTimepointGroups(cohort.fileGroups, cohort.timepointMapping);
  }
</script>

<div class="sequence-browser">
  <!-- Search header -->
  <div class="search-header">
    <div class="search-input-wrapper">
      <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <input
        type="text"
        class="search-input"
        placeholder="Search sequences..."
        bind:value={$sequenceSearchQuery}
      />
      {#if $sequenceSearchQuery}
        <button 
          class="clear-btn"
          on:click={() => $sequenceSearchQuery = ''}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      {/if}
    </div>
  </div>
  
  <!-- Groups list: [Cohort >] Timepoint > File > Clone > Sequence -->
  <div class="groups-list">
    {#if hasCohorts}
      {#each $resultsState.cohortResults as cohort (cohort.cohortType)}
        {@const cohortTpGroups = buildCohortTimepointGroups(cohort)}
        <div class="cohort-group">
          <button class="group-header cohort-header cohort-{cohort.cohortType}" on:click={() => toggleCohort(cohort.cohortType)}>
            <svg class="expand-icon" class:expanded={cohortExpanded[cohort.cohortType] !== false} width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="cohort-dot cohort-dot-{cohort.cohortType}"></span>
            <span class="group-name">{cohort.cohortName}</span>
            <span class="cohort-type-tag cohort-tag-{cohort.cohortType}">{cohort.cohortType}</span>
            <span class="group-count">{cohort.sequences.length}</span>
          </button>
          {#if cohortExpanded[cohort.cohortType] !== false}
            <div class="cohort-children">
              {#each cohortTpGroups as tpGroup (tpGroup.label)}
                <div class="timepoint-group">
                  <button class="group-header tp-header" on:click={() => toggleTimepoint(cohort.cohortType + ':' + tpGroup.label)}>
                    <svg class="expand-icon" class:expanded={timepointExpanded[cohort.cohortType + ':' + tpGroup.label] !== false} width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <svg class="tp-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/>
                      <path d="M7 4v3l2 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                    </svg>
                    <span class="group-name">{tpGroup.label}</span>
                    <span class="group-count">{tpGroup.totalSeqs}</span>
                  </button>
                  {#if timepointExpanded[cohort.cohortType + ':' + tpGroup.label] !== false}
                    <div class="tp-children">
                      {#each tpGroup.fileGroups as group}
                        <div class="file-group">
                          <button class="group-header file-header" on:click={() => toggleFileGroup(group.filename)}>
                            <svg class="expand-icon" class:expanded={group.expanded} width="14" height="14" viewBox="0 0 14 14" fill="none">
                              <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            <span class="group-name">{group.filename}</span>
                            <span class="group-count">{group.sequences.length}</span>
                          </button>
                          {#if group.expanded}
                            <div class="clones-container">
                              {#each group.cloneGroups as cloneGroup}
                                <div class="clone-group">
                                  <button class="group-header clone-header" on:click={() => toggleCloneGroup(group.filename, cloneGroup.cloneId)}>
                                    <svg class="expand-icon" class:expanded={cloneGroup.expanded} width="14" height="14" viewBox="0 0 14 14" fill="none">
                                      <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                    {#if cloneGroup.cloneId === -1}<span class="group-name">Singletons</span>
                                    {:else if cloneGroup.cloneId === null}<span class="group-name">No Clone</span>
                                    {:else}<span class="group-name">Clone {cloneGroup.cloneId}</span>{/if}
                                    <span class="group-count">{cloneGroup.size}</span>
                                  </button>
                                  {#if cloneGroup.expanded}
                                    <div class="sequence-list nested">
                                      {#each cloneGroup.sequences as seq}
                                        <button class="sequence-item" class:selected={$resultsState.selectedSequenceId === seq.id} on:click={() => selectSequence(seq.id)}>
                                          <div class="seq-main">
                                            <span class="seq-name">{cleanSequenceName(seq.name)}</span>
                                            <div class="badges">{#if seq.productive === false}<span class="nonproductive-badge">Non-productive</span>{/if}</div>
                                          </div>
                                        </button>
                                      {/each}
                                    </div>
                                  {/if}
                                </div>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {:else if hasTimepointMapping}
      {#each timepointGroups as tpGroup (tpGroup.label)}
        <div class="timepoint-group">
          <button
            class="group-header tp-header"
            on:click={() => toggleTimepoint(tpGroup.label)}
          >
            <svg 
              class="expand-icon"
              class:expanded={timepointExpanded[tpGroup.label] !== false}
              width="14" height="14" viewBox="0 0 14 14" fill="none"
            >
              <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <svg class="tp-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/>
              <path d="M7 4v3l2 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            <span class="group-name">{tpGroup.label}</span>
            <span class="group-count">{tpGroup.totalSeqs}</span>
          </button>

          {#if timepointExpanded[tpGroup.label] !== false}
            <div class="tp-children">
              {#each tpGroup.fileGroups as group}
                <div class="file-group">
                  <button 
                    class="group-header file-header"
                    on:click={() => toggleFileGroup(group.filename)}
                  >
                    <svg 
                      class="expand-icon"
                      class:expanded={group.expanded}
                      width="14" height="14" viewBox="0 0 14 14" fill="none"
                    >
                      <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="group-name">{group.filename}</span>
                    <span class="group-count">{group.sequences.length}</span>
                  </button>
                  
                  {#if group.expanded}
                    <div class="clones-container">
                      {#each group.cloneGroups as cloneGroup}
                        <div class="clone-group">
                          <button 
                            class="group-header clone-header"
                            on:click={() => toggleCloneGroup(group.filename, cloneGroup.cloneId)}
                          >
                            <svg 
                              class="expand-icon"
                              class:expanded={cloneGroup.expanded}
                              width="14" height="14" viewBox="0 0 14 14" fill="none"
                            >
                              <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            {#if cloneGroup.cloneId === -1}
                              <span class="group-name">Singletons</span>
                            {:else if cloneGroup.cloneId === null}
                              <span class="group-name">No Clone</span>
                            {:else}
                              <span class="group-name">Clone {cloneGroup.cloneId}</span>
                            {/if}
                            <span class="group-count">{cloneGroup.size}</span>
                          </button>
                          
                          {#if cloneGroup.expanded}
                            <div class="sequence-list nested">
                              {#each cloneGroup.sequences as seq}
                                <button 
                                  class="sequence-item"
                                  class:selected={$resultsState.selectedSequenceId === seq.id}
                                  on:click={() => selectSequence(seq.id)}
                                >
                                  <div class="seq-main">
                                    <span class="seq-name">{cleanSequenceName(seq.name)}</span>
                                    <div class="badges">
                                      {#if seq.productive === false}
                                        <span class="nonproductive-badge">Non-productive</span>
                                      {/if}
                                    </div>
                                  </div>
                                </button>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="empty-state">
          {#if $sequenceSearchQuery}
            <p>No sequences match your search</p>
          {:else}
            <p>No sequences available</p>
          {/if}
        </div>
      {/each}
    {:else}
      <!-- Fallback: flat File > Clone > Sequence (old sessions without timepoint mapping) -->
      {#each $filteredFileGroups as group}
        <div class="file-group">
          <button 
            class="group-header"
            on:click={() => toggleFileGroup(group.filename)}
          >
            <svg 
              class="expand-icon"
              class:expanded={group.expanded}
              width="14" height="14" viewBox="0 0 14 14" fill="none"
            >
              <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="group-name">{group.filename}</span>
            <span class="group-count">{group.sequences.length}</span>
          </button>
          
          {#if group.expanded}
            <div class="clones-container">
              {#each group.cloneGroups as cloneGroup}
                <div class="clone-group">
                  <button 
                    class="group-header clone-header"
                    on:click={() => toggleCloneGroup(group.filename, cloneGroup.cloneId)}
                  >
                    <svg 
                      class="expand-icon"
                      class:expanded={cloneGroup.expanded}
                      width="14" height="14" viewBox="0 0 14 14" fill="none"
                    >
                      <path d="M5 4l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    {#if cloneGroup.cloneId === -1}
                      <span class="group-name">Singletons</span>
                    {:else if cloneGroup.cloneId === null}
                      <span class="group-name">No Clone</span>
                    {:else}
                      <span class="group-name">Clone {cloneGroup.cloneId}</span>
                    {/if}
                    <span class="group-count">{cloneGroup.size}</span>
                  </button>
                  
                  {#if cloneGroup.expanded}
                    <div class="sequence-list nested">
                      {#each cloneGroup.sequences as seq}
                        <button 
                          class="sequence-item"
                          class:selected={$resultsState.selectedSequenceId === seq.id}
                          on:click={() => selectSequence(seq.id)}
                        >
                          <div class="seq-main">
                            <span class="seq-name">{cleanSequenceName(seq.name)}</span>
                            <div class="badges">
                              {#if seq.productive === false}
                                <span class="nonproductive-badge">Non-productive</span>
                              {/if}
                            </div>
                          </div>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="empty-state">
          {#if $sequenceSearchQuery}
            <p>No sequences match your search</p>
          {:else}
            <p>No sequences available</p>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .sequence-browser {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  
  .search-header {
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-light);
    flex-shrink: 0;
  }
  
  .search-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }
  
  .search-icon {
    position: absolute;
    left: var(--space-3);
    color: var(--text-muted);
    pointer-events: none;
  }
  
  .search-input {
    width: 100%;
    padding: var(--space-2) var(--space-4);
    padding-left: calc(var(--space-3) + 16px + var(--space-2));
    padding-right: var(--space-8);
    font-size: var(--text-sm);
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    transition: all var(--transition-fast);
  }
  
  .search-input:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px var(--color-primary-light);
  }
  
  .search-input::placeholder {
    color: var(--text-muted);
  }
  
  .clear-btn {
    position: absolute;
    right: var(--space-2);
    padding: var(--space-1);
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--border-radius-sm);
    transition: all var(--transition-fast);
  }
  
  .clear-btn:hover {
    background: var(--gray-100);
    color: var(--text-secondary);
  }
  
  .groups-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
  }
  
  .file-group {
    margin-bottom: var(--space-1);
  }
  
  .group-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: var(--gray-50);
    border: none;
    border-radius: var(--border-radius-md);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }
  
  .group-header:hover {
    background: var(--gray-100);
  }
  
  .expand-icon {
    color: var(--text-tertiary);
    transition: transform var(--transition-fast);
    flex-shrink: 0;
  }
  
  .expand-icon.expanded {
    transform: rotate(90deg);
  }
  
  .group-name {
    flex: 1;
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .group-count {
    padding: 2px 8px;
    background: var(--gray-200);
    border-radius: var(--border-radius-full);
    font-size: 10px;
    font-weight: var(--font-semibold);
    color: var(--text-secondary);
  }
  
  /* Timepoint header */
  .tp-header {
    background: var(--color-primary-light);
    font-weight: var(--font-semibold);
  }

  .tp-header:hover {
    background: var(--color-primary-muted, var(--gray-100));
  }

  .tp-icon {
    color: var(--color-primary);
    flex-shrink: 0;
  }

  .tp-children {
    padding-left: var(--space-3);
  }

  .timepoint-group {
    margin-bottom: var(--space-2);
  }

  /* File header inside timepoint */
  .file-header {
    background: var(--gray-50);
    padding: var(--space-2) var(--space-3);
  }

  .file-header:hover {
    background: var(--gray-100);
  }

  .clone-header {
    background: var(--gray-50);
    padding: var(--space-2) var(--space-3);
    padding-left: calc(var(--space-3) + var(--space-4));
  }
  
  .clone-header:hover {
    background: var(--gray-100);
  }
  
  .sequence-list {
    padding: var(--space-1) var(--space-2);
  }
  
  .sequence-list.nested {
    padding-left: var(--space-4);
  }
  
  .sequence-list.single {
    padding: 0;
  }
  
  .sequence-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: none;
    border-radius: var(--border-radius-md);
    cursor: pointer;
    text-align: left;
    transition: all var(--transition-fast);
    box-sizing: border-box;
  }
  
  .sequence-item:hover {
    background: var(--gray-50);
  }
  
  .sequence-item.selected {
    background: var(--color-primary-light);
  }
  
  .seq-main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    width: 100%;
  }
  
  .seq-name {
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: var(--font-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    min-width: 0;
  }
  
  .sequence-item.selected .seq-name {
    color: var(--color-primary);
  }
  
  .badges {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
  }
  
  .clone-badge {
    padding: 2px 6px;
    background: var(--color-info-light);
    color: var(--color-info);
    border-radius: var(--border-radius-sm);
    font-size: 10px;
    font-weight: var(--font-semibold);
    flex-shrink: 0;
  }
  
  .nonproductive-badge {
    padding: 2px 6px;
    background: var(--color-warning-light);
    color: var(--color-warning);
    border-radius: var(--border-radius-sm);
    font-size: 10px;
    font-weight: var(--font-semibold);
    flex-shrink: 0;
  }

  
  /* ── Cohort grouping ── */
  .cohort-group { margin-bottom: var(--space-3); }
  .cohort-header { font-weight: var(--font-semibold); }
  .cohort-header.cohort-disease { background: #E3F2FD; }
  .cohort-header.cohort-disease:hover { background: #BBDEFB; }
  .cohort-header.cohort-control { background: #F5F5F5; }
  .cohort-header.cohort-control:hover { background: #EEEEEE; }

  .cohort-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .cohort-dot-disease { background: #1565C0; }
  .cohort-dot-control { background: #757575; }

  .cohort-type-tag {
    font-size: 9px;
    font-weight: var(--font-semibold);
    padding: 1px 6px;
    border-radius: var(--border-radius-full);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .cohort-tag-disease { background: #BBDEFB; color: #1565C0; }
  .cohort-tag-control { background: #E0E0E0; color: #616161; }

  .cohort-children { padding-left: var(--space-3); }

  .empty-state {
    padding: var(--space-8);
    text-align: center;
  }
  
  .empty-state p {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    margin: 0;
  }
</style>

