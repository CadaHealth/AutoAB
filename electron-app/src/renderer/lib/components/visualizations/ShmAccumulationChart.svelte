<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { LongitudinalGroupData, TrackedClone } from '../../utils/repertoire-metrics';
  import { wilcoxonRankSum, formatPValue, significanceStars } from '../../utils/statistics';

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
  $: if (container && data.length === 0) {
    const svg = container?.querySelector('svg');
    if (svg) d3.select(svg).selectAll('*').remove();
  }

  interface CloneDelta {
    delta: number;
    cloneId: number;
    lineageId?: number;
    firstTp: string;
    lastTp: string;
    firstSHM: number;
    lastSHM: number;
    totalSize: number;
    status: string;
  }

  /**
   * For each tracked clone (present in ≥2 timepoints with SHM data),
   * compute ΔSHM = SHM(last appearance) - SHM(first appearance).
   */
  function computeDeltaSHM(grp: LongitudinalGroupData): CloneDelta[] {
    const results: CloneDelta[] = [];
    for (const clone of grp.trackedClones) {
      let firstIdx = -1, lastIdx = -1;
      for (let i = 0; i < clone.timepointSizes.length; i++) {
        if ((clone.timepointSizes[i]?.size ?? 0) > 0 && clone.meanSHM[i] > 0) {
          if (firstIdx < 0) firstIdx = i;
          lastIdx = i;
        }
      }
      if (firstIdx >= 0 && lastIdx > firstIdx) {
        const status = clone.persistent ? 'persistent' : clone.expanding ? 'expanding' : clone.contracting ? 'contracting' : 'transient';
        results.push({
          delta: clone.meanSHM[lastIdx] - clone.meanSHM[firstIdx],
          cloneId: clone.cloneId,
          lineageId: clone.lineageId,
          firstTp: grp.timepointLabels[firstIdx],
          lastTp: grp.timepointLabels[lastIdx],
          firstSHM: clone.meanSHM[firstIdx],
          lastSHM: clone.meanSHM[lastIdx],
          totalSize: clone.totalSize,
          status
        });
      }
    }
    return results;
  }

  /** Simple deterministic pseudo-random for jitter (0-1) */
  function seededRandom(seed: number): number {
    const x = Math.sin(seed + 1) * 43758.5453;
    return x - Math.floor(x);
  }

  function drawChart(groups: LongitudinalGroupData[], w: number) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    // Compute ΔSHM per group
    const groupDeltas = groups.map(grp => ({
      name: grp.groupName,
      color: grp.groupColor,
      deltas: computeDeltaSHM(grp)
    }));

    const hasData = groupDeltas.some(g => g.deltas.length > 0);
    if (!hasData) {
      svg.attr('width', w).attr('height', 100);
      svg.append('text').attr('x', w / 2).attr('y', 50)
        .attr('text-anchor', 'middle').style('fill', '#9BA3AF').style('font-size', '12px')
        .text('No tracked clones with SHM data across timepoints');
      return;
    }

    const margin = { top: 28, right: 50, bottom: 60, left: 55 };
    const chartH = 320;
    const totalH = chartH;
    // Cap width so boxplots don't spread too far
    const nGroups = groupDeltas.filter(gd => gd.deltas.length > 0).length;
    const maxW = Math.min(w, nGroups * 200 + margin.left + margin.right + 60);
    const innerW = maxW - margin.left - margin.right;
    const innerH = chartH - margin.top - margin.bottom;
    const offsetX = (w - maxW) / 2;

    svg.attr('width', w).attr('height', totalH);

    const g = svg.append('g')
      .attr('transform', `translate(${offsetX + margin.left}, ${margin.top})`);


    // Y scale: show full range, outliers are the interesting clones here
    const allDeltaVals = groupDeltas.flatMap(gd => gd.deltas.map(d => d.delta));
    const rawMin = d3.min(allDeltaVals) ?? -1;
    const rawMax = d3.max(allDeltaVals) ?? 1;
    // Always include zero and add symmetric padding
    const absMax = Math.max(Math.abs(rawMin), Math.abs(rawMax), 0.5);
    const yPad = absMax * 0.15;
    const y = d3.scaleLinear()
      .domain([-(absMax + yPad), absMax + yPad])
      .nice()
      .range([innerH, 0]);

    // X scale: one band per group
    const groupNames = groupDeltas.filter(gd => gd.deltas.length > 0).map(gd => gd.name);
    const xBand = d3.scaleBand()
      .domain(groupNames)
      .range([0, innerW])
      .paddingInner(0.4)
      .paddingOuter(0.2);

    // Y axis
    g.append('g').call(d3.axisLeft(y).ticks(6))
      .selectAll('text').style('font-size', '10px');

    // Grid
    g.append('g')
      .call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickFormat(() => ''))
      .selectAll('line').style('stroke', '#E8EAED').style('stroke-dasharray', '3,3');
    g.selectAll('.domain').attr('stroke', '#ccc');

    // Zero reference line (bold)
    g.append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', y(0)).attr('y2', y(0))
      .style('stroke', '#333')
      .style('stroke-width', 1.5)
      .style('stroke-dasharray', '6,3');

    // Zero label
    g.append('text')
      .attr('x', innerW + 4)
      .attr('y', y(0) + 3)
      .style('font-size', '9px')
      .style('fill', '#666')
      .text('no change');

    // Y-axis label
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2).attr('y', -42)
      .attr('text-anchor', 'middle')
      .style('font-size', '11px').style('fill', '#6B7280')
      .text('ΔSHM (last − first timepoint)');

    // Annotations
    g.append('text')
      .attr('x', -8).attr('y', y(y.domain()[1]) + 12)
      .style('font-size', '8px').style('fill', '#4CAF50').style('font-style', 'italic')
      .text('↑ accumulating');
    g.append('text')
      .attr('x', -8).attr('y', y(y.domain()[0]) - 4)
      .style('font-size', '8px').style('fill', '#F44336').style('font-style', 'italic')
      .text('↓ declining');

    // Draw boxplot for each group
    for (const gd of groupDeltas) {
      if (gd.deltas.length === 0) continue;

      const cx = xBand(gd.name)! + xBand.bandwidth() / 2;
      const boxW = Math.min(xBand.bandwidth() * 0.5, 60);
      const halfBox = boxW / 2;
      const deltaVals = gd.deltas.map(d => d.delta);
      const sorted = [...deltaVals].sort((a, b) => a - b);
      const n = sorted.length;

      const q1 = d3.quantile(sorted, 0.25)!;
      const median = d3.quantile(sorted, 0.5)!;
      const q3 = d3.quantile(sorted, 0.75)!;
      const iqr = q3 - q1;
      const whiskerLow = Math.max(sorted[0], q1 - 1.5 * iqr);
      const whiskerHigh = Math.min(sorted[n - 1], q3 + 1.5 * iqr);

      // Box (drawn in clipped group)
      g.append('rect')
        .attr('x', cx - halfBox)
        .attr('y', y(q3))
        .attr('width', boxW)
        .attr('height', Math.max(1, y(q1) - y(q3)))
        .attr('fill', gd.color)
        .attr('fill-opacity', 0.3)
        .attr('stroke', gd.color)
        .attr('stroke-width', 1.2);

      // Median line
      g.append('line')
        .attr('x1', cx - halfBox).attr('x2', cx + halfBox)
        .attr('y1', y(median)).attr('y2', y(median))
        .style('stroke', gd.color).style('stroke-width', 2);

      // Whiskers
      g.append('line').attr('x1', cx).attr('x2', cx)
        .attr('y1', y(q1)).attr('y2', y(whiskerLow))
        .style('stroke', gd.color).style('stroke-width', 1.2);
      g.append('line').attr('x1', cx - halfBox).attr('x2', cx + halfBox)
        .attr('y1', y(whiskerLow)).attr('y2', y(whiskerLow))
        .style('stroke', gd.color).style('stroke-width', 1.2);
      g.append('line').attr('x1', cx).attr('x2', cx)
        .attr('y1', y(q3)).attr('y2', y(whiskerHigh))
        .style('stroke', gd.color).style('stroke-width', 1.2);
      g.append('line').attr('x1', cx - halfBox).attr('x2', cx + halfBox)
        .attr('y1', y(whiskerHigh)).attr('y2', y(whiskerHigh))
        .style('stroke', gd.color).style('stroke-width', 1.2);

      // Jittered data points, outliers (far from 0) are larger and bolder
      const jitterW = boxW * 0.7;
      const outlierThreshold = iqr > 0 ? 1.5 * iqr : 1;
      gd.deltas.forEach((cd, i) => {
        const jitter = (seededRandom(i * 7 + cd.delta * 13) - 0.5) * jitterW;
        const isOutlier = Math.abs(cd.delta) > outlierThreshold;
        g.append('circle')
          .attr('cx', cx + jitter)
          .attr('cy', y(cd.delta))
          .attr('r', isOutlier ? 4 : 2.5)
          .attr('fill', gd.color)
          .attr('fill-opacity', isOutlier ? 0.85 : 0.45)
          .attr('stroke', isOutlier ? '#fff' : '#fff')
          .attr('stroke-width', isOutlier ? 1.5 : 0.5)
          .style('cursor', 'pointer')
          .on('mouseenter', function(this: any, event: MouseEvent) {
            d3.select(this).attr('r', isOutlier ? 6 : 4).attr('fill-opacity', 1);
            const label = cd.lineageId != null ? `Lineage ${cd.lineageId}` : `Clone ${cd.cloneId}`;
            const shmStatus = cd.delta > 0.5 ? 'maturing' : cd.delta < -0.5 ? 'declining' : 'stable';
            showTooltip(event,
              `${label} (SHM ${shmStatus})\n` +
              `${cd.firstTp}: SHM = ${cd.firstSHM.toFixed(1)}\n` +
              `${cd.lastTp}: SHM = ${cd.lastSHM.toFixed(1)}\n` +
              `ΔSHM = ${cd.delta > 0 ? '+' : ''}${cd.delta.toFixed(2)}\n` +
              `${cd.totalSize} sequences across ${cd.status} clone`
            );
          })
          .on('mouseleave', function(this: any) {
            d3.select(this).attr('r', isOutlier ? 4 : 2.5).attr('fill-opacity', isOutlier ? 0.85 : 0.45);
            hideTooltip();
          });
      });

      // Group label + stats below
      const nAccumulating = gd.deltas.filter(d => d.delta > 0).length;
      const pctAccumulating = Math.round((nAccumulating / n) * 100);

      g.append('text')
        .attr('x', cx).attr('y', innerH + 18)
        .attr('text-anchor', 'middle')
        .style('font-size', '11px').style('font-weight', '600').style('fill', gd.color)
        .text(gd.name.replace(/ – All Samples/, ''));

      g.append('text')
        .attr('x', cx).attr('y', innerH + 30)
        .attr('text-anchor', 'middle')
        .style('font-size', '9px').style('fill', '#888')
        .text(`n=${n} clones`);

      g.append('text')
        .attr('x', cx).attr('y', innerH + 42)
        .attr('text-anchor', 'middle')
        .style('font-size', '9px').style('fill', pctAccumulating > 50 ? '#4CAF50' : '#888')
        .text(`${pctAccumulating}% accumulating`);
    }

    // Statistical test between groups if 2 groups
    const testable = groupDeltas.filter(gd => gd.deltas.length >= 3);
    if (testable.length === 2) {
      const g1 = testable[0];
      const g2 = testable[1];
      const test = wilcoxonRankSum(g1.deltas.map(d => d.delta), g2.deltas.map(d => d.delta));

      if (test.valid) {
        const pText = formatPValue(test.p);
        const stars = significanceStars(test.p);
        const isSignificant = test.p < 0.05;

        const x1 = xBand(g1.name)! + xBand.bandwidth() / 2;
        const x2 = xBand(g2.name)! + xBand.bandwidth() / 2;
        const bracketY = 4;
        const bracketTop = -4;

        g.append('line').attr('x1', x1).attr('y1', bracketY).attr('x2', x1).attr('y2', bracketTop).style('stroke', '#666').style('stroke-width', 1);
        g.append('line').attr('x1', x1).attr('y1', bracketTop).attr('x2', x2).attr('y2', bracketTop).style('stroke', '#666').style('stroke-width', 1);
        g.append('line').attr('x1', x2).attr('y1', bracketY).attr('x2', x2).attr('y2', bracketTop).style('stroke', '#666').style('stroke-width', 1);

        g.append('text')
          .attr('x', (x1 + x2) / 2)
          .attr('y', bracketTop - 6)
          .attr('text-anchor', 'middle')
          .style('font-size', '10px')
          .style('fill', isSignificant ? '#D32F2F' : '#888')
          .text(stars !== 'ns' ? `${pText} ${stars}` : pText);
      }
    }
  }

  // ── Tooltip ──────────────────────
  let tooltipStyle = '';
  let tooltipText = '';
  let tooltipVisible = false;

  function showTooltip(event: MouseEvent, text: string) {
    tooltipText = text;
    const containerW = container?.offsetWidth ?? 0;
    const tipW = 220;
    const x = event.offsetX;
    let left = x + 14;
    if (left + tipW > containerW) left = x - tipW - 14;
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
    min-height: 260px;
  }
  .tooltip {
    position: absolute;
    pointer-events: none;
    background: var(--gray-800, #1f2937);
    color: #fff;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.5;
    white-space: nowrap;
    z-index: 100;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  }
</style>
