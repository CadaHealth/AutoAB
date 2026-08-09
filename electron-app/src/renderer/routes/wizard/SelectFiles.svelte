<script lang="ts">
  import { wizardState, canProceedStep1 } from '../../lib/stores/app';
  
  let isLoading = false;
  
  async function handleSelectDirectory() {
    console.log('handleSelectDirectory called');
    console.log('window.electronAPI:', window.electronAPI);
    
    if (!window.electronAPI) {
      console.error('electronAPI not available');
      alert('Electron API not available. Please check the console for errors.');
      return;
    }
    
    if (!window.electronAPI.selectDirectory) {
      console.error('selectDirectory method not available');
      alert('selectDirectory method not found on electronAPI');
      return;
    }
    
    isLoading = true;
    try {
      console.log('Calling selectDirectory...');
      const result = await window.electronAPI.selectDirectory();
      console.log('selectDirectory result:', result);
      
      if (result) {
        wizardState.update(s => ({
          ...s,
          fastaDir: result.path,
          fastaFiles: result.files,
          fastaCount: result.fileCount,
          detectedStructure: result.detectedStructure ?? null
        }));
      } else {
        console.log('User cancelled or no directory selected');
      }
    } catch (error) {
      console.error('Error selecting directory:', error);
      alert(`Error selecting directory: ${error}`);
    } finally {
      isLoading = false;
    }
  }
  
  function handleCleanFastaChange(e: Event) {
    const target = e.target as HTMLInputElement;
    wizardState.update(s => ({
      ...s,
      cleanFasta: target.checked
    }));
  }
  
  function handleNext() {
    wizardState.update(s => ({
      ...s,
      step: 2
    }));
  }
  
  function getDirectoryName(path: string): string {
    return path.split('/').pop() || path;
  }
</script>

<div class="step-container">
  <header class="step-header">
    <span class="step-number">Step 1</span>
    <h1 class="step-title">Select FASTA Files</h1>
    <p class="step-description">
      Choose a directory containing your FASTA files for B-cell repertoire analysis. 
      All .fasta and .fa files in the directory will be processed.
    </p>
  </header>
  
  <div class="step-content">
    <!-- Directory picker -->
    <div class="picker-card">
      <div class="picker-icon">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <rect x="4" y="10" width="40" height="32" rx="3" stroke="currentColor" stroke-width="2"/>
          <path d="M4 18h40" stroke="currentColor" stroke-width="2"/>
          <path d="M4 13a3 3 0 0 1 3-3h12l3 4h22a3 3 0 0 1 3 3" stroke="currentColor" stroke-width="2"/>
        </svg>
      </div>
      
      {#if $wizardState.fastaDir}
        <div class="selected-info">
          <div class="selected-path">
            <span class="path-label">Selected Directory</span>
            <span class="path-value">{getDirectoryName($wizardState.fastaDir)}</span>
          </div>
          
          <div class="file-count-badge">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M11.5 4L5.5 10L2.5 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            {$wizardState.fastaCount} FASTA file{$wizardState.fastaCount !== 1 ? 's' : ''} found
          </div>
        </div>
        
        <button 
          class="btn btn-secondary"
          on:click={handleSelectDirectory}
          disabled={isLoading}
        >
          Change Directory
        </button>
      {:else}
        <button 
          class="btn btn-primary btn-lg"
          on:click={handleSelectDirectory}
          disabled={isLoading}
        >
          {#if isLoading}
            Selecting...
          {:else}
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="5" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
              <path d="M2 8h16" stroke="currentColor" stroke-width="1.5"/>
              <path d="M2 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            Select Directory
          {/if}
        </button>
        <p class="picker-hint">Choose a folder containing FASTA files</p>
      {/if}
    </div>
    
    <!-- Detected folder structure -->
    {#if $wizardState.detectedStructure}
      <div class="structure-preview">
        <div class="preview-header">
          <span class="preview-title">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="display:inline;vertical-align:-2px;margin-right:4px">
              <path d="M1 3a1 1 0 011-1h3l1.5 1.5H12a1 1 0 011 1V11a1 1 0 01-1 1H2a1 1 0 01-1-1V3z" stroke="currentColor" stroke-width="1.2"/>
            </svg>
            Folder structure detected
          </span>
          <span class="preview-count">{$wizardState.detectedStructure.groups.length} group{$wizardState.detectedStructure.groups.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="structure-tree">
          {#each $wizardState.detectedStructure.groups as group}
            <div class="tree-group">
              <div class="tree-group-name">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="1" y="2.5" width="10" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/>
                  <path d="M1 5h10" stroke="currentColor" stroke-width="1.2"/>
                  <path d="M1 4a1 1 0 011-1h3l1 1.5h5a1 1 0 011 1" stroke="currentColor" stroke-width="1"/>
                </svg>
                <strong>{group.name}</strong>
              </div>
              {#each group.timepoints as tp}
                <div class="tree-timepoint">
                  <span class="tp-label">{tp.label}</span>
                  <span class="tp-count">{tp.files.length} file{tp.files.length !== 1 ? 's' : ''}</span>
                </div>
              {/each}
            </div>
          {/each}
        </div>
        <p class="structure-hint">This structure will be used to auto-populate the Organize tab after analysis.</p>
      </div>
    {:else if $wizardState.fastaFiles.length > 0}
      <!-- Flat file list preview -->
      <div class="file-preview">
        <div class="preview-header">
          <span class="preview-title">Files to process</span>
          <span class="preview-count">{$wizardState.fastaFiles.length} files</span>
        </div>
        <div class="file-list">
          {#each $wizardState.fastaFiles.slice(0, 5) as file}
            <div class="file-item">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 2h5l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5"/>
                <path d="M9 2v4h4" stroke="currentColor" stroke-width="1.5"/>
              </svg>
              <span class="file-name">{file}</span>
            </div>
          {/each}
          {#if $wizardState.fastaFiles.length > 5}
            <div class="file-item more">
              +{$wizardState.fastaFiles.length - 5} more files
            </div>
          {/if}
        </div>
      </div>
    {/if}
    
    <!-- Options -->
    <div class="options-section">
      <h3 class="options-title">Processing Options</h3>
      
      <label class="checkbox-option">
        <input 
          type="checkbox"
          checked={$wizardState.cleanFasta}
          on:change={handleCleanFastaChange}
        />
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
    <button 
      class="btn btn-primary btn-lg"
      disabled={!$canProceedStep1}
      on:click={handleNext}
    >
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
  
  .picker-card {
    background: var(--surface-raised);
    border: 2px dashed var(--border-default);
    border-radius: var(--border-radius-lg);
    padding: var(--space-8);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    transition: border-color var(--transition-fast);
  }
  
  .picker-card:hover {
    border-color: var(--color-primary-muted);
  }
  
  .picker-icon {
    color: var(--gray-400);
    margin-bottom: var(--space-4);
  }
  
  .selected-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  
  .selected-path {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  
  .path-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  .path-value {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .file-count-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-success-light);
    color: var(--color-success);
    border-radius: var(--border-radius-full);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
  }
  
  .picker-hint {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    margin: var(--space-3) 0 0 0;
  }
  
  .file-preview {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    overflow: hidden;
  }
  
  .preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    background: var(--gray-50);
    border-bottom: 1px solid var(--border-light);
  }
  
  .preview-title {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  .preview-count {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  
  .file-list {
    padding: var(--space-2);
  }
  
  .file-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  
  .file-item svg {
    color: var(--gray-400);
    flex-shrink: 0;
  }
  
  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .file-item.more {
    color: var(--text-tertiary);
    font-style: italic;
  }

  /* Detected folder structure */
  .structure-preview {
    background: var(--surface-raised);
    border: 1px solid var(--color-primary-muted);
    border-radius: var(--border-radius-lg);
    overflow: hidden;
  }

  .structure-tree {
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-height: 220px;
    overflow-y: auto;
  }

  .tree-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tree-group-name {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-primary);
  }

  .tree-group-name svg {
    color: var(--color-primary);
    flex-shrink: 0;
  }

  .tree-timepoint {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-left: calc(12px + var(--space-2) + var(--space-3));
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .tree-timepoint::before {
    content: '└';
    color: var(--gray-400);
    font-family: monospace;
  }

  .tp-label {
    font-weight: var(--font-medium);
  }

  .tp-count {
    color: var(--text-tertiary);
  }

  .structure-hint {
    padding: var(--space-2) var(--space-4) var(--space-3);
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    font-style: italic;
  }
  
  .options-section {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    padding: var(--space-5);
  }
  
  .options-title {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
    margin: 0 0 var(--space-4) 0;
  }
  
  .checkbox-option {
    display: flex;
    gap: var(--space-3);
    cursor: pointer;
  }
  
  .checkbox-option input[type="checkbox"] {
    appearance: none;
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-default);
    border-radius: var(--border-radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
    position: relative;
    flex-shrink: 0;
    margin-top: 2px;
  }
  
  .checkbox-option input[type="checkbox"]:checked {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  
  .checkbox-option input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    left: 6px;
    top: 2px;
    width: 4px;
    height: 9px;
    border: solid white;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  
  .checkbox-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  
  .checkbox-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
  }
  
  .checkbox-description {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    line-height: var(--leading-relaxed);
  }
  
  .step-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: var(--space-8);
    padding-top: var(--space-6);
    border-top: 1px solid var(--border-light);
  }
  
  .footer-spacer {
    flex: 1;
  }
  
  .btn svg {
    margin-left: var(--space-2);
  }
</style>

