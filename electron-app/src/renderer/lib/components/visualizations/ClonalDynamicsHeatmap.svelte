<script lang="ts">
  import type { ClonalDynamicsEntry, ClonalStatus } from '../../utils/public-clones';
  import { exportSvgAsPng } from '../../utils/export-figure';

  export let entries: ClonalDynamicsEntry[] = [];
  export let timepointLabels: string[] = [];
  export let timepointTotals: { label: string; total: number }[] = [];
  export let onCloneClick: (entry: ClonalDynamicsEntry, timepoint?: string) => void = () => {};
  export let cohortLabel: string = '';

  let svgEl: SVGSVGElement;

  export async function exportPng() {
    if (!svgEl) return;
    const name = cohortLabel ? `clonal_dynamics_heatmap_${cohortLabel}.png` : 'clonal_dynamics_heatmap.png';
    await exportSvgAsPng(svgEl, name);
  }

  let hoveredCell: { row: number; col: number } | null = null;
  let selectedRow: number | null = null;
  let selectedCol: number | null = null;

  // Layout
  const cellW = 72;
  const cellH = 32;
  const labelWidth = 48;
  const badgeWidth = 110;
  const headerHeight = 70;
  const padding = 8;

  $: svgWidth = labelWidth + timepointLabels.length * cellW + badgeWidth + padding * 2;
  $: svgHeight = headerHeight + entries.length * cellH + padding * 2;

  // Color scale based on frequency (not raw counts)
  $: maxFreq = Math.max(0.001, ...entries.flatMap(e => e.timepointSizes.map(t => t.frequency)));

  function getColor(freq: number): string {
    if (freq === 0) return '#f8f9fa';
    const intensity = Math.min(freq / maxFreq, 1);
    const r = Math.round(235 - intensity * 175);
    const g = Math.round(240 - intensity * 160);
    const b = Math.round(255 - intensity * 40);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function formatFreq(freq: number): string {
    if (freq === 0) return '';
    const pct = freq * 100;
    if (pct >= 10) return pct.toFixed(0) + '%';
    if (pct >= 1) return pct.toFixed(1) + '%';
    if (pct >= 0.1) return pct.toFixed(2) + '%';
    return '<0.1%';
  }

  function formatTotal(n: number): string {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function getTpTotal(label: string): number {
    return timepointTotals.find(t => t.label === label)?.total ?? 0;
  }

  const statusConfig: Record<ClonalStatus, { label: string; color: string; bg: string }> = {
    persistent:    { label: 'Persistent',     color: '#1565C0', bg: '#E3F2FD' },
    expanding:     { label: 'Expanding',      color: '#2E7D32', bg: '#E8F5E9' },
    contracting:   { label: 'Contracting',    color: '#C62828', bg: '#FFEBEE' },
    disappeared:   { label: 'Disappeared',    color: '#616161', bg: '#F5F5F5' },
    late_emerging: { label: 'Late emerging',  color: '#E65100', bg: '#FFF3E0' },
    transient:     { label: 'Transient',      color: '#7B1FA2', bg: '#F3E5F5' }
  };

  function handleRowClick(index: number, colIndex?: number) {
    selectedRow = index;
    selectedCol = colIndex ?? null;
    const tp = colIndex != null ? timepointLabels[colIndex] : undefined;
    onCloneClick(entries[index], tp);
  }
</script>

<div class="dynamics-heatmap-container">
  <div class="norm-note">
    Values show clone frequency (% of timepoint repertoire), normalized for sequencing depth.
  </div>

  {#if entries.length === 0}
    <div class="empty-msg">
      No multi-timepoint clones or lineages found.
    </div>
  {:else}
    <svg bind:this={svgEl} width={svgWidth} height={svgHeight} viewBox="0 0 {svgWidth} {svgHeight}">
      <!-- Column headers: timepoint labels -->
      {#each timepointLabels as tp, j}
        <text
          x={labelWidth + j * cellW + cellW / 2}
          y={24}
          text-anchor="middle"
          class="header-label"
        >
          {tp}
        </text>
        <!-- Totals row below header -->
        <text
          x={labelWidth + j * cellW + cellW / 2}
          y={42}
          text-anchor="middle"
          class="totals-label"
        >
          n={formatTotal(getTpTotal(tp))}
        </text>
      {/each}

      <!-- "Status" header -->
      <text
        x={labelWidth + timepointLabels.length * cellW + badgeWidth / 2}
        y={24}
        text-anchor="middle"
        class="header-label"
      >
        Status
      </text>

      <!-- Separator line below header -->
      <line
        x1={labelWidth - 10}
        y1={headerHeight - 8}
        x2={labelWidth + timepointLabels.length * cellW + badgeWidth}
        y2={headerHeight - 8}
        stroke="#E8EAED"
        stroke-width="1"
      />

      <!-- Rows -->
      {#each entries as entry, i}
        {@const rowY = headerHeight + i * cellH}

        <!-- Row background -->
        <rect
          x="0"
          y={rowY}
          width={svgWidth}
          height={cellH}
          fill={selectedRow === i ? '#EDF2FA' : (i % 2 === 0 ? '#ffffff' : '#fafbfc')}
          class="row-bg"
          on:click={() => handleRowClick(i, undefined)}
        />

        <!-- Clone label (Y-axis) -->
        <text
          x={labelWidth - 8}
          y={rowY + cellH / 2}
          text-anchor="end"
          dominant-baseline="middle"
          class="row-label"
          on:click={() => handleRowClick(i)}
        >
          {entry.cloneLabel}
        </text>

        <!-- Cells: show frequency -->
        {#each entry.timepointSizes as tpSize, j}
          <rect
            x={labelWidth + j * cellW + 2}
            y={rowY + 2}
            width={cellW - 4}
            height={cellH - 4}
            rx="4"
            ry="4"
            fill={getColor(tpSize.frequency)}
            stroke={(selectedRow === i && selectedCol === j) ? '#0044AA' : (hoveredCell?.row === i && hoveredCell?.col === j ? '#0066CC' : (tpSize.rawCount > 0 ? '#d0d5dd' : '#eee'))}
            stroke-width={(selectedRow === i && selectedCol === j) ? 2.5 : (hoveredCell?.row === i && hoveredCell?.col === j ? 2 : 1)}
            class="cell"
            on:mouseenter={() => hoveredCell = { row: i, col: j }}
            on:mouseleave={() => hoveredCell = null}
            on:click={() => handleRowClick(i, j)}
          />

          {#if tpSize.rawCount > 0}
            <text
              x={labelWidth + j * cellW + cellW / 2}
              y={rowY + cellH / 2}
              text-anchor="middle"
              dominant-baseline="middle"
              class="cell-text"
              on:click={() => handleRowClick(i, j)}
            >
              {formatFreq(tpSize.frequency)}
            </text>
          {/if}
        {/each}

        <!-- Status badge -->
        {@const sc = statusConfig[entry.status]}
        <rect
          x={labelWidth + timepointLabels.length * cellW + 8}
          y={rowY + (cellH - 20) / 2}
          width={badgeWidth - 16}
          height={20}
          rx="10"
          ry="10"
          fill={sc.bg}
        />
        <text
          x={labelWidth + timepointLabels.length * cellW + badgeWidth / 2}
          y={rowY + cellH / 2}
          text-anchor="middle"
          dominant-baseline="middle"
          class="badge-text"
          fill={sc.color}
        >
          {sc.label}
        </text>
      {/each}
    </svg>

    <!-- Tooltip -->
    {#if hoveredCell !== null}
      {@const entry = entries[hoveredCell.row]}
      {@const tpSize = entry.timepointSizes[hoveredCell.col]}
      {@const tpTotal = getTpTotal(tpSize.label)}
      <div
        class="tooltip"
        style="left: {labelWidth + hoveredCell.col * cellW + cellW / 2}px; top: {headerHeight + hoveredCell.row * cellH - 4}px;"
      >
        <div class="tt-title">{entry.cloneLabel}</div>
        {#if entry.cdr3Aa}
          <div class="tt-row"><span class="tt-label">CDR3:</span> <code>{entry.cdr3Aa}</code></div>
        {/if}
        <div class="tt-row"><span class="tt-label">Frequency:</span> {formatFreq(tpSize.frequency)} of {tpSize.label}</div>
        <div class="tt-row"><span class="tt-label">Sequences:</span> {tpSize.rawCount} / {tpTotal} total in {tpSize.label}</div>
        <div class="tt-row"><span class="tt-label">V:</span> {entry.vGene} &nbsp; <span class="tt-label">J:</span> {entry.jGene}</div>
        <div class="tt-row"><span class="tt-label">Total:</span> {entry.totalRawCount} seqs across all timepoints</div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .dynamics-heatmap-container {
    position: relative;
    overflow: auto;
    background: white;
    flex: 1;
    min-height: 0;
    width: 100%;
    border-radius: var(--border-radius-md);
  }

  .norm-note {
    font-size: 11px;
    color: var(--text-tertiary, #6B7280);
    padding: 6px 12px;
    background: var(--gray-50, #FAFBFC);
    border-bottom: 1px solid var(--border-light, #E8EAED);
  }

  .empty-msg {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .header-label {
    font-size: 11px;
    font-weight: 600;
    fill: var(--text-secondary, #4B5563);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .totals-label {
    font-size: 10px;
    font-weight: 500;
    fill: var(--text-tertiary, #6B7280);
  }

  .row-bg {
    cursor: pointer;
    transition: fill 100ms ease-out;
  }

  .row-label {
    font-size: 11px;
    fill: var(--color-primary, #0066CC);
    cursor: pointer;
    font-weight: 500;
  }

  .row-label:hover {
    text-decoration: underline;
  }

  .cell {
    cursor: pointer;
    transition: stroke 100ms ease-out;
  }

  .cell-text {
    font-size: 9px;
    fill: #1a1a2e;
    font-weight: 600;
    pointer-events: none;
  }

  .badge-text {
    font-size: 10px;
    font-weight: 600;
    pointer-events: none;
  }

  .tooltip {
    position: absolute;
    background: rgba(17, 24, 39, 0.95);
    color: white;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 11px;
    pointer-events: none;
    z-index: 1000;
    white-space: nowrap;
    transform: translateX(-50%) translateY(-100%);
    line-height: 1.5;
  }

  .tt-title {
    font-weight: 600;
    margin-bottom: 4px;
    font-size: 12px;
  }

  .tt-row {
    margin: 1px 0;
  }

  .tt-label {
    color: #9ca3af;
  }

  .tooltip code {
    font-family: 'Courier New', monospace;
    font-size: 10px;
    background: rgba(255,255,255,0.1);
    padding: 1px 3px;
    border-radius: 2px;
  }
</style>
