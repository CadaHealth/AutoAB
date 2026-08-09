<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  /** Single-value mode (legacy/single-cohort) */
  export let calculatedValue: number = 0;

  /** Multi-timepoint mode: array of {label, calculated} */
  export let timepointThresholds: { label: string; calculated: number }[] = [];

  /** Optional cohort label shown in the dialog title when running multi-cohort */
  export let cohortLabel: string = '';

  /** Distribution plot images as base64 PNGs, keyed by timepoint label */
  export let distributionPlots: Record<string, string> = {};

  const dispatch = createEventDispatcher<{
    confirm: number | Record<string, number>;
  }>();

  // Determine mode
  $: isMulti = timepointThresholds.length > 0 && timepointThresholds[0]?.label !== '_global';

  // Single-value state
  let singleInput = calculatedValue.toFixed(4);

  // Multi-value state: one input per timepoint
  let tpInputs: Record<string, string> = {};
  $: {
    if (isMulti && Object.keys(tpInputs).length === 0) {
      for (const tp of timepointThresholds) {
        tpInputs[tp.label] = tp.calculated.toFixed(4);
      }
      tpInputs = { ...tpInputs };
    }
  }

  // Which plot is expanded (null = none)
  let expandedPlot: string | null = null;

  function togglePlot(label: string) {
    expandedPlot = expandedPlot === label ? null : label;
  }

  // Single-mode: check for _global plot
  $: singlePlot = distributionPlots['_global'] || '';
  // Has any plots at all?
  $: hasPlots = Object.keys(distributionPlots).length > 0;

  let applyToAll = false;
  let applyAllValue = '';
  let error = '';

  function handleSubmit() {
    error = '';

    if (isMulti) {
      const thresholds: Record<string, number> = {};

      if (applyToAll) {
        const parsed = parseFloat(applyAllValue);
        if (isNaN(parsed) || parsed < 0 || parsed > 1) {
          error = 'Please enter a valid number between 0 and 1';
          return;
        }
        for (const tp of timepointThresholds) {
          thresholds[tp.label] = parsed;
        }
      } else {
        for (const tp of timepointThresholds) {
          const parsed = parseFloat(tpInputs[tp.label] || '');
          if (isNaN(parsed) || parsed < 0 || parsed > 1) {
            error = `Invalid value for ${tp.label}: must be between 0 and 1`;
            return;
          }
          thresholds[tp.label] = parsed;
        }
      }

      dispatch('confirm', thresholds);
    } else {
      const parsed = parseFloat(singleInput);
      if (isNaN(parsed) || parsed < 0 || parsed > 1) {
        error = 'Please enter a valid number between 0 and 1';
        return;
      }
      dispatch('confirm', parsed);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleSubmit();
  }
</script>

<div class="modal-overlay" on:keydown={handleKeydown}>
  <div class="modal" class:wide={hasPlots} role="dialog" aria-modal="true">
    <div class="modal-header">
      <h2 class="modal-title">Distance Threshold</h2>
      {#if cohortLabel}
        <span class="cohort-badge">{cohortLabel}</span>
      {/if}
    </div>

    <div class="modal-body">
      {#if isMulti}
        <p class="calculated-info">
          Calculated thresholds per timepoint{cohortLabel ? ` for ${cohortLabel}` : ''} for clone definition:
        </p>

        <div class="tp-table">
          <div class="tp-row tp-header-row">
            <span class="tp-cell tp-label-cell">Timepoint</span>
            <span class="tp-cell tp-calc-cell">Calculated</span>
            <span class="tp-cell tp-input-cell">Custom</span>
            {#if hasPlots}
              <span class="tp-cell tp-plot-cell">Distribution</span>
            {/if}
          </div>
          {#each timepointThresholds as tp (tp.label)}
            <div class="tp-row">
              <span class="tp-cell tp-label-cell tp-name">{tp.label}</span>
              <span class="tp-cell tp-calc-cell tp-value">{tp.calculated.toFixed(4)}</span>
              <span class="tp-cell tp-input-cell">
                <input
                  type="text"
                  class="tp-input"
                  bind:value={tpInputs[tp.label]}
                  placeholder={tp.calculated.toFixed(4)}
                  disabled={applyToAll}
                />
              </span>
              {#if hasPlots}
                <span class="tp-cell tp-plot-cell">
                  {#if distributionPlots[tp.label]}
                    <button class="plot-toggle" class:active={expandedPlot === tp.label} on:click={() => togglePlot(tp.label)} title="Show distribution plot">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="1" y="10" width="3" height="5" rx="0.5" fill="currentColor" opacity="0.3"/>
                        <rect x="5" y="6" width="3" height="9" rx="0.5" fill="currentColor" opacity="0.5"/>
                        <rect x="9" y="3" width="3" height="12" rx="0.5" fill="currentColor" opacity="0.7"/>
                        <rect x="13" y="7" width="2" height="8" rx="0.5" fill="currentColor" opacity="0.4"/>
                      </svg>
                    </button>
                  {:else}
                    <span class="no-plot">-</span>
                  {/if}
                </span>
              {/if}
            </div>
            {#if expandedPlot === tp.label && distributionPlots[tp.label]}
              <div class="plot-row">
                <div class="plot-container">
                  <img src="data:image/png;base64,{distributionPlots[tp.label]}" alt="Distance distribution for {tp.label}" class="plot-image" />
                  <div class="plot-caption">
                    Hamming distance distribution for <strong>{tp.label}</strong>, threshold at <strong>{tp.calculated.toFixed(4)}</strong>
                  </div>
                </div>
              </div>
            {/if}
          {/each}
        </div>

        <label class="apply-all-label">
          <input type="checkbox" bind:checked={applyToAll} />
          Apply a single value to all timepoints:
          {#if applyToAll}
            <input
              type="text"
              class="apply-all-input"
              bind:value={applyAllValue}
              placeholder="0.0 to 1.0"
              autofocus
            />
          {/if}
        </label>
      {:else}
        <p class="calculated-info">
          The calculated optimal threshold{cohortLabel ? ` for ${cohortLabel}` : ''} for clone definition is:
        </p>
        <div class="calculated-value">
          {calculatedValue.toFixed(4)}
        </div>

        {#if singlePlot}
          <div class="single-plot-container">
            <img src="data:image/png;base64,{singlePlot}" alt="Distance distribution" class="plot-image" />
            <div class="plot-caption">
              Hamming distance distribution, threshold at <strong>{calculatedValue.toFixed(4)}</strong>
            </div>
          </div>
        {/if}

        <div class="input-section">
          <label for="threshold-input" class="input-label">
            Enter a custom value (0 to 1) or use the calculated threshold:
          </label>
          <input
            id="threshold-input"
            type="text"
            class="input"
            bind:value={singleInput}
            placeholder="0.0 to 1.0"
            autofocus
          />
        </div>
      {/if}

      {#if error}
        <p class="error-text">{error}</p>
      {/if}
    </div>

    <div class="modal-actions">
      <button class="btn btn-primary" on:click={handleSubmit}>
        Apply
      </button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fadeIn var(--transition-fast) ease-out;
  }

  .modal {
    background: var(--surface-raised);
    border-radius: var(--border-radius-xl);
    padding: var(--space-6);
    max-width: 540px;
    width: 90%;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: var(--shadow-xl);
    animation: slideUp var(--transition-normal) ease-out;
  }

  .modal.wide {
    max-width: 680px;
  }

  .modal-header {
    margin-bottom: var(--space-4);
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .modal-title {
    font-size: var(--text-xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
  }

  .cohort-badge {
    display: inline-flex;
    align-items: center;
    padding: var(--space-1) var(--space-3);
    background: var(--color-primary-light);
    color: var(--color-primary);
    border-radius: var(--border-radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    white-space: nowrap;
  }

  .modal-body {
    margin-bottom: var(--space-6);
  }

  .calculated-info {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin: 0 0 var(--space-3) 0;
  }

  .calculated-value {
    font-family: var(--font-mono);
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--color-primary);
    background: var(--color-primary-light);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--border-radius-md);
    text-align: center;
    margin-bottom: var(--space-4);
  }

  .input-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .input-label {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .error-text {
    font-size: var(--text-xs);
    color: var(--color-error);
    margin: var(--space-2) 0 0;
  }

  .tp-table {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--gray-200);
    border-radius: var(--border-radius-md);
    overflow: hidden;
    margin-bottom: var(--space-4);
  }

  .tp-row {
    display: grid;
    grid-template-columns: 1fr 100px 120px;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-primary);
    align-items: center;
  }

  /* Wider grid when plots column is present */
  .tp-table:has(.tp-plot-cell) .tp-row {
    grid-template-columns: 1fr 100px 120px 80px;
  }

  .tp-header-row {
    background: var(--gray-50);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .tp-name {
    font-weight: var(--font-medium);
    color: var(--text-primary);
  }

  .tp-value {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-primary);
    font-weight: var(--font-semibold);
  }

  .tp-input {
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--gray-300);
    border-radius: var(--border-radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    background: var(--surface-primary);
    color: var(--text-primary);
  }

  .tp-input:disabled {
    opacity: 0.4;
    background: var(--gray-100);
  }

  .tp-plot-cell {
    text-align: center;
  }

  .plot-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 26px;
    border: 1px solid var(--gray-300);
    border-radius: var(--border-radius-sm);
    background: var(--surface-primary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .plot-toggle:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
    background: var(--color-primary-light);
  }

  .plot-toggle.active {
    border-color: var(--color-primary);
    color: var(--color-primary);
    background: var(--color-primary-light);
  }

  .no-plot {
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .plot-row {
    grid-column: 1 / -1;
    background: var(--gray-50);
    padding: var(--space-3);
    animation: plotExpand 0.2s ease-out;
  }

  .plot-container, .single-plot-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }

  .single-plot-container {
    margin-bottom: var(--space-4);
    padding: var(--space-3);
    background: var(--gray-50);
    border-radius: var(--border-radius-md);
    border: 1px solid var(--border-light);
  }

  .plot-image {
    max-width: 100%;
    height: auto;
    border-radius: var(--border-radius-sm);
    border: 1px solid var(--border-light);
    background: white;
  }

  .plot-caption {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-align: center;
  }

  .apply-all-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .apply-all-input {
    width: 80px;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--gray-300);
    border-radius: var(--border-radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .modal-actions {
    display: flex;
    gap: var(--space-3);
    justify-content: flex-end;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes plotExpand {
    from { opacity: 0; max-height: 0; }
    to { opacity: 1; max-height: 500px; }
  }
</style>
