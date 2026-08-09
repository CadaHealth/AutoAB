<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import {
    resultsState,
    wizardState,
    studyDesign,
    saveStudyDesignImmediate,
    loadStudyDesign,
    GROUP_COLORS,
    type StudyDesign,
    type StudyGroup
  } from '../../lib/stores/app';

  // ── Helpers ──────────────────────────────────────────────
  function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ── State ────────────────────────────────────────────────
  let design: StudyDesign = { groups: [], unassigned: [] };
  let dragFile: string | null = null;
  let dragOverTarget: string | null = null; // id of the drop-zone being hovered
  let editingGroupId: string | null = null;
  let editingTpId: string | null = null;
  let editValue = '';
  let loaded = false;
  let initializing = true; // true until first user-initiated change; prevents saving on mount

  // ── Build design from detected folder structure ────────
  function buildDesignFromStructure(
    structure: { groups: { name: string; timepoints: { label: string; files: string[] }[] }[]; is3Level: boolean; rootPath: string },
    availableFiles: string[]
  ): StudyDesign {
    const fileSet = new Set(availableFiles);
    const assignedFiles = new Set<string>();
    const groups: StudyGroup[] = [];

    for (let gi = 0; gi < structure.groups.length; gi++) {
      const dg = structure.groups[gi];
      const tps = dg.timepoints.map((dt: { label: string; files: string[] }, ti: number) => {
        // Match staged filenames (may have been prefixed to avoid collisions)
        const matched: string[] = dt.files.filter((f: string) => {
          // Try exact match first
          if (fileSet.has(f)) { assignedFiles.add(f); return true; }
          return false;
        });
        // Also collect prefixed versions (staging may have added group/tp prefix)
        const prefixedMatched: string[] = dt.files
          .map((f: string) => {
            const p3 = `${dg.name}_${dt.label}_${f}`;
            const p2 = `${dg.name}_${f}`;
            if (fileSet.has(p3) && !matched.includes(p3)) { assignedFiles.add(p3); return p3; }
            if (fileSet.has(p2) && !matched.includes(p2)) { assignedFiles.add(p2); return p2; }
            return null;
          })
          .filter((f: string | null): f is string => f !== null);
        const allMatched = [...matched, ...prefixedMatched];

        return {
          id: uid(),
          label: dt.label,
          order: ti,
          files: allMatched
        };
      });

      groups.push({
        id: uid(),
        name: dg.name,
        color: GROUP_COLORS[gi % GROUP_COLORS.length],
        timepoints: tps
      });
    }

    const unassigned = availableFiles.filter((f: string) => !assignedFiles.has(f));
    return { groups, unassigned };
  }

  // ── Initialisation ──────────────────────────────────────
  onMount(async () => {
    initializing = true;
    const allFiles = $resultsState.fileGroups.map(fg => fg.filename);

    // Try loading design from multiple sources, in priority order:
    // 1. Read from disk (most reliable - saved by sync/SessionSidebar/main process)
    // 2. In-memory store (set by study_design artifact or previous tab visit)
    // 3. Detected folder structure from wizard
    // 4. Default empty design
    let saved: StudyDesign | null = null;

    // Source 1: disk
    saved = await loadStudyDesign();
    if (saved && saved.groups && saved.groups.length > 0) {
      console.log('[DataOrganizer] Loaded design from disk:', saved.groups.length, 'groups');
    }

    // Source 2: in-memory store (e.g. set by study_design artifact while we were awaiting)
    if (!saved || !saved.groups?.length) {
      const inMemory = get(studyDesign);
      if (inMemory && inMemory.groups.length > 0) {
        saved = inMemory;
        console.log('[DataOrganizer] Using in-memory store design:', saved.groups.length, 'groups');
      }
    }

    if (saved && saved.groups && saved.groups.length > 0) {
      // Reconcile: add any new files to unassigned, remove files that no longer exist
      const assignedFiles = new Set<string>();
      for (const g of saved.groups) {
        for (const tp of g.timepoints) {
          tp.files.forEach(f => assignedFiles.add(f));
        }
      }
      saved.unassigned = saved.unassigned || [];
      for (const f of allFiles) {
        if (!assignedFiles.has(f) && !saved.unassigned.includes(f)) {
          saved.unassigned.push(f);
        }
      }
      if (allFiles.length > 0) {
        const fileSet = new Set(allFiles);
        saved.unassigned = saved.unassigned.filter(f => fileSet.has(f));
        for (const g of saved.groups) {
          for (const tp of g.timepoints) {
            tp.files = tp.files.filter(f => fileSet.has(f));
          }
        }
      }
      design = saved;
    } else {
      // Check if we have a detected folder structure from the wizard
      const detected = get(wizardState).detectedStructure;
      if (detected && detected.groups.length > 0) {
        design = buildDesignFromStructure(detected, allFiles);
      } else {
        design = { groups: [], unassigned: [...allFiles] };
      }
    }
    loaded = true;
    // Update the in-memory store but do NOT save to disk, we just loaded from disk,
    // saving back would be redundant at best and destructive if load failed
    studyDesign.set(design);
    initializing = false;
  });

  // Watch for external store changes (e.g. study_design artifact arriving after mount)
  let prevStoreJson = '';
  $: {
    const storeVal = $studyDesign;
    if (!initializing && loaded && storeVal.groups.length > 0) {
      const storeJson = JSON.stringify(storeVal);
      if (storeJson !== prevStoreJson && storeJson !== JSON.stringify(design)) {
        // External update (artifact or session cache), adopt it
        console.log('[DataOrganizer] Adopting external store update:', storeVal.groups.length, 'groups');
        design = { groups: [...storeVal.groups], unassigned: [...(storeVal.unassigned || [])] };
        prevStoreJson = storeJson;
      }
    }
  }

  // ── Cleanup: flush pending save on destroy ──────────────
  onDestroy(() => {
    // Only save if we have a non-empty design and a valid output directory
    const outputDir = get(resultsState).outputDir;
    if (outputDir && design.groups.length > 0) {
      saveStudyDesignImmediate(design);
    }
  });

  // ── Persist ──────────────────────────────────────────────
  function sync() {
    studyDesign.set(design);
    if (!initializing) {
      saveStudyDesignImmediate(design);
    }
  }

  function refresh() {
    design = design; // trigger Svelte reactivity
    sync();
  }

  // ── Group operations ─────────────────────────────────────
  function addGroup() {
    const idx = design.groups.length;
    const group: StudyGroup = {
      id: uid(),
      name: `Group ${idx + 1}`,
      color: GROUP_COLORS[idx % GROUP_COLORS.length],
      timepoints: [{
        id: uid(),
        label: 'Timepoint 1',
        order: 0,
        files: []
      }]
    };
    design.groups = [...design.groups, group];
    refresh();
  }

  function removeGroup(groupId: string) {
    const group = design.groups.find(g => g.id === groupId);
    if (!group) return;
    if (!confirm(`Delete group "${group.name}" and return all its files to Unassigned?`)) return;
    // Return files to unassigned
    for (const tp of group.timepoints) {
      design.unassigned = [...design.unassigned, ...tp.files];
    }
    design.groups = design.groups.filter(g => g.id !== groupId);
    refresh();
  }

  function cycleColor(groupId: string) {
    const group = design.groups.find(g => g.id === groupId);
    if (!group) return;
    const currentIdx = GROUP_COLORS.indexOf(group.color);
    group.color = GROUP_COLORS[(currentIdx + 1) % GROUP_COLORS.length];
    refresh();
  }

  // ── Timepoint operations ─────────────────────────────────
  function addTimepoint(groupId: string) {
    const group = design.groups.find(g => g.id === groupId);
    if (!group) return;
    const idx = group.timepoints.length;
    group.timepoints = [...group.timepoints, {
      id: uid(),
      label: `Timepoint ${idx + 1}`,
      order: idx,
      files: []
    }];
    refresh();
  }

  function removeTimepoint(groupId: string, tpId: string) {
    const group = design.groups.find(g => g.id === groupId);
    if (!group) return;
    const tp = group.timepoints.find(t => t.id === tpId);
    if (!tp) return;
    design.unassigned = [...design.unassigned, ...tp.files];
    group.timepoints = group.timepoints.filter(t => t.id !== tpId);
    // Re-order
    group.timepoints.forEach((t, i) => t.order = i);
    refresh();
  }

  // ── Inline editing ──────────────────────────────────────
  function startEditGroup(groupId: string) {
    const group = design.groups.find(g => g.id === groupId);
    if (!group) return;
    editingGroupId = groupId;
    editingTpId = null;
    editValue = group.name;
  }

  function startEditTimepoint(tpId: string, label: string) {
    editingTpId = tpId;
    editingGroupId = null;
    editValue = label;
  }

  function commitEdit() {
    if (editingGroupId) {
      const group = design.groups.find(g => g.id === editingGroupId);
      if (group && editValue.trim()) group.name = editValue.trim();
    }
    if (editingTpId) {
      for (const g of design.groups) {
        const tp = g.timepoints.find(t => t.id === editingTpId);
        if (tp && editValue.trim()) { tp.label = editValue.trim(); break; }
      }
    }
    editingGroupId = null;
    editingTpId = null;
    editValue = '';
    refresh();
  }

  function cancelEdit() {
    editingGroupId = null;
    editingTpId = null;
    editValue = '';
  }

  function handleEditKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  }

  // ── File removal from slot ──────────────────────────────
  function removeFile(file: string, groupId: string, tpId: string) {
    const group = design.groups.find(g => g.id === groupId);
    if (!group) return;
    const tp = group.timepoints.find(t => t.id === tpId);
    if (!tp) return;
    tp.files = tp.files.filter(f => f !== file);
    design.unassigned = [...design.unassigned, file];
    refresh();
  }

  // ── Drag and drop ───────────────────────────────────────
  function onDragStart(e: DragEvent, file: string) {
    dragFile = file;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', file);
    }
  }

  function onDragOver(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverTarget = targetId;
  }

  function onDragLeave() {
    dragOverTarget = null;
  }

  function onDropUnassigned(e: DragEvent) {
    e.preventDefault();
    dragOverTarget = null;
    const file = dragFile || (e.dataTransfer?.getData('text/plain') ?? null);
    if (!file) return;

    // Remove from current location
    removeFromAllSlots(file);
    // Add to unassigned if not already there
    if (!design.unassigned.includes(file)) {
      design.unassigned = [...design.unassigned, file];
    }
    dragFile = null;
    refresh();
  }

  function onDropTimepoint(e: DragEvent, groupId: string, tpId: string) {
    e.preventDefault();
    dragOverTarget = null;
    const file = dragFile || (e.dataTransfer?.getData('text/plain') ?? null);
    if (!file) return;

    // Remove from current location
    removeFromAllSlots(file);
    // Add to target timepoint
    const group = design.groups.find(g => g.id === groupId);
    const tp = group?.timepoints.find(t => t.id === tpId);
    if (tp && !tp.files.includes(file)) {
      tp.files = [...tp.files, file];
    }
    dragFile = null;
    refresh();
  }

  function onDragEnd() {
    dragFile = null;
    dragOverTarget = null;
  }

  function removeFromAllSlots(file: string) {
    design.unassigned = design.unassigned.filter(f => f !== file);
    for (const g of design.groups) {
      for (const tp of g.timepoints) {
        tp.files = tp.files.filter(f => f !== file);
      }
    }
  }

  // ── Reset ───────────────────────────────────────────────
  function resetDesign() {
    if (!confirm('Reset study design? All group assignments will be lost.')) return;
    const allFiles = $resultsState.fileGroups.map(fg => fg.filename);
    design = { groups: [], unassigned: [...allFiles] };
    refresh();
  }

  // ── Stats ───────────────────────────────────────────────
  $: totalFiles = $resultsState.fileGroups.length;
  $: assignedCount = design.groups.reduce(
    (acc, g) => acc + g.timepoints.reduce((a, tp) => a + tp.files.length, 0), 0
  );
</script>

{#if !loaded}
  <div class="loading">Loading study design...</div>
{:else}
  <div class="organizer">
    <!-- Header -->
    <div class="org-header">
      <div class="org-title-area">
        <h2 class="org-title">Study Design</h2>
        <span class="org-subtitle">
          {assignedCount} of {totalFiles} files assigned
        </span>
      </div>
      <div class="org-actions">
        <button class="btn-outline" on:click={resetDesign} title="Reset all assignments">
          Reset
        </button>
      </div>
    </div>

    <!-- Unassigned files -->
    <div
      class="unassigned-zone"
      class:drag-over={dragOverTarget === 'unassigned'}
      on:dragover={(e) => onDragOver(e, 'unassigned')}
      on:dragleave={onDragLeave}
      on:drop={onDropUnassigned}
      role="region"
      aria-label="Unassigned files"
    >
      <div class="zone-label">Unassigned Files</div>
      <div class="chip-container">
        {#if design.unassigned.length === 0}
          <span class="empty-hint">All files assigned, drag files here to unassign</span>
        {/if}
        {#each design.unassigned as file (file)}
          <span
            class="file-chip"
            draggable="true"
            on:dragstart={(e) => onDragStart(e, file)}
            on:dragend={onDragEnd}
            title={file}
          >
            {file}
          </span>
        {/each}
      </div>
    </div>

    <!-- Add Group button -->
    <button class="add-group-btn" on:click={addGroup}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      Add Group
    </button>

    <!-- Groups -->
    <div class="groups-list">
      {#each design.groups as group (group.id)}
        <div class="group-card" style="--group-color: {group.color}">
          <div class="group-header">
            <button
              class="color-dot"
              style="background: {group.color}"
              on:click={() => cycleColor(group.id)}
              title="Click to change color"
            ></button>

            {#if editingGroupId === group.id}
              <input
                class="inline-edit"
                bind:value={editValue}
                on:keydown={handleEditKeydown}
                on:blur={commitEdit}
                autofocus
              />
            {:else}
              <span class="group-name" on:dblclick={() => startEditGroup(group.id)} title="Double-click to rename">
                {group.name}
              </span>
            {/if}

            <button class="icon-btn delete-btn" on:click={() => removeGroup(group.id)} title="Delete group">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          </div>

          <div class="timepoints-row">
            {#each group.timepoints as tp (tp.id)}
              <div
                class="timepoint-col"
                class:drag-over={dragOverTarget === tp.id}
                on:dragover={(e) => onDragOver(e, tp.id)}
                on:dragleave={onDragLeave}
                on:drop={(e) => onDropTimepoint(e, group.id, tp.id)}
                role="region"
                aria-label={tp.label}
              >
                <div class="tp-header">
                  {#if editingTpId === tp.id}
                    <input
                      class="inline-edit tp-edit"
                      bind:value={editValue}
                      on:keydown={handleEditKeydown}
                      on:blur={commitEdit}
                      autofocus
                    />
                  {:else}
                    <span class="tp-label" on:dblclick={() => startEditTimepoint(tp.id, tp.label)} title="Double-click to rename">
                      {tp.label}
                    </span>
                  {/if}
                  {#if group.timepoints.length > 1}
                    <button class="icon-btn tp-delete" on:click={() => removeTimepoint(group.id, tp.id)} title="Remove timepoint">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                    </button>
                  {/if}
                </div>
                <div class="tp-dropzone">
                  {#if tp.files.length === 0}
                    <span class="drop-hint">Drop files here</span>
                  {/if}
                  {#each tp.files as file (file)}
                    <span
                      class="file-chip small"
                      draggable="true"
                      on:dragstart={(e) => onDragStart(e, file)}
                      on:dragend={onDragEnd}
                      title={file}
                    >
                      <span class="chip-text">{file}</span>
                      <button class="chip-remove" on:click={() => removeFile(file, group.id, tp.id)} title="Remove">
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                      </button>
                    </span>
                  {/each}
                </div>
              </div>
            {/each}

            <button class="add-tp-btn" on:click={() => addTimepoint(group.id)} title="Add timepoint">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
              <span>Timepoint</span>
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .organizer {
    padding: var(--space-6);
    overflow-y: auto;
    height: 100%;
  }

  /* ── Header ─────────────────────── */
  .org-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-5);
  }
  .org-title-area {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }
  .org-title {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  .org-subtitle {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  .org-actions {
    display: flex;
    gap: var(--space-2);
  }

  /* ── Buttons ────────────────────── */
  .btn-outline {
    padding: var(--space-2) var(--space-4);
    background: transparent;
    border: 1px solid var(--border-default);
    border-radius: var(--border-radius-sm);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .btn-outline:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .add-group-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--color-primary-light);
    color: var(--color-primary);
    border: 1px dashed var(--color-primary-muted);
    border-radius: var(--border-radius-md);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .add-group-btn:hover {
    background: var(--color-primary-muted);
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--border-radius-sm);
    transition: all var(--transition-fast);
  }
  .icon-btn:hover {
    background: var(--gray-100);
    color: var(--text-secondary);
  }
  .delete-btn:hover {
    color: var(--color-error);
    background: var(--color-error-light);
  }

  /* ── Unassigned zone ────────────── */
  .unassigned-zone {
    background: var(--gray-50);
    border: 2px dashed var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
    transition: all var(--transition-fast);
    min-height: 60px;
  }
  .unassigned-zone.drag-over {
    border-color: var(--color-primary);
    background: var(--color-primary-light);
  }
  .zone-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    color: var(--text-tertiary);
    margin-bottom: var(--space-2);
  }
  .chip-container {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .empty-hint,
  .drop-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-style: italic;
  }

  /* ── File chips ─────────────────── */
  .file-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 4px 10px;
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-full);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    cursor: grab;
    user-select: none;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: all var(--transition-fast);
  }
  .file-chip:hover {
    border-color: var(--color-primary-muted);
    box-shadow: var(--shadow-xs);
  }
  .file-chip:active {
    cursor: grabbing;
  }
  .file-chip.small {
    font-size: 11px;
    padding: 3px 8px;
  }
  .chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 50%;
    flex-shrink: 0;
    padding: 0;
  }
  .chip-remove:hover {
    color: var(--color-error);
    background: var(--color-error-light);
  }

  /* ── Groups ─────────────────────── */
  .groups-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .group-card {
    border: 1px solid var(--border-light);
    border-left: 4px solid var(--group-color, var(--color-primary));
    border-radius: var(--border-radius-md);
    background: var(--surface-raised);
    overflow: hidden;
  }
  .group-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-light);
    background: var(--gray-50);
  }
  .color-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.8);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.1);
    cursor: pointer;
    flex-shrink: 0;
    padding: 0;
  }
  .group-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    cursor: text;
    flex: 1;
  }
  .inline-edit {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    border: 1px solid var(--border-focus);
    border-radius: var(--border-radius-sm);
    padding: 2px 6px;
    outline: none;
    flex: 1;
    min-width: 80px;
    background: var(--surface-raised);
  }
  .tp-edit {
    font-weight: var(--font-medium);
    font-size: var(--text-xs);
  }

  /* ── Timepoints ─────────────────── */
  .timepoints-row {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    overflow-x: auto;
    align-items: flex-start;
  }
  .timepoint-col {
    min-width: 160px;
    max-width: 200px;
    flex-shrink: 0;
  }
  .timepoint-col.drag-over .tp-dropzone {
    border-color: var(--color-primary);
    background: var(--color-primary-light);
  }
  .tp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }
  .tp-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--text-secondary);
    cursor: text;
  }
  .tp-delete {
    width: 18px;
    height: 18px;
  }
  .tp-dropzone {
    min-height: 80px;
    border: 2px dashed var(--border-light);
    border-radius: var(--border-radius-sm);
    padding: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    transition: all var(--transition-fast);
    background: var(--gray-50);
  }
  .add-tp-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    min-width: 80px;
    min-height: 80px;
    border: 2px dashed var(--border-light);
    border-radius: var(--border-radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    transition: all var(--transition-fast);
    margin-top: 22px; /* align with drop zones below tp headers */
  }
  .add-tp-btn:hover {
    border-color: var(--color-primary-muted);
    color: var(--color-primary);
    background: var(--color-primary-light);
  }
</style>
