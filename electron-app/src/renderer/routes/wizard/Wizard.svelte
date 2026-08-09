<script lang="ts">
  import { onMount } from 'svelte';
  import { wizardState, analysisState } from '../../lib/stores/app';
  import Stepper from '../../lib/components/Stepper.svelte';
  import DefineStudy from './DefineStudy.svelte';
  import ChooseDatabase from './ChooseDatabase.svelte';
  import ReviewStart from './ReviewStart.svelte';
  import ProgressOverlay from '../../lib/components/ProgressOverlay.svelte';
  
  const steps = [
    { number: 1, label: 'Define Study' },
    { number: 2, label: 'Choose Database' },
    { number: 3, label: 'Review & Start' }
  ];

  onMount(async () => {
    // Auto-populate bundled CoV-AbDab database if not already set
    if (!$wizardState.covAbdabPath && window.electronAPI) {
      try {
        const covidDbPath = await window.electronAPI.getCovidDatabase();
        if (covidDbPath) {
          wizardState.update(s => ({ ...s, covAbdabPath: covidDbPath }));
          console.log('[Wizard] Auto-populated CoV-AbDab database:', covidDbPath);
        }
      } catch (error) {
        console.warn('[Wizard] Could not load bundled CoV-AbDab database:', error);
      }
    }
  });
</script>

<div class="wizard">
  <!-- Sidebar with stepper -->
  <aside class="wizard-sidebar">
    <div class="sidebar-content">
      <div class="brand">
        <div class="brand-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="2"/>
            <circle cx="16" cy="16" r="6" fill="currentColor"/>
            <path d="M16 4V8M16 24V28M4 16H8M24 16H28" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="brand-text">
          <span class="brand-name">Clono</span>
          <span class="brand-version">v1.0.0</span>
        </div>
      </div>
      
      <Stepper {steps} currentStep={$wizardState.step} />
      
      <div class="sidebar-footer">
        <p class="help-text">
          Need help? Check the
          <a href="#" class="link">documentation</a>
        </p>
      </div>
    </div>
  </aside>
  
  <!-- Main content area -->
  <main class="wizard-main">
    <div class="wizard-content">
      {#if $wizardState.step === 1}
        <DefineStudy />
      {:else if $wizardState.step === 2}
        <ChooseDatabase />
      {:else if $wizardState.step === 3}
        <ReviewStart />
      {/if}
    </div>
  </main>
  
  <!-- Progress overlay: visible while running OR while an unread error is still
       posted (so the user actually sees what went wrong instead of being silently
       dropped back to the wizard). -->
  {#if $analysisState.isRunning || $analysisState.error}
    <ProgressOverlay />
  {/if}
</div>

<style>
  .wizard {
    display: flex;
    flex: 1;
    height: 100%;
    overflow: hidden;
  }
  
  .wizard-sidebar {
    width: 280px;
    background: var(--surface-raised);
    border-right: 1px solid var(--border-light);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  
  .sidebar-content {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--space-6);
  }
  
  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-10);
    padding-bottom: var(--space-6);
    border-bottom: 1px solid var(--border-light);
  }
  
  .brand-icon {
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-primary);
  }
  
  .brand-text {
    display: flex;
    flex-direction: column;
  }
  
  .brand-name {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  
  .brand-version {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  
  .sidebar-footer {
    margin-top: auto;
    padding-top: var(--space-6);
    border-top: 1px solid var(--border-light);
  }
  
  .help-text {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin: 0;
  }
  
  .link {
    color: var(--color-primary);
    text-decoration: none;
  }
  
  .link:hover {
    text-decoration: underline;
  }
  
  .wizard-main {
    flex: 1;
    overflow-y: auto;
    background: var(--gray-50);
  }
  
  .wizard-content {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--space-10);
  }
</style>

