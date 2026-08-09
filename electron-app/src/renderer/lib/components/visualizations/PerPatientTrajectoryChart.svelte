<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { GroupTimepointMetrics } from '../../utils/repertoire-metrics';
  import { wilcoxonRankSum, benjaminiHochberg, formatPValue, significanceStars } from '../../utils/statistics';

  /** Per-sample metrics for disease group */
  export let diseaseData: GroupTimepointMetrics[] = [];
  /** Per-sample metrics for control group */
  export let controlData: GroupTimepointMetrics[] = [];
  export let diseaseName: string = 'Disease';
  export let controlName: string = 'Control';
  export let publicationMode: boolean = false;

  let container: HTMLDivElement;
  let width = 800;
  let ro: ResizeObserver;

  onMount(() => {
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) width = entry.contentRect.width;
    });
    ro.observe(container);
  });
  onDestroy(() => { ro?.disconnect(); });

  const DISEASE_COLOR = '#1565C0';
  const CONTROL_COLOR = '#757575';

  interface MetricDef {
    key: string;
    label: string;
    accessor: (m: GroupTimepointMetrics) => number;
  }

  const METRICS: MetricDef[] = [
    { key: 'shannon', label: 'Shannon Entropy', accessor: m => m.diversity.shannonEntropy },
    { key: 'simpson', label: 'Simpson Index', accessor: m => m.diversity.simpsonIndex },
    { key: 'chao1', label: 'Chao1', accessor: m => m.diversity.chao1 },
    { key: 'gini', label: 'Gini Index', accessor: m => m.diversity.giniIndex },
    { key: 'meanSHM', label: 'Mean SHM', accessor: m => m.diversity.meanSHM },
  ];

  $: hasComparison = diseaseData.length > 0 && controlData.length > 0;

  $: allTimepoints = (() => {
    const tps = new Set<string>();
    for (const m of diseaseData) tps.add(m.timepointLabel);
    for (const m of controlData) tps.add(m.timepointLabel);
    return [...tps].sort();
  })();

  $: needsTrajectory = allTimepoints.length >= 2;

  function groupByTp(data: GroupTimepointMetrics[]): Map<string, GroupTimepointMetrics[]> {
    const map = new Map<string, GroupTimepointMetrics[]>();
    for (const m of data) {
      if (!map.has(m.timepointLabel)) map.set(m.timepointLabel, []);
      map.get(m.timepointLabel)!.push(m);
    }
    return map;
  }

  $: diseasByTp = groupByTp(diseaseData);
  $: controlByTp = groupByTp(controlData);

  function meanSEM(values: number[]): { mean: number; sem: number } {
    if (values.length === 0) return { mean: 0, sem: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (values.length === 1) return { mean, sem: 0 };
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return { mean, sem: Math.sqrt(variance / values.length) };
  }

  // Compute tests for p-value annotations
  $: allTests = (() => {
    if (!hasComparison) return [];
    const results: { tp: string; metric: string; test: ReturnType<typeof wilcoxonRankSum>; adjustedP?: number }[] = [];
    for (const tp of allTimepoints) {
      const dData = diseasByTp.get(tp) ?? [];
      const cData = controlByTp.get(tp) ?? [];
      for (const metric of METRICS) {
        const dVals = dData.map(metric.accessor);
        const cVals = cData.map(metric.accessor);
        results.push({ tp, metric: metric.key, test: wilcoxonRankSum(dVals, cVals) });
      }
    }
    const validIdx = results.map((t, i) => t.test.valid ? i : -1).filter(i => i >= 0);
    const validPs = validIdx.map(i => results[i].test.p);
    const adjusted = benjaminiHochberg(validPs);
    validIdx.forEach((idx, j) => { results[idx].adjustedP = adjusted[j]; });
    return results;
  })();

  $: if (container && needsTrajectory && width > 0) drawChart(width);

  function drawChart(w: number) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    const nMetrics = METRICS.length;
    const cols = 3;
    const rows = Math.ceil(nMetrics / cols);
    const margin = publicationMode
      ? { top: 28, right: 20, bottom: 44, left: 54 }
      : { top: 24, right: 16, bottom: 40, left: 48 };
    const cellW = w / cols;
    const cellH = publicationMode ? 220 : 200;
    const legendH = 28;
    const totalH = cellH * rows + legendH;

    svg.attr('width', w).attr('height', totalH);

    if (publicationMode) {
      svg.style('font-family', 'Arial, Helvetica, sans-serif');
    }

    const fontSize = publicationMode ? '11px' : '10px';
    const labelFontSize = publicationMode ? '12px' : '11px';
    const pFontSize = publicationMode ? '9px' : '8px';

    METRICS.forEach((metric, mi) => {
      const col = mi % cols;
      const row = Math.floor(mi / cols);
      const gX = col * cellW + margin.left;
      const gY = row * cellH + margin.top;
      const g = svg.append('g').attr('transform', `translate(${gX}, ${gY})`);
      const innerW = cellW - margin.left - margin.right;
      const innerH = cellH - margin.top - margin.bottom;

      const x = d3.scalePoint<string>().domain(allTimepoints).range([0, innerW]).padding(0.2);

      // Compute stats per group per timepoint
      interface TpStats { tp: string; mean: number; sem: number; n: number }
      const diseaseStats: TpStats[] = [];
      const controlStats: TpStats[] = [];

      for (const tp of allTimepoints) {
        const dVals = (diseasByTp.get(tp) ?? []).map(metric.accessor);
        const cVals = (controlByTp.get(tp) ?? []).map(metric.accessor);
        const dS = meanSEM(dVals);
        const cS = meanSEM(cVals);
        diseaseStats.push({ tp, mean: dS.mean, sem: dS.sem, n: dVals.length });
        controlStats.push({ tp, mean: cS.mean, sem: cS.sem, n: cVals.length });
      }

      // Y scale from all means ± SEM
      const allYVals: number[] = [];
      for (const s of diseaseStats) { allYVals.push(s.mean + s.sem, s.mean - s.sem); }
      for (const s of controlStats) { allYVals.push(s.mean + s.sem, s.mean - s.sem); }
      const yMin = Math.max(0, (d3.min(allYVals) ?? 0) * 0.9);
      const yMax = (d3.max(allYVals) ?? 1) * 1.1;
      const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerH, 0]);

      // Axes
      g.append('g')
        .attr('transform', `translate(0, ${innerH})`)
        .call(d3.axisBottom(x))
        .selectAll('text')
        .style('font-size', fontSize)
        .style('font-weight', '500');

      g.append('g')
        .call(d3.axisLeft(y).ticks(5))
        .selectAll('text')
        .style('font-size', fontSize);

      // Grid
      g.append('g')
        .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(() => ''))
        .selectAll('line')
        .style('stroke', publicationMode ? '#E0E0E0' : '#E8EAED')
        .style('stroke-dasharray', publicationMode ? 'none' : '3,3');
      g.selectAll('.domain').attr('stroke', '#ccc');

      // Title
      g.append('text')
        .attr('x', innerW / 2)
        .attr('y', -10)
        .attr('text-anchor', 'middle')
        .style('font-size', labelFontSize)
        .style('font-weight', publicationMode ? 'bold' : '600')
        .text(metric.label);

      // Draw group trajectory
      function drawTrajectory(stats: TpStats[], color: string, dashArray: string | null) {
        if (stats.length === 0 || stats.every(s => s.n === 0)) return;
        const validStats = stats.filter(s => s.n > 0);

        // SEM band (area)
        const area = d3.area<TpStats>()
          .x(d => x(d.tp)!)
          .y0(d => y(Math.max(yMin, d.mean - d.sem)))
          .y1(d => y(Math.min(yMax, d.mean + d.sem)))
          .curve(d3.curveMonotoneX);

        g.append('path')
          .datum(validStats)
          .attr('d', area)
          .attr('fill', color)
          .attr('fill-opacity', 0.15);

        // Mean line
        const line = d3.line<TpStats>()
          .x(d => x(d.tp)!)
          .y(d => y(d.mean))
          .curve(d3.curveMonotoneX);

        const path = g.append('path')
          .datum(validStats)
          .attr('d', line)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', publicationMode ? 2.5 : 2);

        if (dashArray) path.attr('stroke-dasharray', dashArray);

        // Data points
        validStats.forEach(s => {
          g.append('circle')
            .attr('cx', x(s.tp)!)
            .attr('cy', y(s.mean))
            .attr('r', publicationMode ? 4 : 3.5)
            .attr('fill', color)
            .attr('stroke', '#fff')
            .attr('stroke-width', 1.5);
        });
      }

      drawTrajectory(diseaseStats, DISEASE_COLOR, null);
      if (hasComparison) {
        drawTrajectory(controlStats, CONTROL_COLOR, null);
      }

      // P-value annotations at each timepoint
      if (hasComparison) {
        for (const tp of allTimepoints) {
          const testResult = allTests.find(t => t.tp === tp && t.metric === metric.key);
          if (!testResult || !testResult.test.valid) continue;
          const p = testResult.adjustedP ?? testResult.test.p;
          if (p >= 0.05) continue;

          const tpX = x(tp)!;
          const dStat = diseaseStats.find(s => s.tp === tp);
          const cStat = controlStats.find(s => s.tp === tp);
          if (!dStat || !cStat) continue;

          // Place star above the higher mean
          const topY = y(Math.max(dStat.mean + dStat.sem, cStat.mean + cStat.sem));

          g.append('text')
            .attr('x', tpX)
            .attr('y', topY - 6)
            .attr('text-anchor', 'middle')
            .style('font-size', pFontSize)
            .style('fill', '#D32F2F')
            .style('font-weight', '600')
            .text(significanceStars(p));
        }
      }
    });

    // Legend
    const legend = svg.append('g')
      .attr('transform', `translate(${margin.left}, ${totalH - 8})`);

    const items: { label: string; color: string; extra?: string }[] = [
      { label: diseaseName, color: DISEASE_COLOR },
    ];
    if (hasComparison) {
      items.push({ label: controlName, color: CONTROL_COLOR });
    }
    items.push({ label: 'Shaded area: ± SEM', color: 'none' });

    let lx = 0;
    items.forEach(item => {
      const lg = legend.append('g').attr('transform', `translate(${lx}, 0)`);
      if (item.color !== 'none') {
        lg.append('line')
          .attr('x1', 0).attr('x2', 16)
          .attr('y1', 5).attr('y2', 5)
          .style('stroke', item.color).style('stroke-width', 2);
        lg.append('circle')
          .attr('cx', 8).attr('cy', 5).attr('r', 3)
          .attr('fill', item.color);
        lg.append('text').attr('x', 20).attr('y', 9).text(item.label)
          .style('font-size', fontSize).style('fill', publicationMode ? '#333' : '#6B7280');
        lx += item.label.length * 7 + 32;
      } else {
        lg.append('text').attr('x', 0).attr('y', 9).text(item.label)
          .style('font-size', '9px').style('fill', '#999').style('font-style', 'italic');
      }
    });
  }
</script>

<div class="chart-wrapper" class:pub-mode={publicationMode} bind:this={container}>
  {#if !needsTrajectory}
    <div class="no-data">
      <p class="no-data-hint">Trajectory requires at least 2 timepoints.</p>
    </div>
  {:else}
    <svg></svg>
  {/if}
</div>

<style>
  .chart-wrapper {
    position: relative;
    width: 100%;
    min-height: 180px;
    overflow: visible;
  }
  .chart-wrapper.pub-mode {
    background: #fff;
  }
  .no-data {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 120px;
    text-align: center;
  }
  .no-data-hint {
    font-size: var(--text-xs, 11px);
    color: var(--text-tertiary, #999);
    margin: 0;
  }
</style>
