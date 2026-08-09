<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { GroupTimepointMetrics } from '../../utils/repertoire-metrics';

  // One entry per cohort (or per sample if you pass per-sample metrics).
  // Columns of the heatmap = entries; rows = V-gene families.
  export let data: GroupTimepointMetrics[] = [];
  export let maxFamilies = 20;

  let container: HTMLDivElement;
  let width = 600;
  let ro: ResizeObserver;

  onMount(() => {
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) width = entry.contentRect.width;
    });
    ro.observe(container);
  });

  onDestroy(() => { ro?.disconnect(); });

  $: if (container && data.length > 0) draw(data, width);
  $: if (container && data.length === 0) {
    const svg = container?.querySelector('svg');
    if (svg) d3.select(svg).selectAll('*').remove();
  }

  function draw(metrics: GroupTimepointMetrics[], w: number) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    const familyTotals = new Map<string, number>();
    for (const m of metrics) for (const vg of m.vGeneFreqs) {
      familyTotals.set(vg.family, (familyTotals.get(vg.family) || 0) + vg.frequency);
    }
    const families = [...familyTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFamilies)
      .map(e => e[0]);
    if (families.length === 0) return;

    const margin = { top: 80, right: 80, bottom: 20, left: 100 };
    const cellSize = Math.max(28, Math.min(56, (w - margin.left - margin.right) / Math.max(metrics.length, 1)));
    const innerW = cellSize * metrics.length;
    const innerH = cellSize * families.length;
    const totalW = innerW + margin.left + margin.right;
    const totalH = innerH + margin.top + margin.bottom;

    svg.attr('width', totalW).attr('height', totalH);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand()
      .domain(metrics.map((_, i) => String(i)))
      .range([0, innerW])
      .padding(0.04);
    const y = d3.scaleBand()
      .domain(families)
      .range([0, innerH])
      .padding(0.04);

    const maxFreq = Math.max(
      0.0001,
      ...metrics.flatMap(m => m.vGeneFreqs.filter(vg => families.includes(vg.family)).map(vg => vg.frequency))
    );
    const color = (d3 as any).scaleSequential()
      .domain([0, maxFreq])
      .interpolator((d3 as any).interpolateBlues);

    // Cells
    for (let ci = 0; ci < metrics.length; ci++) {
      const m = metrics[ci];
      const freqByFam = new Map(m.vGeneFreqs.map(vg => [vg.family, vg.frequency]));
      const countByFam = new Map(m.vGeneFreqs.map(vg => [vg.family, vg.count]));
      for (const fam of families) {
        const f = freqByFam.get(fam) ?? 0;
        const c = countByFam.get(fam) ?? 0;
        g.append('rect')
          .attr('x', x(String(ci))!)
          .attr('y', y(fam)!)
          .attr('width', x.bandwidth())
          .attr('height', y.bandwidth())
          .attr('fill', f > 0 ? color(f) : '#f5f5f5')
          .attr('stroke', '#fff')
          .attr('stroke-width', 1)
          .on('mouseenter', function(this: any, event: any) {
            d3.select(this).attr('stroke', '#333').attr('stroke-width', 1.5);
            showTooltip(event, `${fam} • ${m.groupName}\n${(f * 100).toFixed(1)}% (${c.toLocaleString()})`);
          })
          .on('mouseleave', function(this: any) {
            d3.select(this).attr('stroke', '#fff').attr('stroke-width', 1);
            hideTooltip();
          });

        // Inline percentage label on every cell. White text on darker cells,
        // dark text on lighter cells; sub-percent values show one decimal.
        if (f > 0) {
          const label = f >= 0.01 ? `${(f * 100).toFixed(0)}%` : `${(f * 100).toFixed(1)}%`;
          g.append('text')
            .attr('x', x(String(ci))! + x.bandwidth() / 2)
            .attr('y', y(fam)! + y.bandwidth() / 2 + 3)
            .attr('text-anchor', 'middle')
            .style('font-size', '9px')
            .style('font-weight', f >= maxFreq * 0.4 ? '600' : '400')
            .style('fill', f >= maxFreq * 0.55 ? '#fff' : '#1f2937')
            .style('pointer-events', 'none')
            .text(label);
        }
      }
    }

    // Family labels (left axis)
    g.append('g')
      .selectAll('text')
      .data(families)
      .join('text')
      .attr('x', -8)
      .attr('y', (d: string) => y(d)! + y.bandwidth() / 2 + 3)
      .attr('text-anchor', 'end')
      .style('font-size', '11px')
      .style('fill', '#374151')
      .text((d: string) => d);

    // Cohort labels (top axis), rotated
    g.append('g')
      .selectAll('text')
      .data(metrics)
      .join('text')
      .attr('transform', (_d: any, i: number) => `translate(${x(String(i))! + x.bandwidth() / 2},-8) rotate(-35)`)
      .attr('text-anchor', 'start')
      .style('font-size', '11px')
      .style('font-weight', '500')
      .style('fill', (d: any) => d.groupColor || '#374151')
      .text((d: any) => d.groupName);

    // Legend
    const legendG = svg.append('g')
      .attr('transform', `translate(${margin.left + innerW + 12},${margin.top})`);
    const legendH = Math.min(innerH, 180);
    const legendW = 14;
    const gradId = `vgene-heatmap-grad-${Math.random().toString(36).slice(2)}`;
    const defs = svg.append('defs');
    const grad = defs.append('linearGradient')
      .attr('id', gradId)
      .attr('x1', '0%').attr('x2', '0%')
      .attr('y1', '100%').attr('y2', '0%');
    const stops = 8;
    for (let i = 0; i <= stops; i++) {
      grad.append('stop')
        .attr('offset', `${(i / stops) * 100}%`)
        .attr('stop-color', color((i / stops) * maxFreq));
    }
    legendG.append('rect')
      .attr('width', legendW)
      .attr('height', legendH)
      .attr('fill', `url(#${gradId})`)
      .attr('stroke', '#e5e7eb');
    legendG.append('text')
      .attr('x', legendW + 6).attr('y', 10)
      .style('font-size', '10px').style('fill', '#6b7280')
      .text(`${(maxFreq * 100).toFixed(1)}%`);
    legendG.append('text')
      .attr('x', legendW + 6).attr('y', legendH)
      .style('font-size', '10px').style('fill', '#6b7280')
      .text('0%');
    legendG.append('text')
      .attr('x', legendW + 6).attr('y', legendH / 2 + 3)
      .style('font-size', '10px').style('fill', '#6b7280')
      .text('freq');
  }

  let tooltipStyle = '';
  let tooltipText = '';
  let tooltipVisible = false;

  function showTooltip(event: MouseEvent, text: string) {
    tooltipText = text;
    const containerW = container?.offsetWidth ?? 0;
    const tipW = 200;
    const x = event.offsetX;
    let left = x + 12;
    if (left + tipW > containerW) left = x - tipW - 12;
    if (left < 0) left = 4;
    tooltipStyle = `left:${left}px;top:${event.offsetY - 10}px`;
    tooltipVisible = true;
  }
  function hideTooltip() { tooltipVisible = false; }
</script>

<div class="chart-wrapper" bind:this={container}>
  {#if data.length === 0}
    <div class="no-data"><p>No V-gene data available.</p></div>
  {:else}
    <svg></svg>
    {#if tooltipVisible}
      <div class="tooltip" style={tooltipStyle}>{tooltipText}</div>
    {/if}
  {/if}
</div>

<style>
  .chart-wrapper {
    position: relative;
    width: 100%;
    overflow-x: auto;
  }
  .no-data {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 160px;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .tooltip {
    position: absolute;
    background: rgba(17, 24, 39, 0.92);
    color: #fff;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.4;
    pointer-events: none;
    white-space: pre-line;
    z-index: 10;
  }
</style>
