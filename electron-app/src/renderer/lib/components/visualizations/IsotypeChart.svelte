<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { GroupTimepointMetrics } from '../../utils/repertoire-metrics';

  export let data: GroupTimepointMetrics[] = [];

  let container: HTMLDivElement;
  let width = 500;
  let ro: ResizeObserver;

  const ISOTYPE_COLORS: Record<string, string> = {
    IgM: '#E85D04',
    IgD: '#9B59B6',
    IgG: '#0066CC',
    IgA: '#2D9F3F',
    IgE: '#E74C3C'
  };

  const ISOTYPES = ['IgM', 'IgD', 'IgG', 'IgA', 'IgE'];

  onMount(() => {
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        width = entry.contentRect.width;
      }
    });
    ro.observe(container);
  });

  onDestroy(() => { ro?.disconnect(); });

  // Check if any metrics have non-zero isotype data
  $: hasIsotypeData = data.some(m => m.isotypeFreqs.some(f => f.count > 0));
  $: if (container && data.length > 0 && hasIsotypeData) drawChart(data, width);
  // Clear SVG when there's no data
  $: if (container && (!data.length || !hasIsotypeData)) {
    const svg = container?.querySelector('svg');
    if (svg) d3.select(svg).selectAll('*').remove();
  }

  function drawChart(metrics: GroupTimepointMetrics[], w: number) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    const count = metrics.length;

    const cols = count;
    const cellW = w / cols;
    const pieRadius = Math.min(cellW * 0.35, 110);
    const cellH = pieRadius * 2 + 70;
    const legendH = 32;
    const totalH = cellH + legendH;

    svg.attr('width', w).attr('height', totalH);

    const arc = (d3 as any).arc()
      .innerRadius(pieRadius * 0.45) // donut
      .outerRadius(pieRadius);

    const pie = (d3 as any).pie()
      .value((d: any) => d.frequency)
      .sort(null);

    metrics.forEach((m, idx) => {
      const cx = idx * cellW + cellW / 2;
      const cy = pieRadius + 4;

      const slices = m.isotypeFreqs.filter(f => f.frequency > 0);
      if (slices.length === 0) return;

      const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

      const pieData = pie(slices);

      g.selectAll('path')
        .data(pieData)
        .join('path')
        .attr('d', arc as any)
        .attr('fill', (d: any) => ISOTYPE_COLORS[d.data.isotype] || '#999')
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .on('mouseenter', function(this: any, event: any, d: any) {
          d3.select(this).attr('opacity', 0.8);
          const pct = (d.data.frequency * 100).toFixed(1);
          showTooltip(event, `${d.data.isotype}: ${pct}% (${m.isotypeFreqs.find((f: any) => f.isotype === d.data.isotype)?.count ?? 0})`);
        })
        .on('mouseleave', function(this: any) {
          d3.select(this).attr('opacity', 1);
          hideTooltip();
        });

      // Percentage labels on slices ≥ 5% (always visible, useful for inspection
      // on screen and required for publication-figure export).
      const labelArc = (d3 as any).arc()
        .innerRadius(pieRadius * 0.72)
        .outerRadius(pieRadius * 0.72);
      g.selectAll('text.slice-pct')
        .data(pieData)
        .join('text')
        .attr('class', 'slice-pct')
        .attr('transform', (d: any) => `translate(${labelArc.centroid(d)})`)
        .attr('text-anchor', 'middle')
        .attr('dy', '0.32em')
        .style('font-size', pieRadius < 60 ? '9px' : '11px')
        .style('font-weight', '600')
        .style('fill', '#fff')
        .style('pointer-events', 'none')
        .text((d: any) => d.data.frequency >= 0.05 ? `${Math.round(d.data.frequency * 100)}%` : '');

      // Label below (two lines to avoid cutoff)
      const labelG = svg.append('g').attr('transform', `translate(${cx},${cy + pieRadius + 18})`);
      if (count > 1) {
        labelG.append('text')
          .attr('text-anchor', 'middle')
          .attr('y', 0)
          .style('font-size', '11px')
          .style('fill', '#6B7280')
          .text(m.groupName);
        labelG.append('text')
          .attr('text-anchor', 'middle')
          .attr('y', 14)
          .style('font-size', '10px')
          .style('fill', '#9CA3AF')
          .text(m.timepointLabel);
      } else {
        labelG.append('text')
          .attr('text-anchor', 'middle')
          .attr('y', 7)
          .style('font-size', '11px')
          .style('fill', '#6B7280')
          .text(m.groupName);
      }
    });

    // Legend at the bottom
    const legendY = totalH - legendH + 10;
    const legendW = ISOTYPES.length * 60;
    const legendX = (w - legendW) / 2;
    ISOTYPES.forEach((iso, i) => {
      const lg = svg.append('g').attr('transform', `translate(${legendX + i * 60}, ${legendY})`);
      lg.append('rect').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', ISOTYPE_COLORS[iso]);
      lg.append('text').attr('x', 14).attr('y', 9).text(iso).style('font-size', '10px').style('fill', '#6B7280');
    });
  }

  let tooltipStyle = '';
  let tooltipText = '';
  let tooltipVisible = false;

  function showTooltip(event: MouseEvent, text: string) {
    tooltipText = text;
    const containerW = container?.offsetWidth ?? 0;
    const tipW = 180;
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
  {#if !hasIsotypeData}
    <div class="no-data">
      <p class="no-data-title">No isotype data available</p>
      <p class="no-data-hint">Rerun the pipeline to enable C gene annotation (IgG/IgM/IgA/IgD/IgE).</p>
    </div>
  {:else}
    <svg></svg>
    {#if tooltipVisible}
      <div class="tooltip" style={tooltipStyle}>
        {tooltipText}
      </div>
    {/if}
  {/if}
</div>

<style>
  .chart-wrapper {
    position: relative;
    width: 100%;
    min-height: 180px;
    overflow: visible;
  }
  .no-data {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 200px;
    text-align: center;
  }
  .no-data-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-secondary);
    margin: 0 0 var(--space-2) 0;
  }
  .no-data-hint {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin: 0;
  }
  .tooltip {
    position: absolute;
    pointer-events: none;
    background: var(--gray-800);
    color: #fff;
    padding: 6px 10px;
    border-radius: var(--border-radius-sm);
    font-size: 11px;
    line-height: 1.4;
    white-space: nowrap;
    z-index: var(--z-tooltip);
    box-shadow: var(--shadow-md);
  }
</style>
