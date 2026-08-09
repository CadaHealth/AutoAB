<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { LongitudinalGroupData } from '../../utils/repertoire-metrics';

  export let data: LongitudinalGroupData[] = [];

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

  function drawChart(groups: LongitudinalGroupData[], w: number) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    const metrics = [
      { key: 'shannon', label: 'Shannon Entropy', accessor: (d: any) => d.shannonEntropy },
      { key: 'gini', label: 'Gini Index', accessor: (d: any) => d.giniIndex },
      { key: 'chao1', label: 'Chao1 (Richness)', accessor: (d: any) => d.chao1 },
      { key: 'shm', label: 'Mean SHM', accessor: (_: any, i: number, g: LongitudinalGroupData) => g.shmTrajectory[i] }
    ];
    const cols = 2;
    const rows = 2;
    const margin = { top: 28, right: 16, bottom: 36, left: 50 };
    const cellW = (w - 16) / cols;
    const cellH = 200;
    const height = cellH * rows + 20;

    svg.attr('width', w).attr('height', height);

    metrics.forEach((metric, mi) => {
      const col = mi % cols;
      const row = Math.floor(mi / cols);
      const g = svg.append('g')
        .attr('transform', `translate(${col * cellW + margin.left}, ${row * cellH + margin.top})`);
      const innerW = cellW - margin.left - margin.right;
      const innerH = cellH - margin.top - margin.bottom;

      // Gather all timepoint labels for x-axis (from first group, assume same across groups)
      const allLabels = groups.length > 0 ? groups[0].timepointLabels : [];
      const x = d3.scalePoint<string>().domain(allLabels).range([0, innerW]).padding(0.3);

      // Gather all values for y-axis
      let allVals: number[] = [];
      for (const grp of groups) {
        for (let i = 0; i < grp.timepointLabels.length; i++) {
          const v = metric.key === 'shm' ? grp.shmTrajectory[i] : metric.accessor(grp.diversityTrajectory[i], i, grp);
          allVals.push(v);
        }
      }
      const yMax = d3.max(allVals) || 1;
      const y = d3.scaleLinear().domain([0, yMax * 1.15]).nice().range([innerH, 0]);

      // Axes
      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(x))
        .selectAll('text').style('font-size', '10px');
      g.append('g').call(d3.axisLeft(y).ticks(4))
        .selectAll('text').style('font-size', '10px');

      // Grid
      g.append('g')
        .call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(() => ''))
        .selectAll('line').style('stroke', '#E8EAED').style('stroke-dasharray', '3,3');
      g.selectAll('.domain').remove();

      // Title
      g.append('text')
        .attr('x', innerW / 2).attr('y', -10)
        .attr('text-anchor', 'middle')
        .style('font-size', '12px').style('font-weight', '600').style('fill', '#374151')
        .text(metric.label);

      // Lines per group
      const line = d3.line<number>()
        .x((_: any, i: number) => x(allLabels[i]) ?? 0)
        .y((d: any) => y(d))
        .curve(d3.curveMonotoneX);

      for (const grp of groups) {
        const vals = grp.timepointLabels.map((_, i) =>
          metric.key === 'shm' ? grp.shmTrajectory[i] : metric.accessor(grp.diversityTrajectory[i], i, grp)
        );

        g.append('path')
          .datum(vals)
          .attr('fill', 'none')
          .attr('stroke', grp.groupColor)
          .attr('stroke-width', 2.5)
          .attr('d', line);

        // Dots
        vals.forEach((v, i) => {
          g.append('circle')
            .attr('cx', x(allLabels[i]) ?? 0)
            .attr('cy', y(v))
            .attr('r', 4)
            .attr('fill', grp.groupColor)
            .attr('stroke', '#fff')
            .attr('stroke-width', 1.5);
        });
      }
    });

    // Legend at bottom
    const legend = svg.append('g')
      .attr('transform', `translate(${margin.left}, ${height - 8})`);
    groups.forEach((grp, i) => {
      const lg = legend.append('g').attr('transform', `translate(${i * 140}, 0)`);
      lg.append('rect').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', grp.groupColor);
      lg.append('text').attr('x', 14).attr('y', 9).text(grp.groupName)
        .style('font-size', '10px').style('fill', '#6B7280');
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
    min-height: 420px;
  }
</style>
