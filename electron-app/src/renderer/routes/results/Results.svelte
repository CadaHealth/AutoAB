<script lang="ts">
  import { resultsState, selectedSequence, selectedDlSequence } from '../../lib/stores/app';
  import SequenceBrowser from './SequenceBrowser.svelte';
  import SequenceDetails from './SequenceDetails.svelte';
  import DlSequenceBrowser from './DlSequenceBrowser.svelte';
  import RepertoireDashboard from './RepertoireDashboard.svelte';
  import PhylogeneticTrees from './PhylogeneticTrees.svelte';
  import PublicClones from './PublicClones.svelte';
  import CovidMatching from './CovidMatching.svelte';
  import AntibodyMatching from './AntibodyMatching.svelte';
  import AntigenBindingPrediction from './AntigenBindingPrediction.svelte';

  const IS_DEMO = typeof window !== 'undefined' && !window.electronAPI;

  type Tab = 'browser' | 'dl-browser' | 'dashboard' | 'trees' | 'public-clones' | 'covid-matching' | 'antigen-binding';
  let activeTab: Tab = IS_DEMO ? 'dashboard' : 'browser';
  let isExporting = false;

  // Function to escape CSV values
  function escapeCsvValue(value: any): string {
    if (value === null || value === undefined) {
      return '';
    }
    const str = String(value);
    // If value contains comma, quote, or newline, wrap in quotes and escape quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // Function to convert sequences to CSV
  function sequencesToCsv(sequences: typeof $resultsState.sequences): string {
    // Define CSV headers
    const headers = [
      'Sequence ID',
      'Sequence Name',
      'File',
      'V Gene',
      'D Gene',
      'J Gene',
      'V Locus',
      'D Locus',
      'J Locus',
      'CDR3 DNA',
      'CDR3 Peptide',
      'CDR3 Length (bp)',
      'Somatic Mutations',
      'Isotype',
      'C Call (Ig Class)',
      'Clone ID',
      'Clone Count',
      'Productive'
    ];

    // Create CSV rows
    const rows = sequences.map(seq => {
      // Extract file name from sequence ID if file field is not available
      let fileName = seq.file || '';
      if (!fileName) {
        // Legacy format: |||filename
        if (seq.id.includes('|||')) {
          const parts = seq.id.split('|||');
          if (parts.length > 1) {
            fileName = parts[1];
          }
        }
        // New format: numeric suffix is handled by backend grouping;
        // fileName will be set from the file group key
      }
      
      return [
        escapeCsvValue(seq.id),
        escapeCsvValue(seq.name),
        escapeCsvValue(fileName),
        escapeCsvValue(seq.v_gene),
        escapeCsvValue(seq.d_gene),
        escapeCsvValue(seq.j_gene),
        escapeCsvValue(seq.v_locus),
        escapeCsvValue(seq.d_locus),
        escapeCsvValue(seq.j_locus),
        escapeCsvValue(seq.cdr3_dna),
        escapeCsvValue(seq.cdr3_peptide),
        escapeCsvValue(seq.cdr3_dna ? seq.cdr3_dna.length : ''),
        escapeCsvValue(seq.somatic_mutations),
        escapeCsvValue(seq.isotype),
        escapeCsvValue(seq.c_call ?? ''),
        escapeCsvValue(seq.clone_id),
        escapeCsvValue(seq.clone_count),
        escapeCsvValue(seq.productive ? 'Yes' : 'No')
      ];
    });

    // Combine headers and rows
    const csvLines = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ];

    return csvLines.join('\n');
  }

  // Export all sequences to CSV
  async function exportToCsv() {
    if ($resultsState.sequences.length === 0) {
      alert('No sequences to export');
      return;
    }

    isExporting = true;

    try {
      const csvContent = sequencesToCsv($resultsState.sequences);

      if (window.electronAPI) {
        // Electron: use native save dialog
        const filePath = await window.electronAPI.saveFile({
          defaultPath: 'bcr_analysis_results.csv',
          filters: [
            { name: 'CSV Files', extensions: ['csv'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });

        if (!filePath) {
          isExporting = false;
          return;
        }

        const result = await window.electronAPI.writeFile(filePath, csvContent);
        if (result.success) {
          alert(`Successfully exported ${$resultsState.sequences.length} sequences to ${filePath}`);
        } else {
          alert(`Failed to export: ${result.error || 'Unknown error'}`);
        }
      } else {
        // Web/demo mode: browser download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bcr_analysis_results.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (error: any) {
      console.error('Export error:', error);
      alert(`Export failed: ${error.message || 'Unknown error'}`);
    } finally {
      isExporting = false;
    }
  }
</script>

<div class="results-container">
  <!-- Header with tabs -->
  <div class="results-header">
    <div class="header-info">
      <h1 class="results-title">Analysis Results</h1>
      <span class="sequence-count">
        {$resultsState.sequences.length} sequences analyzed
      </span>
    </div>
    
    <div class="header-actions">
      {#if activeTab === 'browser' || activeTab === 'dl-browser'}
        <button
          class="btn btn-primary export-btn"
          on:click={exportToCsv}
          disabled={isExporting || $resultsState.sequences.length === 0}
          title="Export all sequences to CSV"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8M5 7l3 3 3-3M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {isExporting ? 'Exporting...' : 'Export Sequences'}
        </button>
      {/if}

      <div class="tabs">
      <button 
        class="tab" 
        class:active={activeTab === 'browser'}
        on:click={() => activeTab = 'browser'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
          <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
          <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
          <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        Sequence Browser
      </button>
      {#if $resultsState.dlSequences.length > 0}
        <button 
          class="tab" 
          class:active={activeTab === 'dl-browser'}
          on:click={() => activeTab = 'dl-browser'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <circle cx="8" cy="8" r="2" fill="currentColor"/>
            <path d="M8 2v4M8 10v4M2 8h4M10 8h4" stroke="currentColor" stroke-width="1.5"/>
          </svg>
          DL Clustering
          <span class="tab-badge">{$resultsState.dlSequences.length}</span>
        </button>
      {/if}
      <button 
        class="tab" 
        class:active={activeTab === 'dashboard'}
        on:click={() => activeTab = 'dashboard'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="8" width="3" height="6" rx="0.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
          <rect x="6.5" y="5" width="3" height="9" rx="0.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
          <rect x="11" y="2" width="3" height="12" rx="0.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
        </svg>
        Dashboard
      </button>
      <button 
        class="tab" 
        class:active={activeTab === 'trees'}
        on:click={() => activeTab = 'trees'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 2v4M8 6H4v4M8 6h4v4M4 10v4M12 10v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        Phylogenetic Trees
        {#if $resultsState.treeImages.length > 0}
          <span class="tab-badge">{$resultsState.treeImages.length}</span>
        {/if}
      </button>
      <button 
        class="tab" 
        class:active={activeTab === 'public-clones'}
        on:click={() => activeTab = 'public-clones'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="4" cy="4" r="3" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="12" cy="4" r="3" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="8" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/>
          <path d="M6 5l4 6M10 5l-4 6" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        Clones
        {#if $resultsState.publicClonesData}
          <span class="tab-badge">
            {$resultsState.publicClonesData.stats.total_public_clones}
          </span>
        {/if}
      </button>
      
      <button 
        class="tab" 
        class:active={activeTab === 'covid-matching'}
        on:click={() => activeTab = 'covid-matching'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 2v12M14 2v12M6 4l4 2-4 2 4 2-4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        {IS_DEMO ? 'Antibody Matching' : 'COVID-DB Matching'}
        {#if $resultsState.covidMatchData}
          <span class="tab-badge">
            {$resultsState.covidMatchData.stats.clones_with_high_matches}
          </span>
        {/if}
      </button>
      {#if IS_DEMO}
      <button
        class="tab"
        class:active={activeTab === 'antigen-binding'}
        on:click={() => activeTab = 'antigen-binding'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 9v5M5 3l3 6 3-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="4" cy="2.5" r="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
          <circle cx="12" cy="2.5" r="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
        </svg>
        Antigen Binding
      </button>
      {/if}
      </div>
    </div>
  </div>
  
  <!-- Main content -->
  <div class="results-content">
    {#if activeTab === 'browser'}
      <div class="browser-layout">
        <aside class="browser-sidebar">
          <SequenceBrowser />
        </aside>
        <main class="details-panel">
          {#if $selectedSequence}
            <SequenceDetails sequence={$selectedSequence} />
          {:else}
            <div class="empty-state">
              <div class="empty-icon">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                  <path d="M24 4l20 11.5v17L24 44 4 32.5v-17L24 4z" stroke="currentColor" stroke-width="2"/>
                  <path d="M24 22v12M24 18h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </div>
              <h3 class="empty-title">No Sequence Selected</h3>
              <p class="empty-description">
                Select a sequence from the browser to view detailed information
              </p>
            </div>
          {/if}
        </main>
      </div>
    {:else if activeTab === 'dl-browser'}
      <div class="browser-layout">
        <aside class="browser-sidebar">
          <DlSequenceBrowser />
        </aside>
        <main class="details-panel">
          {#if $selectedDlSequence}
            <SequenceDetails sequence={$selectedDlSequence} />
          {:else}
            <div class="empty-state">
              <div class="empty-icon">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                  <circle cx="24" cy="24" r="18" stroke="currentColor" stroke-width="2" fill="none"/>
                  <circle cx="24" cy="24" r="6" fill="currentColor"/>
                  <path d="M24 6v12M24 30v12M6 24h12M30 24h12" stroke="currentColor" stroke-width="2"/>
                </svg>
              </div>
              <h3 class="empty-title">No Sequence Selected</h3>
              <p class="empty-description">
                Select a sequence from the DL clustering browser to view detailed information
              </p>
            </div>
          {/if}
        </main>
      </div>
    {:else if activeTab === 'dashboard'}
      <RepertoireDashboard on:switch-tab={(e) => activeTab = e.detail} />
    {:else if activeTab === 'trees'}
      <PhylogeneticTrees />
    {:else if activeTab === 'public-clones'}
      <PublicClones />
    {:else if activeTab === 'covid-matching'}
      {#if IS_DEMO}
        <AntibodyMatching />
      {:else}
        <CovidMatching />
      {/if}
    {:else if activeTab === 'antigen-binding'}
      <AntigenBindingPrediction />
    {/if}
  </div>
</div>

<style>
  .results-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    width: 100%;
    margin: 0;
    padding: 0;
  }
  
  .results-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4) var(--space-6);
    background: var(--surface-raised);
    border-bottom: 1px solid var(--border-light);
    flex-shrink: 0;
    gap: var(--space-4);
  }
  
  .header-info {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    flex: 1;
  }
  
  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  
  .export-btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    white-space: nowrap;
  }
  
  .export-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .export-btn svg {
    flex-shrink: 0;
  }
  
  .results-title {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
  }
  
  .sequence-count {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
  
  .tabs {
    display: flex;
    gap: var(--space-1);
    background: var(--gray-100);
    padding: var(--space-1);
    border-radius: var(--border-radius-md);
  }
  
  .tab {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: transparent;
    border: none;
    border-radius: var(--border-radius-sm);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  
  .tab:hover {
    color: var(--text-primary);
  }
  
  .tab.active {
    background: var(--surface-raised);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm);
  }
  
  .tab svg {
    opacity: 0.7;
  }
  
  .tab.active svg {
    opacity: 1;
  }
  
  .tab-badge {
    padding: 2px 6px;
    background: var(--color-primary);
    color: white;
    border-radius: var(--border-radius-full);
    font-size: 10px;
    font-weight: var(--font-semibold);
  }
  
  .results-content {
    flex: 1;
    overflow: hidden;
    min-height: 0;
    margin: 0;
    padding: 0;
    width: 100%;
  }
  
  .browser-layout {
    display: flex;
    height: 100%;
    min-height: 0;
    width: 100%;
    margin: 0;
    padding: 0;
  }
  
  .browser-sidebar {
    width: 340px;
    background: var(--surface-raised);
    border-right: 1px solid var(--border-light);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow: hidden;
    min-height: 0;
  }
  
  .details-panel {
    flex: 1 !important;
    overflow-y: auto;
    background: var(--gray-50);
    width: 100% !important;
    min-width: 0;
    max-width: none !important;
    box-sizing: border-box;
  }
  
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: var(--space-8);
    text-align: center;
  }
  
  .empty-icon {
    color: var(--gray-300);
    margin-bottom: var(--space-4);
  }
  
  .empty-title {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0 0 var(--space-2) 0;
  }
  
  .empty-description {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    margin: 0;
  }
</style>

