<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { LongitudinalGroupData, TrackedClone } from '../../utils/repertoire-metrics';

  export let data: LongitudinalGroupData[] = [];
  export let topN = 15;

  let container: HTMLDivElement;
  let width = 500;
  let ro: ResizeObserver;

  onMount(() => {
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) width = entry.contentRect.width;
    });
    ro.observe(container);
  });
  onDestroy(() => { ro?.disconnect(); });

  $: if (container && data.length > 0) drawChart(data, width);

  const PALETTE = [
    '#0066CC', '#E85D04', '#2D9F3F', '#9B59B6', '#E74C3C',
    '#00ACC1', '#F39C12', '#7F8C8D', '#3498DB', '#E67E22',
    '#27AE60', '#8E44AD', '#1ABC9C', '#D35400', '#2980B9'
  ];

  function drawChart(groups: LongitudinalGroupData[], w: number) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    const margin = { top: 28, right: 120, bottom: 40, left: 55 };
    const chartH = 260;
    const totalH = groups.length * (chartH + 40) + 20;
    const innerW = w - margin.left - margin.right;

    svg.attr('width', w).attr('height', totalH);

    groups.forEach((grp, gi) => {
      const g = svg.append('g')
        .attr('transform', `translate(${margin.left}, ${gi * (chartH + 40) + margin.top})`);
      const innerH = chartH - margin.top - margin.bottom;

      // Title
      g.append('text')
        .attr('x', 0).attr('y', -10)
        .style('font-size', '13px').style('font-weight', '600').style('fill', grp.groupColor)
        .text(grp.groupName);

      // Top N clones (by total size)
      const top = grp.trackedClones.slice(0, topN);
      if (top.length === 0) {
        g.append('text').attr('x', innerW / 2).attr('y', innerH / 2)
          .attr('text-anchor', 'middle').style('fill', '#9BA3AF').text('No clones tracked');
        return;
      }

      const labels = grp.timepointLabels;
      const x = d3.scalePoint<string>().domain(labels).range([0, innerW]).padding(0.3);

      // Y: frequency (proportion of total sequences at each timepoint)
      // Compute total seqs per timepoint from all tracked clones
      const tpTotals = labels.map((_, ti) => {
        let total = 0;
        for (const c of grp.trackedClones) total += c.timepointSizes[ti].size;
        return Math.max(total, 1);
      });

      const yMax = d3.max(top.flatMap(c =>
        c.timepointSizes.map((t, ti) => t.size / tpTotals[ti])
      )) || 0.1;
      const y = d3.scaleLinear().domain([0, yMax * 1.15]).nice().range([innerH, 0]);

      // Axes
      g.append('g').attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(x)).selectAll('text').style('font-size', '10px');
      g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat((d: any) => `${(+d * 100).toFixed(0)}%`))
        .selectAll('text').style('font-size', '10px');

      // Grid
      g.append('g')
        .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(() => ''))
        .selectAll('line').style('stroke', '#E8EAED').style('stroke-dasharray', '3,3');
      g.selectAll('.domain').remove();

      // Y label
      g.append('text')
        .attr('transform', 'rotate(-90)')
        .attr('x', -innerH / 2).attr('y', -42)
        .attr('text-anchor', 'middle')
        .style('font-size', '11px').style('fill', '#6B7280')
        .text('Clone Frequency');

      // Lines per clone
      const line = d3.line<{ label: string; freq: number }>()
        .x((d: any) => x(d.label) ?? 0)
        .y((d: any) => y(d.freq))
        .defined((d: any) => d.freq > 0)
        .curve(d3.curveMonotoneX);

      top.forEach((clone, ci) => {
        const color = PALETTE[ci % PALETTE.length];
        const pts = clone.timepointSizes.map((t, ti) => ({
          label: t.timepointLabel,
          freq: t.size / tpTotals[ti]
        }));

        g.append('path')
          .datum(pts.filter(p => p.freq > 0))
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', clone.persistent ? 2.5 : 1.5)
          .attr('stroke-dasharray', clone.persistent ? 'none' : '5,3')
          .attr('opacity', 0.8)
          .attr('d', line);

        pts.forEach(p => {
          if (p.freq > 0) {
            g.append('circle')
              .attr('cx', x(p.label) ?? 0)
              .attr('cy', y(p.freq))
              .attr('r', 3)
              .attr('fill', color)
              .attr('stroke', '#fff')
              .attr('stroke-width', 1);
          }
        });

        // Right-side label
        const lastPt = [...pts].reverse().find(p => p.freq > 0);
        if (lastPt) {
          g.append('text')
            .attr('x', innerW + 6)
            .attr('y', y(lastPt.freq) + 3)
            .style('font-size', '9px')
            .style('fill', color)
            .text(`Clone ${clone.cloneId}`);
        }
      });
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
    min-height: 280px;
  }
</style>
