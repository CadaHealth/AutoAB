<script lang="ts">
  /**
   * Setup screen: what AutoAB needs, what is already there, and a button for
   * everything it can install itself.
   *
   * Shown automatically at launch when something required is missing, and
   * reachable afterwards so a user can re-check without restarting.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';

  export let dismissible = false;

  const dispatch = createEventDispatcher<{ close: void; ready: void }>();

  type FixAction = 'install-rosetta' | 'install-r-packages' | 'download-r';

  interface DependencyItem {
    id: string;
    label: string;
    status: 'ok' | 'missing' | 'error';
    required: boolean;
    detail?: string;
    problem?: string;
    fix?: FixAction;
  }

  interface DependencyReport {
    ok: boolean;
    items: DependencyItem[];
    platform: string;
    arch: string;
  }

  let report: DependencyReport | null = null;
  let checking = true;
  let busyFix: FixAction | null = null;
  let log: string[] = [];
  let fixMessage = '';
  let fixFailed = false;
  let logEl: HTMLDivElement;
  let cleanup: (() => void) | null = null;

  const FIX_LABELS: Record<FixAction, string> = {
    'install-rosetta': 'Install Rosetta 2',
    'install-r-packages': 'Install R packages',
    'download-r': 'Download R',
  };

  async function check() {
    checking = true;
    try {
      report = await window.electronAPI.checkDependencies();
      if (report?.ok) dispatch('ready');
    } catch (e) {
      report = null;
      fixMessage = `Could not inspect dependencies: ${e}`;
      fixFailed = true;
    } finally {
      checking = false;
    }
  }

  async function runFix(fix: FixAction) {
    if (fix === 'download-r') {
      await window.electronAPI.openRDownloadPage();
      // Nothing to poll for, the user installs R outside the app and comes
      // back to re-check.
      return;
    }

    busyFix = fix;
    log = [];
    fixMessage = '';
    fixFailed = false;
    try {
      const result = await window.electronAPI.runDependencyFix(fix);
      fixMessage = result.message;
      fixFailed = !result.success;
      if (result.success) await check();
    } catch (e) {
      fixMessage = String(e);
      fixFailed = true;
    } finally {
      busyFix = null;
    }
  }

  function statusIcon(status: string): string {
    return status === 'ok' ? '✓' : status === 'missing' ? '!' : '×';
  }

  onMount(() => {
    cleanup = window.electronAPI.onDependencyFixLog((line: string) => {
      log = [...log.slice(-400), line];
      // Follow the tail while an installer is running.
      queueMicrotask(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
    });
    check();
  });

  onDestroy(() => cleanup?.());

  $: blocking = report ? report.items.filter(i => i.required && i.status !== 'ok') : [];
  $: fine = report ? report.items.filter(i => i.status === 'ok') : [];
</script>

<div class="gate">
  <div class="panel">
    <header>
      <h1>Setup</h1>
      <p class="lede">
        AutoAB brings its own analysis engine, aligner and reference databases.
        R is the one component it cannot ship, because it is not redistributable
        in a relocatable form.
      </p>
    </header>

    {#if checking && !report}
      <p class="checking">Checking what is installed…</p>
    {:else if report}
      {#if blocking.length === 0}
        <div class="verdict ok">
          <strong>Everything is ready.</strong>
          You can close this and start an analysis.
        </div>
      {:else}
        <div class="verdict blocked">
          <strong>{blocking.length} {blocking.length === 1 ? 'item needs' : 'items need'} attention</strong>
          before an analysis can run.
        </div>
      {/if}

      <ul class="items">
        {#each report.items as item (item.id)}
          <li class="item {item.status}">
            <span class="badge" aria-hidden="true">{statusIcon(item.status)}</span>
            <div class="body">
              <div class="label">
                {item.label}
                {#if !item.required}<span class="optional">optional</span>{/if}
              </div>
              {#if item.status === 'ok'}
                {#if item.detail}<div class="detail">{item.detail}</div>{/if}
              {:else}
                <div class="problem">{item.problem}</div>
                {#if item.detail}<div class="detail muted">{item.detail}</div>{/if}
              {/if}
            </div>
            {#if item.status !== 'ok' && item.fix}
              <button
                class="fix"
                disabled={busyFix !== null}
                on:click={() => runFix(item.fix)}
              >
                {busyFix === item.fix ? 'Working…' : FIX_LABELS[item.fix]}
              </button>
            {/if}
          </li>
        {/each}
      </ul>

      {#if log.length}
        <div class="log" bind:this={logEl}>
          {#each log as line}<div class="line">{line}</div>{/each}
        </div>
      {/if}

      {#if fixMessage}
        <p class="fix-message" class:failed={fixFailed}>{fixMessage}</p>
      {/if}

      <footer>
        <button class="secondary" on:click={check} disabled={checking || busyFix !== null}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
        {#if blocking.length === 0 || dismissible}
          <button class="primary" on:click={() => dispatch('close')}>
            {blocking.length === 0 ? 'Continue' : 'Continue anyway'}
          </button>
        {/if}
      </footer>

      {#if blocking.length > 0 && dismissible}
        <p class="warning">
          Running without these will stop the analysis partway through rather
          than producing partial results.
        </p>
      {/if}
    {:else}
      <p class="fix-message failed">{fixMessage}</p>
      <footer>
        <button class="secondary" on:click={check}>Try again</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .gate {
    position: fixed;
    inset: 0;
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 23, 42, 0.55);
    backdrop-filter: blur(3px);
    padding: 24px;
  }

  .panel {
    width: min(720px, 100%);
    max-height: 90vh;
    overflow-y: auto;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    padding: 28px 32px 24px;
  }

  h1 {
    margin: 0 0 6px;
    font-size: 22px;
    font-weight: 650;
    color: #0f172a;
  }

  .lede {
    margin: 0 0 20px;
    font-size: 13.5px;
    line-height: 1.55;
    color: #475569;
  }

  .checking {
    color: #64748b;
    font-size: 14px;
    padding: 20px 0;
  }

  .verdict {
    border-radius: 8px;
    padding: 11px 14px;
    font-size: 13.5px;
    margin-bottom: 18px;
  }
  .verdict.ok { background: #ecfdf5; color: #065f46; }
  .verdict.blocked { background: #fff7ed; color: #9a3412; }
  .verdict strong { font-weight: 620; }

  .items {
    list-style: none;
    margin: 0 0 18px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 4px;
    border-bottom: 1px solid #f1f5f9;
  }
  .item:last-child { border-bottom: none; }

  .badge {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 700;
    margin-top: 1px;
  }
  .item.ok .badge { background: #d1fae5; color: #047857; }
  .item.missing .badge { background: #fed7aa; color: #9a3412; }
  .item.error .badge { background: #fecaca; color: #b91c1c; }

  .body { flex: 1 1 auto; min-width: 0; }

  .label {
    font-size: 14px;
    font-weight: 600;
    color: #0f172a;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .optional {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #64748b;
    background: #f1f5f9;
    padding: 1px 6px;
    border-radius: 4px;
  }

  .problem {
    font-size: 13px;
    line-height: 1.5;
    color: #9a3412;
    margin-top: 3px;
  }

  .detail {
    font-size: 12px;
    color: #64748b;
    margin-top: 3px;
    word-break: break-word;
  }
  .detail.muted {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: #94a3b8;
  }

  .fix {
    flex: 0 0 auto;
    align-self: center;
    background: #2563eb;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 7px 13px;
    font-size: 12.5px;
    font-weight: 550;
    cursor: pointer;
  }
  .fix:hover:not(:disabled) { background: #1d4ed8; }
  .fix:disabled { opacity: 0.5; cursor: default; }

  .log {
    max-height: 190px;
    overflow-y: auto;
    background: #0f172a;
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 14px;
  }
  .line {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.5;
    color: #cbd5e1;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .fix-message {
    font-size: 13px;
    color: #047857;
    margin: 0 0 14px;
  }
  .fix-message.failed { color: #b91c1c; }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 4px;
  }

  button.primary,
  button.secondary {
    border-radius: 6px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 550;
    cursor: pointer;
  }
  button.primary { background: #2563eb; color: #fff; border: none; }
  button.primary:hover { background: #1d4ed8; }
  button.secondary { background: #fff; color: #334155; border: 1px solid #cbd5e1; }
  button.secondary:hover:not(:disabled) { background: #f8fafc; }
  button:disabled { opacity: 0.55; cursor: default; }

  .warning {
    margin: 12px 0 0;
    font-size: 12px;
    color: #9a3412;
    text-align: right;
  }
</style>
