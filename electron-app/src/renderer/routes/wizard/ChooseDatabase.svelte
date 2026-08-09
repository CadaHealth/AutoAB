<script lang="ts">
  import { wizardState, canProceedStep2, type Species } from '../../lib/stores/app';

  let isLoading = false;

  function handleDatabaseTypeChange(type: 'IMGT' | 'Custom') {
    wizardState.update(s => ({
      ...s,
      databaseType: type
    }));
  }

  function handleSpeciesChange(species: Species) {
    wizardState.update(s => ({
      ...s,
      species
    }));
  }
  
  async function handleSelectFile(field: 'v' | 'd' | 'j') {
    if (!window.electronAPI) return;
    
    isLoading = true;
    try {
      const result = await window.electronAPI.selectFile({
        filters: [
          { name: 'FASTA Files', extensions: ['fasta', 'fa'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      
      if (result) {
        wizardState.update(s => ({
          ...s,
          [`customDatabase${field.toUpperCase()}`]: result
        }));
      }
    } finally {
      isLoading = false;
    }
  }
  
  function handleBack() {
    wizardState.update(s => ({
      ...s,
      step: 1
    }));
  }
  
  function handleNext() {
    wizardState.update(s => ({
      ...s,
      step: 3
    }));
  }
  
  function getFileName(path: string): string {
    return path.split('/').pop() || path;
  }
</script>

<div class="step-container">
  <header class="step-header">
    <span class="step-number">Step 2</span>
    <h1 class="step-title">Choose Database</h1>
    <p class="step-description">
      Select the germline database to use for V(D)J gene assignment. 
      You can use the built-in IMGT database or provide custom reference files.
    </p>
  </header>
  
  <div class="step-content">
    <!-- Species selector -->
    <div class="species-section">
      <h3 class="species-title">Species</h3>
      <p class="species-help">
        Selects which IMGT reference set is used. Mouse references must be
        downloaded separately (see <code>SETUP.md</code> · &ldquo;Mouse references&rdquo;).
      </p>
      <div class="species-pills">
        <button class="species-pill" class:active={$wizardState.species === 'human'}
                on:click={() => handleSpeciesChange('human')}>Human</button>
        <button class="species-pill" class:active={$wizardState.species === 'mouse'}
                on:click={() => handleSpeciesChange('mouse')}>Mouse</button>
        <button class="species-pill" class:active={$wizardState.species === 'custom'}
                on:click={() => { handleSpeciesChange('custom'); handleDatabaseTypeChange('Custom'); }}>Custom</button>
      </div>
    </div>

    <!-- Database type selection -->
    <div class="database-options">
      <button 
        class="database-option"
        class:selected={$wizardState.databaseType === 'IMGT'}
        on:click={() => handleDatabaseTypeChange('IMGT')}
      >
        <div class="option-radio">
          {#if $wizardState.databaseType === 'IMGT'}
            <div class="radio-dot"></div>
          {/if}
        </div>
        <div class="option-content">
          <div class="option-header">
            <span class="option-title">
              IMGT {$wizardState.species === 'mouse' ? 'Mouse' : 'Human'} Database
            </span>
            <span class="badge badge-info">Recommended</span>
          </div>
          <p class="option-description">
            Built-in IMGT immunoglobulin germline database for the selected species.
            Includes V, D, and J gene references.
          </p>
          <div class="option-details">
            <span class="detail-item">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M11.5 4L5.5 10L2.5 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Pre-configured for {$wizardState.species} samples
            </span>
            <span class="detail-item">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M11.5 4L5.5 10L2.5 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Regularly updated reference sequences
            </span>
          </div>
        </div>
      </button>
      
      <button 
        class="database-option"
        class:selected={$wizardState.databaseType === 'Custom'}
        on:click={() => handleDatabaseTypeChange('Custom')}
      >
        <div class="option-radio">
          {#if $wizardState.databaseType === 'Custom'}
            <div class="radio-dot"></div>
          {/if}
        </div>
        <div class="option-content">
          <div class="option-header">
            <span class="option-title">Custom Database</span>
          </div>
          <p class="option-description">
            Provide your own V, D, and J gene reference files in FASTA format. 
            Use this for non-human species or custom reference sets.
          </p>
        </div>
      </button>
    </div>
    
    <!-- Custom database file selection -->
    {#if $wizardState.databaseType === 'Custom'}
      <div class="custom-database-section">
        <h3 class="section-title">Select Reference Files</h3>
        <p class="section-description">
          Provide FASTA files for each gene segment. All three files are required.
        </p>
        
        <div class="file-inputs">
          <!-- V Gene -->
          <div class="file-input-row">
            <div class="file-label">
              <span class="gene-badge v">V</span>
              <span>Variable Gene</span>
            </div>
            {#if $wizardState.customDatabaseV}
              <div class="file-selected">
                <span class="file-name">{getFileName($wizardState.customDatabaseV)}</span>
                <button 
                  class="btn btn-ghost btn-sm"
                  on:click={() => handleSelectFile('v')}
                  disabled={isLoading}
                >
                  Change
                </button>
              </div>
            {:else}
              <button 
                class="btn btn-secondary"
                on:click={() => handleSelectFile('v')}
                disabled={isLoading}
              >
                Select V Gene File
              </button>
            {/if}
          </div>
          
          <!-- D Gene -->
          <div class="file-input-row">
            <div class="file-label">
              <span class="gene-badge d">D</span>
              <span>Diversity Gene</span>
            </div>
            {#if $wizardState.customDatabaseD}
              <div class="file-selected">
                <span class="file-name">{getFileName($wizardState.customDatabaseD)}</span>
                <button 
                  class="btn btn-ghost btn-sm"
                  on:click={() => handleSelectFile('d')}
                  disabled={isLoading}
                >
                  Change
                </button>
              </div>
            {:else}
              <button 
                class="btn btn-secondary"
                on:click={() => handleSelectFile('d')}
                disabled={isLoading}
              >
                Select D Gene File
              </button>
            {/if}
          </div>
          
          <!-- J Gene -->
          <div class="file-input-row">
            <div class="file-label">
              <span class="gene-badge j">J</span>
              <span>Joining Gene</span>
            </div>
            {#if $wizardState.customDatabaseJ}
              <div class="file-selected">
                <span class="file-name">{getFileName($wizardState.customDatabaseJ)}</span>
                <button 
                  class="btn btn-ghost btn-sm"
                  on:click={() => handleSelectFile('j')}
                  disabled={isLoading}
                >
                  Change
                </button>
              </div>
            {:else}
              <button 
                class="btn btn-secondary"
                on:click={() => handleSelectFile('j')}
                disabled={isLoading}
              >
                Select J Gene File
              </button>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
  
  <footer class="step-footer">
    <button class="btn btn-ghost" on:click={handleBack}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 4l-4 4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Back
    </button>
    <button 
      class="btn btn-primary btn-lg"
      disabled={!$canProceedStep2}
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
  
  .database-options {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  
  .database-option {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-5);
    background: var(--surface-raised);
    border: 2px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    text-align: left;
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  
  .database-option:hover {
    border-color: var(--border-default);
  }
  
  .database-option.selected {
    border-color: var(--color-primary);
    background: var(--color-primary-light);
  }
  
  .option-radio {
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-default);
    border-radius: var(--border-radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
    transition: all var(--transition-fast);
  }
  
  .database-option.selected .option-radio {
    border-color: var(--color-primary);
  }
  
  .radio-dot {
    width: 10px;
    height: 10px;
    background: var(--color-primary);
    border-radius: var(--border-radius-full);
  }
  
  .option-content {
    flex: 1;
  }
  
  .option-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  
  .option-title {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  
  .option-description {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: var(--leading-relaxed);
    margin: 0 0 var(--space-3) 0;
  }
  
  .option-details {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  
  .detail-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-success);
  }
  
  .custom-database-section {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    padding: var(--space-5);
    animation: slideUp var(--transition-normal) ease-out;
  }
  
  .section-title {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0 0 var(--space-1) 0;
  }
  
  .section-description {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    margin: 0 0 var(--space-5) 0;
  }
  
  .file-inputs {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  
  .file-input-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--gray-50);
    border-radius: var(--border-radius-md);
  }
  
  .file-label {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  
  .gene-badge {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--border-radius-sm);
    font-size: var(--text-xs);
    font-weight: var(--font-bold);
    color: white;
  }
  
  .gene-badge.v { background: #3B82F6; }
  .gene-badge.d { background: #F59E0B; }
  .gene-badge.j { background: #10B981; }
  
  .file-selected {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  
  .file-name {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  
  .btn-primary svg {
    margin-right: 0;
    margin-left: var(--space-2);
  }
  
  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Species selector pills */
  .species-section {
    margin-bottom: var(--space-6);
  }
  .species-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0 0 var(--space-2) 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .species-help {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    line-height: var(--leading-relaxed);
    margin: 0 0 var(--space-3) 0;
  }
  .species-help code {
    background: var(--gray-100);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 0.9em;
  }
  .species-pills {
    display: flex;
    gap: var(--space-2);
  }
  .species-pill {
    padding: 8px 18px;
    border-radius: 999px;
    font-size: var(--text-sm);
    font-weight: 500;
    font-family: inherit;
    background: var(--surface-raised);
    color: var(--text-secondary);
    border: 1px solid var(--border-default);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .species-pill:hover {
    border-color: var(--color-primary);
    color: var(--text-primary);
  }
  .species-pill.active {
    background: var(--color-primary);
    color: white;
    border-color: var(--color-primary);
    font-weight: 600;
  }
</style>

