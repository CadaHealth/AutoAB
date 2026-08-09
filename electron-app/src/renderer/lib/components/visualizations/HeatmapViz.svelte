<script lang="ts">
  export let data: {
    clones: string[];
    patients: string[];
    matrix: number[][];
    /** Normalized frequencies (% of patient repertoire) */
    frequencies: number[][];
    /** Raw sequence counts (for tooltips) */
    rawCounts?: number[][];
    /** Total sequences per patient */
    patientTotals?: number[];
  };

  export let onCloneClick: (cloneIndex: number) => void = () => {};

  let hoveredCell: { row: number; col: number } | null = null;

  // Dimensions
  const cellSize = 30;
  const labelWidth = 150;
  const labelHeight = 150;
  const padding = 10;
  const topPadding = 60;
  const rightPadding = 120;

  $: width = labelWidth + data.patients.length * cellSize + padding * 2 + rightPadding;
  $: height = topPadding + labelHeight + data.clones.length * cellSize + padding * 2;

  $: hasRawCounts = data.rawCounts && data.rawCounts.length > 0;
  $: isNormalized = hasRawCounts;

  // Color scale based on frequency
  function getColor(value: number): string {
    if (value === 0) return '#f0f0f0';
    const maxFreq = Math.max(...data.frequencies.flat());
    if (maxFreq === 0) return '#f0f0f0';
    const intensity = Math.min(value / maxFreq, 1);
    const blue = Math.floor(255 - intensity * 155);
    return `rgb(${blue}, ${blue + 20}, 255)`;
  }

  function formatFreq(val: number): string {
    if (val === 0) return '';
    if (val >= 10) return val.toFixed(0) + '%';
    if (val >= 1) return val.toFixed(1) + '%';
    return val.toFixed(2) + '%';
  }

  function getRawCount(row: number, col: number): number {
    return data.rawCounts?.[row]?.[col] ?? 0;
  }

  function getPatientTotal(col: number): number {
    return data.patientTotals?.[col] ?? 0;
  }

  function handleCellClick(row: number) {
    onCloneClick(row);
  }
</script>

<div class="heatmap-container">
  {#if isNormalized}
    <div class="norm-note">
      Values show clone frequency (% of patient repertoire), normalized for sequencing depth.
    </div>
  {/if}

  <svg {width} {height}>
    <g transform="translate(0, {topPadding})">
    <!-- Y-axis labels (clones) -->
    {#each data.clones as clone, i}
      <text
        x={labelWidth - 5}
        y={labelHeight + i * cellSize + cellSize / 2}
        text-anchor="end"
        dominant-baseline="middle"
        class="label"
        class:clickable={true}
        on:click={() => handleCellClick(i)}
      >
        {clone}
      </text>
    {/each}

    <!-- X-axis labels (patients) -->
    {#each data.patients as patient, j}
      <text
        x={labelWidth + j * cellSize + cellSize / 2}
        y={labelHeight - 5}
        text-anchor="start"
        dominant-baseline="middle"
        transform="rotate(-45, {labelWidth + j * cellSize + cellSize / 2}, {labelHeight - 5})"
        class="label"
      >
        {patient}
      </text>
    {/each}

    <!-- Heatmap cells -->
    {#each data.matrix as row, i}
      {#each row as _cell, j}
        <rect
          x={labelWidth + j * cellSize}
          y={labelHeight + i * cellSize}
          width={cellSize}
          height={cellSize}
          fill={getColor(data.frequencies[i][j])}
          stroke="#ddd"
          stroke-width="1"
          class="cell"
          class:hovered={hoveredCell?.row === i && hoveredCell?.col === j}
          on:mouseenter={() => hoveredCell = { row: i, col: j }}
          on:mouseleave={() => hoveredCell = null}
          on:click={() => handleCellClick(i)}
        />
        
        <!-- Show frequency % if present -->
        {#if data.frequencies[i][j] > 0}
          <text
            x={labelWidth + j * cellSize + cellSize / 2}
            y={labelHeight + i * cellSize + cellSize / 2}
            text-anchor="middle"
            dominant-baseline="middle"
            class="count-label"
          >
            {isNormalized ? formatFreq(data.frequencies[i][j]) : data.frequencies[i][j]}
          </text>
        {/if}
      {/each}
    {/each}
    </g>
  </svg>

  <!-- Tooltip -->
  {#if hoveredCell !== null}
    <div class="tooltip" style="left: {labelWidth + hoveredCell.col * cellSize + cellSize/2}px; top: {topPadding + labelHeight + hoveredCell.row * cellSize - 5}px;">
      <div><strong>Clone:</strong> {data.clones[hoveredCell.row]}</div>
      <div><strong>Patient:</strong> {data.patients[hoveredCell.col]}</div>
      {#if isNormalized}
        <div><strong>Frequency:</strong> {formatFreq(data.frequencies[hoveredCell.row][hoveredCell.col])}</div>
        <div><strong>Sequences:</strong> {getRawCount(hoveredCell.row, hoveredCell.col)} / {getPatientTotal(hoveredCell.col)} total</div>
      {:else}
        <div><strong>Sequences:</strong> {data.frequencies[hoveredCell.row][hoveredCell.col]}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .heatmap-container {
    position: relative;
    overflow: auto;
    background: white;
    flex: 1;
    min-height: 0;
    width: 100%;
  }

  .norm-note {
    font-size: 11px;
    color: var(--text-tertiary, #6B7280);
    padding: 6px 12px;
    background: var(--gray-50, #FAFBFC);
    border-bottom: 1px solid var(--border-light, #E8EAED);
  }

  .label {
    font-size: 11px;
    fill: var(--text-secondary);
  }

  .label.clickable {
    cursor: pointer;
    fill: var(--color-primary);
  }

  .label.clickable:hover {
    fill: var(--color-primary);
    font-weight: var(--font-semibold);
  }

  .cell {
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .cell:hover, .cell.hovered {
    opacity: 0.8;
    stroke: var(--color-primary);
    stroke-width: 2;
  }

  .count-label {
    font-size: 9px;
    fill: #333;
    pointer-events: none;
    font-weight: var(--font-semibold);
  }

  .tooltip {
    position: absolute;
    background: rgba(0, 0, 0, 0.9);
    color: white;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--border-radius-sm);
    font-size: var(--text-xs);
    pointer-events: none;
    z-index: 1000;
    white-space: nowrap;
    transform: translateX(-50%) translateY(-100%);
  }

  .tooltip div {
    margin: 2px 0;
  }
</style>
