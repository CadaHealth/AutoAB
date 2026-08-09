<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  const dispatch = createEventDispatcher();
  const CORRECT_PASSWORD = 'ImmuneIntelligenceByClono';

  let password = '';
  let error = false;
  let shaking = false;

  function handleSubmit() {
    if (password === CORRECT_PASSWORD) {
      sessionStorage.setItem('demo_authenticated', '1');
      dispatch('authenticated');
    } else {
      error = true;
      shaking = true;
      setTimeout(() => { shaking = false; }, 500);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleSubmit();
    if (error) error = false;
  }
</script>

<div class="gate-overlay">
  <div class="gate-card" class:shaking>
    <div class="gate-logo">
      <h1 class="gate-title">Clono</h1>
      <p class="gate-subtitle">B-Cell Repertoire Analysis</p>
    </div>

    <div class="gate-form">
      <p class="gate-label">Enter password to access the demo</p>
      <input
        type="password"
        class="gate-input"
        class:gate-input-error={error}
        bind:value={password}
        on:keydown={handleKeydown}
        placeholder="Password"
        autofocus
      />
      {#if error}
        <p class="gate-error">Incorrect password</p>
      {/if}
      <button class="gate-button" on:click={handleSubmit}>
        Access Demo
      </button>
    </div>
  </div>
</div>

<style>
  .gate-overlay {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
  }

  .gate-card {
    background: white;
    border-radius: 16px;
    padding: 48px 40px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08), 0 1px 4px rgba(0, 0, 0, 0.04);
    width: 100%;
    max-width: 380px;
    text-align: center;
  }

  .gate-card.shaking {
    animation: shake 0.4s ease-in-out;
  }

  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-8px); }
    40% { transform: translateX(8px); }
    60% { transform: translateX(-6px); }
    80% { transform: translateX(6px); }
  }

  .gate-logo {
    margin-bottom: 32px;
  }

  .gate-title {
    font-size: 28px;
    font-weight: 700;
    color: #1e293b;
    margin: 0 0 4px;
    letter-spacing: -0.02em;
  }

  .gate-subtitle {
    font-size: 14px;
    color: #64748b;
    margin: 0;
  }

  .gate-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .gate-label {
    font-size: 13px;
    color: #475569;
    margin: 0;
  }

  .gate-input {
    width: 100%;
    padding: 10px 14px;
    border: 1.5px solid #e2e8f0;
    border-radius: 8px;
    font-size: 15px;
    color: #1e293b;
    outline: none;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }

  .gate-input:focus {
    border-color: #4F46E5;
    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
  }

  .gate-input-error {
    border-color: #ef4444;
  }

  .gate-input-error:focus {
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
  }

  .gate-error {
    font-size: 13px;
    color: #ef4444;
    margin: -4px 0 0;
  }

  .gate-button {
    width: 100%;
    padding: 10px;
    background: #4F46E5;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
    margin-top: 4px;
  }

  .gate-button:hover {
    background: #4338CA;
  }

  .gate-button:active {
    background: #3730A3;
  }
</style>
