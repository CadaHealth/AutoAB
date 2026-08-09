<script lang="ts">
  import type { LongitudinalGroupData } from '../../utils/repertoire-metrics';

  export let data: LongitudinalGroupData[] = [];
  export let topN = 20;

  interface CloneSummary {
    cloneId: number;
    status: 'persistent' | 'expanding' | 'contracting' | 'transient';
    totalSize: number;
    firstSize: number;
    lastSize: number;
    foldChange: number;
    timepointPresence: boolean[];
  }

  function computeSummaries(groups: LongitudinalGroupData[]): { groupName: string; groupColor: string; clones: CloneSummary[] }[] {
    return groups.map(grp => {
      const clones: CloneSummary[] = grp.trackedClones.slice(0, topN).map(c => {
        const sizes = c.timepointSizes.map(t => t.size);
        const firstNonZero = sizes.find(s => s > 0) ?? 0;
        const lastNonZero = [...sizes].reverse().find(s => s > 0) ?? 0;
        const fc = firstNonZero > 0 ? lastNonZero / firstNonZero : (lastNonZero > 0 ? Infinity : 0);
        const presence = sizes.map(s => s > 0);
        let status: CloneSummary['status'] = 'transient';
        if (c.persistent) status = 'persistent';
        else if (c.expanding) status = 'expanding';
        else if (c.contracting) status = 'contracting';
        return { cloneId: c.cloneId, status, totalSize: c.totalSize, firstSize: firstNonZero, lastSize: lastNonZero, foldChange: fc, timepointPresence: presence };
      });
      return { groupName: grp.groupName, groupColor: grp.groupColor, clones };
    });
  }

  $: summaries = computeSummaries(data);

  function statusColor(s: CloneSummary['status']): string {
    switch (s) {
      case 'persistent': return '#0A8754';
      case 'expanding': return '#E85D04';
      case 'contracting': return '#DC2626';
      case 'transient': return '#9BA3AF';
    }
  }
  function statusLabel(s: CloneSummary['status']): string {
    switch (s) {
      case 'persistent': return 'Persistent';
      case 'expanding': return 'Expanding';
      case 'contracting': return 'Contracting';
      case 'transient': return 'Transient';
    }
  }
  function foldStr(fc: number): string {
    if (!isFinite(fc)) return 'new';
    if (fc === 0) return 'lost';
    return fc >= 1 ? `${fc.toFixed(1)}x` : `${fc.toFixed(2)}x`;
  }
</script>

<div class="expansion-container">
  {#each summaries as grp}
    <div class="group-block">
      <h4 class="group-title" style="color: {grp.groupColor}">{grp.groupName}</h4>
      {#if grp.clones.length === 0}
        <p class="no-data">No clones tracked</p>
      {:else}
        <div class="clone-table">
          <div class="table-header">
            <span class="col-clone">Clone</span>
            <span class="col-status">Status</span>
            <span class="col-size">Total</span>
            <span class="col-fc">Fold Change</span>
            <span class="col-presence">Timepoints</span>
          </div>
          {#each grp.clones as clone}
            <div class="table-row">
              <span class="col-clone mono">#{clone.cloneId}</span>
              <span class="col-status">
                <span class="status-badge" style="background: {statusColor(clone.status)}">{statusLabel(clone.status)}</span>
              </span>
              <span class="col-size">{clone.totalSize}</span>
              <span class="col-fc" class:expanding={clone.foldChange > 1} class:contracting={clone.foldChange < 1 && clone.foldChange > 0}>
                {foldStr(clone.foldChange)}
              </span>
              <span class="col-presence">
                {#each clone.timepointPresence as present}
                  <span class="tp-dot" class:present></span>
                {/each}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  {#if summaries.length === 0}
    <p class="no-data">Organize files into groups with multiple timepoints to see expansion dynamics.</p>
  {/if}
</div>

<style>
  .expansion-container {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 16px);
  }
  .group-block {
    border: 1px solid var(--border-light, #E8EAED);
    border-radius: var(--border-radius-md, 8px);
    padding: var(--space-3, 12px);
    background: var(--gray-50, #FAFBFC);
  }
  .group-title {
    margin: 0 0 var(--space-2, 8px) 0;
    font-size: var(--text-sm, 13px);
    font-weight: var(--font-semibold, 600);
  }
  .no-data {
    color: var(--text-tertiary, #9BA3AF);
    font-size: var(--text-xs, 11px);
    text-align: center;
    padding: var(--space-4, 16px);
  }
  .clone-table {
    display: flex;
    flex-direction: column;
    font-size: var(--text-xs, 11px);
  }
  .table-header {
    display: flex;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid var(--border-light, #E8EAED);
    font-weight: var(--font-semibold, 600);
    color: var(--text-tertiary, #9BA3AF);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-size: 10px;
  }
  .table-row {
    display: flex;
    align-items: center;
    padding: 5px 0;
    border-bottom: 1px solid var(--gray-100, #F4F5F7);
  }
  .table-row:last-child { border-bottom: none; }
  .col-clone { width: 70px; }
  .col-status { width: 100px; }
  .col-size { width: 60px; text-align: right; }
  .col-fc { width: 80px; text-align: right; padding-right: 8px; }
  .col-fc.expanding { color: #E85D04; font-weight: 600; }
  .col-fc.contracting { color: #DC2626; font-weight: 600; }
  .col-presence { flex: 1; display: flex; gap: 3px; }
  .mono { font-family: var(--font-mono, monospace); }
  .status-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 9px;
    color: #fff;
    font-size: 10px;
    font-weight: 600;
  }
  .tp-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--gray-200, #E8EAED);
  }
  .tp-dot.present {
    background: var(--color-primary, #0066CC);
  }
</style>
