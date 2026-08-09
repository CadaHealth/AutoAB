<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { GroupTimepointMetrics } from '../../utils/repertoire-metrics';

  export let data: GroupTimepointMetrics[] = [];
  export let maxFamilies = 15;

  let container: HTMLDivElement;
  let width = 500;
  let ro: ResizeObserver;

  onMount(() => {
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        width = entry.contentRect.width;
      }
    });
    ro.observe(container);
  });

  onDestroy(() => { ro?.disconnect(); });

  $: if (container && data.length > 0) drawChart(data, width);

  function drawChart(metrics: GroupTimepointMetrics[], w: number) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    // Collect all V-gene families and sum across all groups
    const familyTotals = new Map<string, number>();
    for (const m of metrics) {
      for (const vg of m.vGeneFreqs) {
        familyTotals.set(vg.family, (familyTotals.get(vg.family) || 0) + vg.frequency);
      }
    }
    // Sort by total, take top N
    const sortedFamilies = Array.from(familyTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFamilies)
      .map(e => e[0]);

    if (sortedFamilies.length === 0) return;

    const labels = metrics.map(m => `${m.groupName} / ${m.timepointLabel}`);

    const margin = { top: 20, right: 20, bottom: 44, left: 80 };
    const barGroupHeight = Math.max(18, Math.min(28, 200 / sortedFamilies.length));
    const rowHeight = barGroupHeight * labels.length + 8;
    const height = margin.top + margin.bottom + sortedFamilies.length * rowHeight;

    const innerW = w - margin.left - margin.right;

    svg.attr('width', w).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Y0 = family
    const y0 = d3.scaleBand()
      .domain(sortedFamilies)
      .range([0, sortedFamilies.length * rowHeight])
      .paddingInner(0.15);

    // Y1 = group within family
    const y1 = d3.scaleBand()
      .domain(labels)
      .range([0, y0.bandwidth()])
      .padding(0.05);

    // X = frequency
    const xMax = d3.max(metrics.flatMap(m => m.vGeneFreqs.map(v => v.frequency))) || 0.5;
    const x = d3.scaleLinear().domain([0, xMax * 1.1]).nice().range([0, innerW]);

    // Axes
    g.append('g')
      .call(d3.axisLeft(y0).tickSizeOuter(0))
      .selectAll('text')
      .style('font-size', '11px');

    g.append('g')
      .attr('transform', `translate(0,${sortedFamilies.length * rowHeight})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat((d: any) => `${(+d * 100).toFixed(0)}%`))
      .selectAll('text')
      .style('font-size', '11px');

    // Grid lines
    g.append('g')
      .call(d3.axisBottom(x).ticks(5).tickSize(sortedFamilies.length * rowHeight).tickFormat(() => ''))
      .selectAll('line')
      .style('stroke', '#E8EAED')
      .style('stroke-dasharray', '3,3');
    g.selectAll('.domain').filter((_: any, i: any, nodes: any) => i === nodes.length - 1).remove();

    // Bars
    for (const family of sortedFamilies) {
      const famG = g.append('g')
        .attr('transform', `translate(0,${y0(family)})`);

      for (const m of metrics) {
        const label = `${m.groupName} / ${m.timepointLabel}`;
        const vg = m.vGeneFreqs.find(v => v.family === family);
        const freq = vg ? vg.frequency : 0;

        famG.append('rect')
          .attr('x', 0)
          .attr('y', y1(label) || 0)
          .attr('width', x(freq))
          .attr('height', y1.bandwidth())
          .attr('rx', 2)
          .attr('fill', m.groupColor)
          .attr('opacity', 0.85)
          .on('mouseenter', function(this: any, event: any) {
            d3.select(this).attr('opacity', 1);
            showTooltip(event, label, family, freq);
          })
          .on('mouseleave', function(this: any) {
            d3.select(this).attr('opacity', 0.85);
            hideTooltip();
          });
      }
    }

    // Legend
    const legend = svg.append('g')
      .attr('transform', `translate(${margin.left + 8}, ${height - 18})`);
    labels.forEach((label, i) => {
      const color = metrics[i]?.groupColor || '#999';
      const lg = legend.append('g')
        .attr('transform', `translate(${i * 150}, 0)`);
      lg.append('rect').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', color);
      lg.append('text').attr('x', 14).attr('y', 9).text(label)
        .style('font-size', '10px').style('fill', '#6B7280');
    });
  }

  // ── Tooltip ──────────────────────
  let tooltipStyle = '';
  let tooltipText = '';
  let tooltipVisible = false;

  function showTooltip(event: MouseEvent, label: string, family: string, freq: number) {
    tooltipText = `${label}\n${family}: ${(freq * 100).toFixed(1)}%`;
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
  <svg></svg>
  {#if tooltipVisible}
    <div class="tooltip" style={tooltipStyle}>
      {#each tooltipText.split('\n') as line}
        <div>{line}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chart-wrapper {
    position: relative;
    width: 100%;
    min-height: 200px;
    overflow: visible;
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
