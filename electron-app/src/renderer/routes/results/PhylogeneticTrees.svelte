<script lang="ts">
  import { onMount } from 'svelte';
  import { resultsState, type CohortResults } from '../../lib/stores/app';
  import type { TreeMetadata } from '../../lib/stores/app';
  import InteractiveTree from './InteractiveTree.svelte';
  import { treeMetadataToCsv, downloadCsv } from '../../lib/utils/export-csv';
  import { zipSync, strToU8 } from 'fflate';
  
  let selectedTreeIndex = 0;
  let selectedCohortType: string | null = null;
  let isLoading = false;
  
  interface TimepointTreeGroup {
    label: string;
    trees: { index: number; metadata: TreeMetadata; path: string }[];
  }
  
  // Group trees by timepoint
  $: hasTimepoints = $resultsState.treeMetadata.some(m => m.timepoint);
  
  $: timepointGroups = buildTimepointGroups($resultsState.treeMetadata, $resultsState.treeImages);
  
  let tpExpanded: Record<string, boolean> = {};
  let cohortExpanded: Record<string, boolean> = {};
  
  $: hasCohorts = $resultsState.cohortResults.length > 0;
  
  $: if (hasCohorts) {
    for (const cr of $resultsState.cohortResults) {
      if (!(cr.cohortType in cohortExpanded)) cohortExpanded[cr.cohortType] = true;
    }
  }

  function toggleCohortExpand(type: string) {
    cohortExpanded[type] = !cohortExpanded[type];
    cohortExpanded = { ...cohortExpanded };
  }

  function buildTimepointGroups(metadata: TreeMetadata[], images: string[]): TimepointTreeGroup[] {
    if (!metadata.length || !metadata.some(m => m.timepoint)) return [];
    
    const groups: Record<string, TimepointTreeGroup> = {};
    for (let i = 0; i < metadata.length; i++) {
      const m = metadata[i];
      const tp = m.timepoint || 'Other';
      if (!groups[tp]) {
        groups[tp] = { label: tp, trees: [] };
        if (!(tp in tpExpanded)) {
          tpExpanded[tp] = true;
        }
      }
      groups[tp].trees.push({ index: i, metadata: m, path: images[i] || m.path });
    }
    
    return Object.values(groups).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }
  
  function buildCohortTimepointGroups(cohort: CohortResults): TimepointTreeGroup[] {
    return buildTimepointGroups(cohort.treeMetadata, cohort.treeImages);
  }
  
  function toggleTpGroup(label: string) {
    tpExpanded[label] = !tpExpanded[label];
    tpExpanded = { ...tpExpanded };
  }

  function selectCohortTree(cohortType: string, index: number) {
    selectedCohortType = cohortType;
    selectedTreeIndex = index;
  }

  function selectDefaultTree(index: number) {
    selectedCohortType = null;
    selectedTreeIndex = index;
  }

  $: activeTreeMetadata = (() => {
    if (selectedCohortType && hasCohorts) {
      const cohort = $resultsState.cohortResults.find(c => c.cohortType === selectedCohortType);
      return cohort?.treeMetadata || [];
    }
    return $resultsState.treeMetadata;
  })();

  $: activeTreeImages = (() => {
    if (selectedCohortType && hasCohorts) {
      const cohort = $resultsState.cohortResults.find(c => c.cohortType === selectedCohortType);
      return cohort?.treeImages || [];
    }
    return $resultsState.treeImages;
  })();
  
  onMount(async () => {
    console.log('[PhylogeneticTrees] Mounted with', $resultsState.treeImages.length, 'trees');
  });
  
  function getNewickPath(pngPath: string): string {
    return pngPath.replace('.png', '.newick');
  }
  
  function getTreeNameFromMeta(path: string, metadata: TreeMetadata | undefined): string {
    if (metadata && metadata.clone_id !== null) {
      const cloneId = metadata.clone_id;
      const cloneSize = metadata.clone_size;
      return cloneSize > 0 ? `Clone ${cloneId} (${cloneSize} seqs)` : `Clone ${cloneId}`;
    }
    const filename = path.split('/').pop() || '';
    const match = filename.match(/tree_(\d+)/);
    if (match) return `Clone ${match[1]}`;
    return filename.replace('.png', '').replace(/_/g, ' ');
  }

  function getTreeName(path: string, index: number): string {
    return getTreeNameFromMeta(path, activeTreeMetadata[index]);
  }

  let isExportingTrees = false;

  /** Collect all tree image paths grouped by cohort for zip export */
  function collectAllTreePaths(): { cohortName: string; timepoint: string; path: string; metadata: TreeMetadata }[] {
    const items: { cohortName: string; timepoint: string; path: string; metadata: TreeMetadata }[] = [];
    if ($resultsState.cohortResults.length > 0) {
      for (const cohort of $resultsState.cohortResults) {
        for (let i = 0; i < cohort.treeImages.length; i++) {
          items.push({
            cohortName: cohort.cohortName,
            timepoint: cohort.treeMetadata[i]?.timepoint ?? '',
            path: cohort.treeImages[i],
            metadata: cohort.treeMetadata[i]
          });
        }
      }
    } else {
      for (let i = 0; i < $resultsState.treeImages.length; i++) {
        items.push({
          cohortName: '',
          timepoint: $resultsState.treeMetadata[i]?.timepoint ?? '',
          path: $resultsState.treeImages[i],
          metadata: $resultsState.treeMetadata[i]
        });
      }
    }
    return items;
  }

  /** Build a safe folder/file name */
  function safeName(s: string): string {
    return s.replace(/[^a-zA-Z0-9_\-. ]/g, '_').replace(/\s+/g, '_');
  }

  async function exportTrees() {
    isExportingTrees = true;
    try {
      const allTrees = collectAllTreePaths();
      if (allTrees.length === 0) { alert('No trees to export'); return; }

      // Generate metadata CSV
      const csv = treeMetadataToCsv(
        $resultsState.treeMetadata,
        $resultsState.treeImages,
        $resultsState.cohortResults
      );

      // Build zip contents
      const zipFiles: Record<string, Uint8Array> = {};

      // Add metadata CSV
      zipFiles['tree_metadata.csv'] = strToU8(csv);

      // Read each tree PNG and add to zip
      for (const tree of allTrees) {
        if (!tree.path) continue;
        const filename = tree.path.split('/').pop() ?? '';
        if (!filename) continue;

        // Build subfolder path: cohort/timepoint/filename
        const parts: string[] = [];
        if (tree.cohortName) parts.push(safeName(tree.cohortName));
        if (tree.timepoint) parts.push(safeName(tree.timepoint));
        parts.push(filename);
        const zipPath = parts.join('/');

        try {
          if (window.electronAPI) {
            const result = await window.electronAPI.readImageBase64(tree.path);
            if (result.success && result.data) {
              // result.data is "data:image/png;base64,..." - strip prefix
              const base64 = result.data.split(',')[1];
              const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
              zipFiles[zipPath] = binary;
            }
          } else {
            // Demo/web mode: fetch the image URL
            const resp = await fetch(tree.path);
            if (resp.ok) {
              const buf = await resp.arrayBuffer();
              zipFiles[zipPath] = new Uint8Array(buf);
            }
          }
        } catch (e) {
          console.warn(`Failed to read tree image: ${tree.path}`, e);
        }
      }

      // Create zip
      const zipped = zipSync(zipFiles, { level: 6 });

      // Save zip
      if (window.electronAPI) {
        const filePath = await window.electronAPI.saveFile({
          defaultPath: 'phylogenetic_trees.zip',
          filters: [
            { name: 'ZIP Files', extensions: ['zip'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });
        if (!filePath) return;
        // Convert Uint8Array to base64 for IPC transfer (chunked to avoid call stack limits)
        let base64 = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < zipped.length; i += chunkSize) {
          base64 += String.fromCharCode.apply(null, Array.from(zipped.subarray(i, i + chunkSize)));
        }
        base64 = btoa(base64);
        const result = await window.electronAPI.writeBinaryFile(filePath, base64);
        if (!result.success) {
          alert(`Failed to save zip: ${result.error || 'Unknown error'}`);
        }
      } else {
        // Browser download
        const blob = new Blob([zipped], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'phylogenetic_trees.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      console.error('Tree export error:', err);
      alert(`Export failed: ${err.message || 'Unknown error'}`);
    } finally {
      isExportingTrees = false;
    }
  }
</script>

<div class="trees-container">
  {#if $resultsState.treeImages.length === 0 && !hasCohorts}
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <path d="M32 8v8M32 48v8M8 32h8M48 32h8M17 17l6 6M41 41l6 6M17 47l6-6M41 23l6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <circle cx="32" cy="32" r="12" stroke="currentColor" stroke-width="2"/>
        </svg>
      </div>
      <h3 class="empty-title">No Phylogenetic Trees</h3>
      <p class="empty-description">
        Tree visualizations will appear here after a successful analysis with enough clonal diversity.
      </p>
    </div>
  {:else}
    <div class="trees-layout">
      <!-- Tree list sidebar -->
      <aside class="trees-sidebar">
        <div class="sidebar-header">
          <h3 class="sidebar-title">Generated Trees</h3>
          <div class="sidebar-header-actions">
            <span class="tree-count">{hasCohorts ? $resultsState.cohortResults.reduce((s, c) => s + c.treeImages.length, 0) : $resultsState.treeImages.length}</span>
            <button
              class="export-view-btn"
              on:click={exportTrees}
              disabled={isExportingTrees}
              title="Export tree images and metadata as ZIP"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              {isExportingTrees ? 'Zipping...' : 'Export ZIP'}
            </button>
          </div>
        </div>
        <div class="tree-list">
          {#if hasCohorts}
            {#each $resultsState.cohortResults as cohort (cohort.cohortType)}
              {@const cohortTpGroups = buildCohortTimepointGroups(cohort)}
              <button class="cohort-tree-header cohort-tree-{cohort.cohortType}" on:click={() => toggleCohortExpand(cohort.cohortType)}>
                <svg class="tp-chevron" class:expanded={cohortExpanded[cohort.cohortType] !== false} width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span class="cohort-tree-dot cohort-dot-{cohort.cohortType}"></span>
                <span class="tp-group-label">{cohort.cohortName}</span>
                <span class="tp-group-count">{cohort.treeImages.length}</span>
              </button>
              {#if cohortExpanded[cohort.cohortType] !== false}
                {#if cohortTpGroups.length > 0}
                  {#each cohortTpGroups as group}
                    <button class="tp-group-header tp-group-nested" on:click={() => toggleTpGroup(cohort.cohortType + ':' + group.label)}>
                      <svg class="tp-chevron" class:expanded={tpExpanded[cohort.cohortType + ':' + group.label] !== false} width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      <span class="tp-group-label">{group.label}</span>
                      <span class="tp-group-count">{group.trees.length}</span>
                    </button>
                    {#if tpExpanded[cohort.cohortType + ':' + group.label] !== false}
                      {#each group.trees as tree}
                        <button
                          class="tree-item tree-item-deep"
                          class:selected={selectedCohortType === cohort.cohortType && selectedTreeIndex === tree.index}
                          on:click={() => selectCohortTree(cohort.cohortType, tree.index)}
                        >
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                          </svg>
                          <span class="tree-name">{getTreeNameFromMeta(tree.path, tree.metadata)}</span>
                        </button>
                      {/each}
                    {/if}
                  {/each}
                {:else}
                  {#each cohort.treeImages as treePath, index}
                    <button
                      class="tree-item tree-item-nested"
                      class:selected={selectedCohortType === cohort.cohortType && selectedTreeIndex === index}
                      on:click={() => selectCohortTree(cohort.cohortType, index)}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                      </svg>
                      <span class="tree-name">{getTreeNameFromMeta(treePath, cohort.treeMetadata[index])}</span>
                    </button>
                  {/each}
                {/if}
              {/if}
            {/each}
          {:else if hasTimepoints && timepointGroups.length > 0}
            {#each timepointGroups as group}
              <button class="tp-group-header" on:click={() => toggleTpGroup(group.label)}>
                <svg class="tp-chevron" class:expanded={tpExpanded[group.label] !== false} width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span class="tp-group-label">{group.label}</span>
                <span class="tp-group-count">{group.trees.length}</span>
              </button>
              {#if tpExpanded[group.label] !== false}
                {#each group.trees as tree}
                  <button 
                    class="tree-item tree-item-nested"
                    class:selected={selectedCohortType === null && selectedTreeIndex === tree.index}
                    on:click={() => selectDefaultTree(tree.index)}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                    <span class="tree-name">{getTreeName(tree.path, tree.index)}</span>
                  </button>
                {/each}
              {/if}
            {/each}
          {:else}
            {#each $resultsState.treeImages as treePath, index}
              <button 
                class="tree-item"
                class:selected={selectedCohortType === null && selectedTreeIndex === index}
                on:click={() => selectDefaultTree(index)}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                <span class="tree-name">{getTreeName(treePath, index)}</span>
              </button>
            {/each}
          {/if}
        </div>
      </aside>
      
      <!-- Tree viewer -->
      <main class="tree-viewer">
        {#if isLoading}
          <div class="loading-state">
            <div class="spinner"></div>
            <span>Loading tree images...</span>
          </div>
        {:else}
          <div class="tree-view-container">
            <div class="tree-header">
              <div class="tree-header-main">
                <h2 class="tree-title">{getTreeName(activeTreeImages[selectedTreeIndex] || '', selectedTreeIndex)}</h2>
                {#if selectedCohortType}
                  {@const cohort = $resultsState.cohortResults.find(c => c.cohortType === selectedCohortType)}
                  {#if cohort}
                    <span class="tree-cohort-tag tree-cohort-{cohort.cohortType}">{cohort.cohortName}</span>
                  {/if}
                {/if}
              </div>
            </div>
            
            <div class="tree-content">
              <InteractiveTree 
                newickPath={getNewickPath(activeTreeImages[selectedTreeIndex] || '')}
                treeName={getTreeName(activeTreeImages[selectedTreeIndex] || '', selectedTreeIndex)}
                cloneSize={activeTreeMetadata[selectedTreeIndex]?.clone_size || 0}
              />
            </div>
          </div>
        {/if}
      </main>
    </div>
  {/if}
</div>

<style>
  .trees-container {
    height: 100%;
    overflow: hidden;
  }
  
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: var(--space-8);
    text-align: center;
    background: var(--gray-50);
  }
  
  .empty-icon {
    color: var(--gray-300);
    margin-bottom: var(--space-4);
  }
  
  .empty-title {
    font-size: var(--text-xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0 0 var(--space-2) 0;
  }
  
  .empty-description {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    max-width: 400px;
    margin: 0;
  }
  
  .trees-layout {
    display: flex;
    height: 100%;
  }
  
  .trees-sidebar {
    width: 260px;
    background: var(--surface-raised);
    border-right: 1px solid var(--border-light);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  
  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-light);
  }
  .sidebar-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
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
  
  .sidebar-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
  }
  
  .tree-count {
    padding: 2px 8px;
    background: var(--color-primary-light);
    color: var(--color-primary);
    border-radius: var(--border-radius-full);
    font-size: 11px;
    font-weight: var(--font-semibold);
  }
  
  .tree-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
  }
  
  .tree-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: none;
    border-radius: var(--border-radius-md);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  
  .tree-item:hover {
    background: var(--gray-50);
    color: var(--text-primary);
  }
  
  .tree-item.selected {
    background: var(--color-primary-light);
    color: var(--color-primary);
  }
  
  .tree-item svg {
    flex-shrink: 0;
    opacity: 0.6;
  }
  
  .tree-item.selected svg {
    opacity: 1;
  }
  
  .tree-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .tree-viewer {
    flex: 1;
    background: var(--gray-50);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  
  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: var(--space-4);
    color: var(--text-tertiary);
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
  
  .tree-image-container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  
  .tree-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: var(--space-4) var(--space-6);
    background: var(--surface-raised);
    border-bottom: 1px solid var(--border-light);
    flex-shrink: 0;
    gap: var(--space-4);
  }
  
  .tree-header-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  
  .tree-title {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
  }
  
  .viewer-note {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: 11px;
    color: var(--gray-600);
    margin-top: var(--space-1);
  }
  
  .viewer-note svg {
    flex-shrink: 0;
  }
  
  .tree-info-note {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-primary-light);
    border-radius: var(--border-radius-md);
    font-size: var(--text-xs);
    color: var(--color-primary);
    line-height: 1.4;
  }
  
  .tree-info-note svg {
    flex-shrink: 0;
    margin-top: 2px;
    opacity: 0.8;
  }
  
  .tree-info-note span {
    flex: 1;
  }
  
  .tree-actions {
    display: flex;
    gap: var(--space-2);
  }
  
  .tree-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .tree-image-wrapper {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
  }
  
  .tree-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: var(--border-radius-md);
    box-shadow: var(--shadow-md);
    background: white;
  }
  
  .tree-view-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  
  .tree-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  
  .tp-group-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: var(--gray-50);
    border: none;
    border-radius: var(--border-radius-md);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    margin-bottom: 2px;
    transition: background var(--transition-fast);
  }
  
  .tp-group-header:hover {
    background: var(--gray-100);
  }
  
  .tp-chevron {
    flex-shrink: 0;
    transition: transform var(--transition-fast);
  }
  
  .tp-chevron.expanded {
    transform: rotate(90deg);
  }
  
  .tp-group-label {
    flex: 1;
  }
  
  .tp-group-count {
    padding: 1px 6px;
    background: var(--color-primary-light);
    color: var(--color-primary);
    border-radius: var(--border-radius-full);
    font-size: 10px;
    font-weight: var(--font-semibold);
  }
  
  .tree-item-nested {
    padding-left: var(--space-6);
  }

  .tree-item-deep {
    padding-left: calc(var(--space-6) + var(--space-4));
  }

  .tp-group-nested {
    padding-left: var(--space-5);
  }

  .cohort-tree-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--border-radius-md);
    font-size: var(--text-sm);
    font-weight: var(--font-bold);
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    margin-bottom: 2px;
    transition: background var(--transition-fast);
  }
  .cohort-tree-disease { background: #E3F2FD; }
  .cohort-tree-disease:hover { background: #BBDEFB; }
  .cohort-tree-control { background: #F5F5F5; }
  .cohort-tree-control:hover { background: #EEEEEE; }

  .cohort-tree-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .cohort-dot-disease { background: #1565C0; }
  .cohort-dot-control { background: #757575; }

  .tree-cohort-tag {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    padding: 1px 8px;
    border-radius: var(--border-radius-full);
  }
  .tree-cohort-disease { background: #E3F2FD; color: #1565C0; }
  .tree-cohort-control { background: #F5F5F5; color: #616161; }
</style>

