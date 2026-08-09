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

  const METRIC_TOOLTIPS: Record<string, string> = {
    Shannon: 'Shannon entropy: diversity measure. Higher = more diverse repertoire.',
    Simpson: 'Simpson diversity index: probability two random sequences are from different clones.',
    Chao1: 'Chao1 richness estimator: predicts total clone diversity from singletons/doubletons.',
    Gini: 'Gini index: clonal inequality. 0 = even distribution, 1 = one clone dominates.',
    'Mean SHM': 'Mean somatic hypermutation count per sequence (affinity maturation level).',
    D50: 'Number of largest clones needed to cover 50% of sequences. Lower = more focused response.'
  };

  function drawChart(metrics: GroupTimepointMetrics[], w: number) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    const rows: (readonly string[])[] = [
      ['Shannon', 'Simpson', 'Chao1'],
      ['Gini', 'Mean SHM', 'D50']
    ];
    const cols = 3;
    const margin = { top: 24, right: 16, bottom: 36, left: 42 };
    const rowHeight = 220;
    const rowGap = 32;
    const legendHeight = 28;
    const totalHeight = rows.length * rowHeight + (rows.length - 1) * rowGap + legendHeight;
    const totalInnerW = w - margin.left - margin.right;
    const chartW = totalInnerW / cols;
    const innerH = rowHeight - margin.top - margin.bottom;

    type BarDatum = { metric: string; label: string; value: number; color: string };
    const bars: BarDatum[] = [];
    for (const m of metrics) {
      const label = `${m.groupName} / ${m.timepointLabel}`;
      bars.push({ metric: 'Shannon', label, value: m.diversity.shannonEntropy, color: m.groupColor });
      bars.push({ metric: 'Simpson', label, value: m.diversity.simpsonIndex, color: m.groupColor });
      bars.push({ metric: 'Chao1', label, value: m.diversity.chao1, color: m.groupColor });
      bars.push({ metric: 'Gini', label, value: m.diversity.giniIndex, color: m.groupColor });
      bars.push({ metric: 'Mean SHM', label, value: m.diversity.meanSHM, color: m.groupColor });
      bars.push({ metric: 'D50', label, value: m.diversity.d50, color: m.groupColor });
    }
    const labels = [...new Set(bars.map(b => b.label))];

    svg.attr('width', w).attr('height', totalHeight);

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const rowMetrics = rows[rowIdx];
      const rowY = rowIdx * (rowHeight + rowGap);

      for (let colIdx = 0; colIdx < rowMetrics.length; colIdx++) {
        const metric = rowMetrics[colIdx];
        const metricBars = bars.filter(b => b.metric === metric);
        const x0 = chartW * colIdx;

        const yMax = d3.max(metricBars, (b: any) => b.value) || 1;
        const y = d3.scaleLinear().domain([0, yMax * 1.1]).nice().range([innerH, 0]);

        const colG = svg.append('g')
          .attr('transform', `translate(${margin.left + x0},${rowY + margin.top})`);

        const x1 = d3.scaleBand()
          .domain(labels)
          .range([0, chartW - 4])
          .padding(0.08);

        colG.append('g')
          .call(d3.axisLeft(y).ticks(5))
          .selectAll('text')
          .style('font-size', '10px');

        colG.append('g')
          .attr('class', 'grid')
          .call(d3.axisLeft(y).ticks(5).tickSize(-(chartW - 4)).tickFormat(() => ''))
          .selectAll('line')
          .style('stroke', '#E8EAED')
          .style('stroke-dasharray', '3,3');
        colG.selectAll('.grid .domain').remove();

        colG.selectAll('rect')
          .data(metricBars)
          .join('rect')
          .attr('x', (d: any) => x1(d.label) || 0)
          .attr('y', (d: any) => y(d.value))
          .attr('width', x1.bandwidth())
          .attr('height', (d: any) => innerH - y(d.value))
          .attr('rx', 3)
          .attr('fill', (d: any) => d.color)
          .attr('opacity', 0.85)
          .on('mouseenter', function(this: any, event: any, d: any) {
            d3.select(this).attr('opacity', 1);
            showTooltip(event, d);
          })
          .on('mouseleave', function(this: any) {
            d3.select(this).attr('opacity', 0.85);
            hideTooltip();
          });

        const labelG = colG.append('g')
          .attr('cursor', 'help')
          .attr('transform', `translate(${(chartW - 4) / 2}, ${innerH + 20})`);
        labelG.append('title').text(METRIC_TOOLTIPS[metric] || metric);
        labelG.append('text')
          .attr('x', 0)
          .attr('y', 0)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .style('font-size', '12px')
          .style('font-weight', '600')
          .text(metric);
      }
    }

    const legend = svg.append('g')
      .attr('transform', `translate(${margin.left}, ${totalHeight - 10})`);
    labels.forEach((label, i) => {
      const color = bars.find(b => b.label === label)?.color || '#999';
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

  function showTooltip(event: MouseEvent, d: { metric: string; label: string; value: number }) {
    tooltipText = `${d.label}\n${d.metric}: ${d.value.toFixed(3)}`;
    const containerW = container?.offsetWidth ?? 0;
    const tipW = 160;
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
    min-height: 500px;
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
