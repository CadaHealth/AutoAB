<script lang="ts">
  import type { ClonalDynamicsEntry, IsotypeTileEntry } from '../../utils/public-clones';
  import { ISOTYPE_COLORS, ISOTYPE_ORDER } from '../../utils/public-clones';
  import { exportHtmlAsPng } from '../../utils/export-figure';

  export let tileEntries: IsotypeTileEntry[] = [];
  export let timepointLabels: string[] = [];
  export let onCloneClick: (entry: ClonalDynamicsEntry, timepoint?: string) => void = () => {};
  export let dynamicsEntries: ClonalDynamicsEntry[] = [];
  export let cohortLabel: string = '';

  let tableContainer: HTMLElement;

  let hoveredCell: { row: number; col: number } | null = null;
  let tooltipText = '';
  let tooltipX = 0;
  let tooltipY = 0;

  $: hasAnyIsotypeData = tileEntries.some(e => e.tiles.some(t => t.dominantIsotype !== null));

  function getColor(isotype: string | null): string {
    if (!isotype) return 'var(--gray-200, #e8eaed)';
    return ISOTYPE_COLORS[isotype] ?? 'var(--gray-300, #d1d5db)';
  }

  function handleCellHover(e: MouseEvent, entry: IsotypeTileEntry, colIdx: number) {
    const tile = entry.tiles[colIdx];
    if (!tile || tile.seqCount === 0) {
      hoveredCell = null;
      return;
    }
    hoveredCell = { row: tileEntries.indexOf(entry), col: colIdx };
    const breakdownStr = Object.entries(tile.isotypeBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([iso, cnt]) => `${iso}: ${cnt}`)
      .join(', ');
    tooltipText = `${entry.cloneLabel} @ ${tile.timepointLabel}\n` +
      `Sequences: ${tile.seqCount}\n` +
      `Dominant: ${tile.dominantIsotype ?? 'N/A'}\n` +
      `Breakdown: ${breakdownStr || 'N/A'}\n` +
      `SHM: ${tile.meanSHM.toFixed(1)}`;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const container = (e.currentTarget as HTMLElement).closest('.isotype-tiles-container');
    const containerRect = container?.getBoundingClientRect() ?? rect;
    tooltipX = rect.left - containerRect.left + rect.width / 2;
    tooltipY = rect.top - containerRect.top - 4;
  }

  function handleCellClick(entry: IsotypeTileEntry, colIdx: number) {
    const dynEntry = dynamicsEntries.find(e => e.cloneLabel === entry.cloneLabel);
    if (dynEntry) {
      onCloneClick(dynEntry, timepointLabels[colIdx]);
    }
  }

  export async function exportPng() {
    if (!tableContainer) return;
    const name = cohortLabel ? `clonal_dynamics_isotype_${cohortLabel}.png` : 'clonal_dynamics_isotype.png';
    await exportHtmlAsPng(tableContainer, name);
  }
</script>

<div class="isotype-tiles-container" bind:this={tableContainer}>
  {#if tileEntries.length === 0}
    <div class="empty-state">No isotype data available.</div>
  {:else}
    {#if !hasAnyIsotypeData}
      <div class="no-isotype-banner">
        No C gene (isotype) annotation found in the current top clones. Try increasing the number of displayed clones, or run a fresh analysis if isotype data is missing entirely.
      </div>
    {/if}
    <div class="tiles-scroll">
      <table class="tiles-table">
        <thead>
          <tr>
            <th class="th-label">Clone</th>
            {#each timepointLabels as tp}
              <th class="th-tp">{tp}</th>
            {/each}
            <th class="th-shm">Avg SHM</th>
            <th class="th-patients">Patients</th>
          </tr>
        </thead>
        <tbody>
          {#each tileEntries as entry}
            <tr class="tile-row">
              <td class="td-label" title="{entry.vGene} / {entry.jGene}, {entry.cdr3Aa}">
                <span class="clone-label">{entry.cloneLabel}</span>
              </td>
              {#each entry.tiles as tile, colIdx}
                <td
                  class="td-tile"
                  class:absent={tile.seqCount === 0}
                  style="--tile-bg: {getColor(tile.dominantIsotype)}"
                  on:mouseenter={(e) => handleCellHover(e, entry, colIdx)}
                  on:mouseleave={() => hoveredCell = null}
                  on:click={() => handleCellClick(entry, colIdx)}
                >
                  {#if tile.seqCount > 0}
                    <span class="tile-count">{tile.seqCount}</span>
                  {/if}
                </td>
              {/each}
              <td class="td-shm">{entry.meanSHM.toFixed(1)}</td>
              <td class="td-patients">{entry.patientCount}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Legend -->
    <div class="isotype-legend">
      {#each ISOTYPE_ORDER as iso}
        <span class="legend-item">
          <span class="legend-swatch" style="background: {ISOTYPE_COLORS[iso]}"></span>
          {iso}
        </span>
      {/each}
      <span class="legend-item">
        <span class="legend-swatch absent-swatch"></span>
        Absent
      </span>
    </div>

    <!-- Tooltip -->
    {#if hoveredCell}
      <div class="iso-tooltip" style="left: {tooltipX}px; top: {tooltipY}px;">
        {#each tooltipText.split('\n') as line}
          <div>{line}</div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .isotype-tiles-container {
    position: relative;
    width: 100%;
    font-size: 12px;
  }
  .tiles-scroll {
    overflow-x: auto;
    overflow-y: visible;
  }
  .tiles-table {
    border-collapse: separate;
    border-spacing: 2px;
    width: 100%;
    min-width: max-content;
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--bg-primary, #fff);
    z-index: 2;
    padding: 4px 6px;
    font-weight: 600;
    font-size: 11px;
    color: var(--text-secondary, #6b7280);
    text-align: center;
    white-space: nowrap;
  }
  .th-label {
    text-align: left;
    min-width: 50px;
  }
  .th-tp { min-width: 50px; }
  .th-shm { min-width: 55px; }
  .th-patients { min-width: 50px; }

  .tile-row {
    cursor: pointer;
  }
  .tile-row:hover .td-tile:not(.absent) {
    filter: brightness(1.1);
  }
  .td-label {
    padding: 4px 6px;
    font-weight: 600;
    font-size: 11px;
    color: var(--text-primary, #1f2937);
    white-space: nowrap;
    text-align: left;
  }
  .clone-label {
    display: inline-block;
    min-width: 28px;
  }

  .td-tile {
    background: var(--tile-bg);
    text-align: center;
    padding: 4px 2px;
    border-radius: 3px;
    min-width: 40px;
    height: 28px;
    vertical-align: middle;
    transition: filter 0.1s;
    cursor: pointer;
  }
  .td-tile.absent {
    background: var(--gray-100, #f3f4f6);
    cursor: default;
  }
  .tile-count {
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    text-shadow: 0 0 3px rgba(0,0,0,0.4);
  }

  .td-shm, .td-patients {
    text-align: center;
    padding: 4px 6px;
    font-size: 11px;
    color: var(--text-secondary, #6b7280);
    white-space: nowrap;
  }

  .isotype-legend {
    display: flex;
    gap: 12px;
    padding: 8px 4px 4px;
    flex-wrap: wrap;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-secondary, #6b7280);
  }
  .legend-swatch {
    width: 12px;
    height: 12px;
    border-radius: 2px;
    display: inline-block;
  }
  .absent-swatch {
    background: var(--gray-100, #f3f4f6);
    border: 1px solid var(--gray-300, #d1d5db);
  }

  .iso-tooltip {
    position: absolute;
    transform: translate(-50%, -100%);
    background: var(--gray-900, #1f2937);
    color: #fff;
    font-size: 11px;
    padding: 6px 10px;
    border-radius: 6px;
    pointer-events: none;
    white-space: pre;
    z-index: 100;
    line-height: 1.4;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }

  .no-isotype-banner {
    background: #FFF8E1;
    border: 1px solid #FFE082;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 10px;
    color: #6D4C00;
    margin-bottom: 6px;
    line-height: 1.3;
  }

  .empty-state {
    text-align: center;
    padding: 24px;
    color: var(--text-secondary, #6b7280);
    font-size: 13px;
  }
</style>
