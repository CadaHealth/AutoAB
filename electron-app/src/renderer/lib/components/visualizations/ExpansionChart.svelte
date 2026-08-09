<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { GroupTimepointMetrics } from '../../utils/repertoire-metrics';

  export let data: GroupTimepointMetrics[] = [];

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

    const margin = { top: 20, right: 20, bottom: 50, left: 55 };
    const height = 300;
    const innerW = w - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr('width', w).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Determine axis extents from all rank-abundance arrays
    let maxRank = 1;
    let maxSize = 1;
    for (const m of metrics) {
      for (const pt of m.rankAbundance) {
        if (pt.rank > maxRank) maxRank = pt.rank;
        if (pt.size > maxSize) maxSize = pt.size;
      }
    }

    // Log scales
    const x = d3.scaleLog()
      .domain([1, maxRank])
      .range([0, innerW])
      .nice();

    const y = d3.scaleLog()
      .domain([1, maxSize * 1.2])
      .range([innerH, 0])
      .nice();

    // Grid
    g.append('g')
      .call(d3.axisLeft(y).ticks(5, '~s').tickSize(-innerW))
      .call((sel: any) => {
        sel.selectAll('line').style('stroke', '#E8EAED').style('stroke-dasharray', '3,3');
        sel.selectAll('.domain').remove();
        sel.selectAll('text').style('font-size', '11px');
      });

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(5, '~s').tickSize(-innerH))
      .call((sel: any) => {
        sel.selectAll('line').style('stroke', '#E8EAED').style('stroke-dasharray', '3,3');
        sel.selectAll('.domain').remove();
        sel.selectAll('text').style('font-size', '11px');
      });

    // Axis labels
    g.append('text')
      .attr('x', innerW / 2)
      .attr('y', innerH + 38)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('fill', '#6B7280')
      .text('Clone Rank');

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2)
      .attr('y', -42)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('fill', '#6B7280')
      .text('Clone Size (sequences)');

    // Lines
    const line = d3.line<{ rank: number; size: number }>()
      .x((d: any) => x(d.rank))
      .y((d: any) => y(Math.max(1, d.size)))
      .curve(d3.curveMonotoneX);

    // Determine if a timepoint is baseline (first per group) to use solid vs dashed
    const seenGroups = new Set<string>();

    metrics.forEach((m) => {
      const isFirst = !seenGroups.has(m.groupId);
      seenGroups.add(m.groupId);

      const pts = m.rankAbundance.filter(p => p.size >= 1);
      if (pts.length < 2) return;

      g.append('path')
        .datum(pts)
        .attr('fill', 'none')
        .attr('stroke', m.groupColor)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', isFirst ? 'none' : '6,3')
        .attr('opacity', 0.85)
        .attr('d', line);

      // Dots at first and last point for visual anchoring
      for (const pt of [pts[0], pts[pts.length - 1]]) {
        g.append('circle')
          .attr('cx', x(pt.rank))
          .attr('cy', y(pt.size))
          .attr('r', 3)
          .attr('fill', m.groupColor);
      }
    });

    // Legend
    const legend = svg.append('g')
      .attr('transform', `translate(${margin.left + 8}, ${height - 10})`);
    const seenLegend = new Set<string>();
    let legendIdx = 0;
    metrics.forEach((m) => {
      const isFirst = !seenLegend.has(m.groupId);
      seenLegend.add(m.groupId);
      const label = `${m.groupName} / ${m.timepointLabel}`;
      const lg = legend.append('g')
        .attr('transform', `translate(${legendIdx * 160}, 0)`);
      lg.append('line')
        .attr('x1', 0).attr('y1', 5).attr('x2', 16).attr('y2', 5)
        .attr('stroke', m.groupColor)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', isFirst ? 'none' : '6,3');
      lg.append('text').attr('x', 20).attr('y', 9).text(label)
        .style('font-size', '10px').style('fill', '#6B7280');
      legendIdx++;
    });
  }
</script>

<div class="chart-wrapper" bind:this={container}>
  <svg></svg>
</div>

<style>
  .chart-wrapper {
    position: relative;
    width: 100%;
    min-height: 300px;
  }
</style>
