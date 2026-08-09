<script lang="ts">
  import { analysisState, resultsState, currentView } from '../stores/app';

  let isCancelling = false;

  // Two states the overlay can be in:
  //   - running: spinner + Cancel
  //   - finished-with-error: error banner + Dismiss [+ View partial results if any]
  $: hasFinishedWithError = !$analysisState.isRunning && !!$analysisState.error;
  /** True when at least one cohort succeeded (results were loaded). */
  $: hasAnyResults = $resultsState.sequences.length > 0 || $resultsState.cohortResults.length > 0;

  function handleCancel() {
    if (window.electronAPI && !isCancelling) {
      isCancelling = true;
      console.log('[ProgressOverlay] Cancelling pipeline...');

      // Hide UI immediately (optimistic update)
      analysisState.update(s => ({
        ...s,
        isRunning: false,
        error: 'Analysis cancelled by user'
      }));

      // Send cancel signal to backend
      window.electronAPI.cancelPipeline();
    }
  }

  function dismissError() {
    analysisState.update(s => ({ ...s, error: null }));
    isCancelling = false;
  }

  function viewPartialResults() {
    analysisState.update(s => ({ ...s, error: null }));
    currentView.set('results');
  }
</script>

<div class="overlay">
  <div class="progress-card" class:error-mode={hasFinishedWithError}>
    <div class="header">
      {#if hasFinishedWithError}
        <div class="error-icon">
          <svg width="24" height="24" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z"/>
          </svg>
        </div>
        <h2 class="title">Analysis Stopped</h2>
      {:else}
        <div class="spinner"></div>
        <h2 class="title">Running Analysis</h2>
      {/if}
    </div>

    {#if !hasFinishedWithError && $analysisState.progress}
      <div class="progress-info">
        <div class="stage-label">
          {$analysisState.progress.message}
        </div>
        <div class="progress-bar">
          <div
            class="progress-fill"
            style="width: {$analysisState.progress.percent}%"
          ></div>
        </div>
        <div class="progress-percent">
          {$analysisState.progress.percent}%
        </div>
      </div>
    {/if}

    <div class="logs-section">
      <div class="logs-header">
        <span class="logs-title">Activity Log</span>
        <span class="logs-count">{$analysisState.logs.length} entries</span>
      </div>
      <div class="logs-container">
        {#each $analysisState.logs.slice(-10) as log}
          <div class="log-entry" class:warn={log.level === 'warn'} class:error={log.level === 'error'}>
            <span class="log-level">{log.level}</span>
            <span class="log-message">{log.message}</span>
          </div>
        {/each}
      </div>
    </div>

    {#if $analysisState.error}
      <div class="error-banner">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z"/>
        </svg>
        <span>{$analysisState.error}</span>
      </div>
    {/if}

    <div class="actions">
      {#if hasFinishedWithError}
        {#if hasAnyResults}
          <button class="btn btn-primary" on:click={viewPartialResults}>
            View partial results
          </button>
        {/if}
        <button class="btn btn-secondary" on:click={dismissError}>
          Back to wizard
        </button>
      {:else}
        <button
          class="btn btn-secondary"
          on:click={handleCancel}
          disabled={isCancelling}
        >
          {isCancelling ? 'Cancelling...' : 'Cancel Analysis'}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(255, 255, 255, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 900; /* Lower than threshold dialog */
    animation: fadeIn var(--transition-fast) ease-out;
  }
  
  .progress-card {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-xl);
    padding: var(--space-8);
    width: 100%;
    max-width: 520px;
    box-shadow: var(--shadow-xl);
    animation: slideUp var(--transition-normal) ease-out;
  }
  
  .header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
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
  
  .title {
    font-size: var(--text-xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
  }
  
  .progress-info {
    margin-bottom: var(--space-6);
  }
  
  .stage-label {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin-bottom: var(--space-2);
  }
  
  .progress-bar {
    height: 8px;
    background: var(--gray-200);
    border-radius: var(--border-radius-full);
    overflow: hidden;
    margin-bottom: var(--space-2);
  }
  
  .progress-fill {
    height: 100%;
    background: var(--color-primary);
    border-radius: var(--border-radius-full);
    transition: width var(--transition-normal);
  }
  
  .progress-percent {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-tertiary);
    text-align: right;
  }
  
  .logs-section {
    background: var(--gray-50);
    border-radius: var(--border-radius-md);
    margin-bottom: var(--space-6);
    overflow: hidden;
  }
  
  .logs-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-light);
  }
  
  .logs-title {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  .logs-count {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  
  .logs-container {
    max-height: 160px;
    overflow-y: auto;
    padding: var(--space-2);
  }
  
  .log-entry {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
  
  .log-level {
    flex-shrink: 0;
    padding: 0 var(--space-1);
    border-radius: 2px;
    background: var(--gray-200);
    color: var(--text-tertiary);
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.05em;
  }
  
  .log-entry.warn .log-level {
    background: var(--color-warning-light);
    color: var(--color-warning);
  }
  
  .log-entry.error .log-level {
    background: var(--color-error-light);
    color: var(--color-error);
  }
  
  .log-message {
    color: var(--text-secondary);
    word-break: break-word;
  }
  
  .actions {
    display: flex;
    justify-content: center;
    gap: var(--space-3);
  }

  .progress-card.error-mode {
    border-color: var(--color-error-light);
  }

  .error-icon {
    color: var(--color-error);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .error-banner {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--color-error-light);
    color: var(--color-error);
    border-radius: var(--border-radius-md);
    font-size: var(--text-sm);
  }
  
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
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
</style>

