<script lang="ts">
  interface Step {
    number: number;
    label: string;
  }
  
  export let steps: Step[] = [];
  export let currentStep: number = 1;
</script>

<nav class="stepper" aria-label="Progress">
  {#each steps as step, index}
    <div 
      class="step"
      class:active={step.number === currentStep}
      class:completed={step.number < currentStep}
    >
      <div class="step-indicator">
        {#if step.number < currentStep}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M11.5 4L5.5 10L2.5 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {:else}
          {step.number}
        {/if}
      </div>
      <span class="step-label">{step.label}</span>
    </div>
    
    {#if index < steps.length - 1}
      <div 
        class="step-connector"
        class:completed={step.number < currentStep}
      ></div>
    {/if}
  {/each}
</nav>

<style>
  .stepper {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  
  .step {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
  }
  
  .step-indicator {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--border-radius-full);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    background: var(--gray-100);
    color: var(--text-tertiary);
    transition: all var(--transition-normal);
    flex-shrink: 0;
  }
  
  .step.active .step-indicator {
    background: var(--color-primary);
    color: white;
    box-shadow: 0 0 0 4px var(--color-primary-light);
  }
  
  .step.completed .step-indicator {
    background: var(--color-success);
    color: white;
  }
  
  .step-label {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    transition: color var(--transition-fast);
  }
  
  .step.active .step-label {
    color: var(--text-primary);
    font-weight: var(--font-medium);
  }
  
  .step.completed .step-label {
    color: var(--text-secondary);
  }
  
  .step-connector {
    width: 2px;
    height: 24px;
    background: var(--gray-200);
    margin-left: 15px;
    transition: background var(--transition-normal);
  }
  
  .step-connector.completed {
    background: var(--color-success);
  }
</style>

