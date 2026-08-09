<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { GroupTimepointMetrics } from '../../utils/repertoire-metrics';
  import { wilcoxonRankSum, benjaminiHochberg, formatPValue, significanceStars } from '../../utils/statistics';

  /**
   * Per-sample metrics for disease group.
   * Each entry = one patient/file at a specific timepoint.
   */
  export let diseaseData: GroupTimepointMetrics[] = [];
  /** Per-sample metrics for control group. */
  export let controlData: GroupTimepointMetrics[] = [];
  /** Disease cohort display name */
  export let diseaseName: string = 'Disease';
  /** Control cohort display name */
  export let controlName: string = 'Control';
  /** Whether to render in publication mode */
  export let publicationMode: boolean = false;

  let container: HTMLDivElement;
  let width = 800;
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

  const ISOTYPE_COLORS: Record<string, string> = {
    IgM: '#E85D04',
    IgD: '#9B59B6',
    IgG: '#0066CC',
    IgA: '#2D9F3F',
    IgE: '#E74C3C'
  };

  const ISOTYPES = ['IgM', 'IgG', 'IgA', 'IgD', 'IgE'];

  const DISEASE_COLOR = '#1565C0';
  const CONTROL_COLOR = '#757575';

  $: hasComparison = diseaseData.length > 0 && controlData.length > 0;

  // Check if any data has isotype info
  $: hasIsotypeData = [...diseaseData, ...controlData].some(
    m => m.isotypeFreqs.some(f => f.count > 0)
  );

  // Collect unique timepoints
  $: allTimepoints = (() => {
    const tps = new Set<string>();
    for (const m of diseaseData) tps.add(m.timepointLabel);
    for (const m of controlData) tps.add(m.timepointLabel);
    return [...tps].sort();
  })();

  // Group data by timepoint
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

  /** Get per-patient frequency for a specific isotype from a patient's metrics */
  function getIsotypeFreq(m: GroupTimepointMetrics, isotype: string): number {
    const entry = m.isotypeFreqs.find(f => f.isotype === isotype);
    return entry ? entry.frequency : 0;
  }

  /** Compute mean and SEM for an array */
  function meanSEM(values: number[]): { mean: number; sem: number } {
    if (values.length === 0) return { mean: 0, sem: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (values.length === 1) return { mean, sem: 0 };
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    const sem = Math.sqrt(variance) / Math.sqrt(values.length);
    return { mean, sem };
  }

  // ── Draw chart ────────────────────────────────────────────
  $: if (container && hasIsotypeData && (diseaseData.length > 0 || controlData.length > 0)) {
    drawChart(width, publicationMode);
  }
  $: if (container && !hasIsotypeData) {
    const svg = container?.querySelector('svg');
    if (svg) d3.select(svg).selectAll('*').remove();
  }

  function drawChart(w: number, _pubMode: boolean = false) {
    if (!container) return;
    const svg = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    const nTp = allTimepoints.length;

    // Filter to isotypes that have non-zero values in at least one patient
    const allPatientData = [...diseaseData, ...controlData];
    const activeIsotypes = ISOTYPES.filter(iso =>
      allPatientData.some(m => getIsotypeFreq(m, iso) > 0)
    );
    const nIso = activeIsotypes.length;
    if (nIso === 0) return;

    // Layout: one column per timepoint, within each column horizontal grouped bars per isotype
    const margin = publicationMode
      ? { top: 24, right: 28, bottom: 52, left: 54 }
      : { top: 16, right: 20, bottom: 44, left: 46 };
    const colGap = 40;
    const legendHeight = 44;
    const barGroupHeight = publicationMode ? 44 : 36; // height per isotype row
    const chartHeight = nIso * barGroupHeight;
    const totalHeight = chartHeight + margin.top + margin.bottom + legendHeight;

    const availW = w - margin.left - margin.right;
    const colW = (availW - (nTp - 1) * colGap) / nTp;
    const barMaxW = colW - 10; // max bar width within a column

    svg.attr('width', w).attr('height', totalHeight);

    if (publicationMode) {
      svg.style('font-family', 'Arial, Helvetica, sans-serif');
    }

    const fontSize = publicationMode ? '12px' : '10px';
    const labelFontSize = publicationMode ? '13px' : '11px';

    // Compute all mean frequencies to determine x-scale
    let globalMax = 0;
    for (const tp of allTimepoints) {
      const dData = diseasByTp.get(tp) ?? [];
      const cData = controlByTp.get(tp) ?? [];
      for (const iso of activeIsotypes) {
        const dVals = dData.map(m => getIsotypeFreq(m, iso));
        const cVals = cData.map(m => getIsotypeFreq(m, iso));
        const dStats = meanSEM(dVals);
        const cStats = meanSEM(cVals);
        globalMax = Math.max(globalMax, dStats.mean + dStats.sem, cStats.mean + cStats.sem);
      }
    }
    globalMax = Math.min(1, globalMax * 1.15); // cap at 100%, add 15% padding

    // Collect all test p-values for BH correction
    interface IsoTest {
      tp: string;
      iso: string;
      test: ReturnType<typeof wilcoxonRankSum>;
      adjustedP?: number;
    }
    const allTests: IsoTest[] = [];
    if (hasComparison) {
      // Test ALL isotypes (including zero-data ones) for correct BH correction pool
      for (const tp of allTimepoints) {
        const dData = diseasByTp.get(tp) ?? [];
        const cData = controlByTp.get(tp) ?? [];
        for (const iso of ISOTYPES) {
          const dVals = dData.map(m => getIsotypeFreq(m, iso));
          const cVals = cData.map(m => getIsotypeFreq(m, iso));
          const test = wilcoxonRankSum(dVals, cVals);
          allTests.push({ tp, iso, test });
        }
      }
      const validIdx = allTests.map((t, i) => t.test.valid ? i : -1).filter(i => i >= 0);
      const validPs = validIdx.map(i => allTests[i].test.p);
      const adjusted = benjaminiHochberg(validPs);
      validIdx.forEach((idx, j) => { allTests[idx].adjustedP = adjusted[j]; });
    }

    // Draw each timepoint column
    allTimepoints.forEach((tp, tpIdx) => {
      const colX = margin.left + tpIdx * (colW + colGap);
      const dData = diseasByTp.get(tp) ?? [];
      const cData = controlByTp.get(tp) ?? [];

      const colG = svg.append('g')
        .attr('transform', `translate(${colX}, ${margin.top})`);

      // X scale for bars (0 → globalMax as proportion)
      const x = d3.scaleLinear()
        .domain([0, globalMax])
        .range([0, barMaxW]);

      // Y scale for isotypes
      const yIso = d3.scaleBand()
        .domain(activeIsotypes)
        .range([0, chartHeight])
        .paddingInner(0.25)
        .paddingOuter(0.1);

      const barH = hasComparison ? yIso.bandwidth() / 2 - 1 : yIso.bandwidth() - 2;

      // Axis at bottom
      colG.append('g')
        .attr('transform', `translate(0, ${chartHeight})`)
        .call(d3.axisBottom(x).ticks(4).tickFormat(d => `${(+d * 100).toFixed(0)}%`))
        .selectAll('text')
        .style('font-size', fontSize);

      // Grid lines
      colG.append('g')
        .call(d3.axisBottom(x).ticks(4).tickSize(-chartHeight).tickFormat(() => ''))
        .attr('transform', `translate(0, ${chartHeight})`)
        .selectAll('line')
        .style('stroke', publicationMode ? '#E0E0E0' : '#E8EAED')
        .style('stroke-dasharray', publicationMode ? 'none' : '3,3');
      colG.selectAll('.domain').remove();

      // Isotype labels (only on first column)
      if (tpIdx === 0) {
        activeIsotypes.forEach(iso => {
          const isoY = yIso(iso)! + yIso.bandwidth() / 2;
          colG.append('text')
            .attr('x', -6)
            .attr('y', isoY)
            .attr('text-anchor', 'end')
            .attr('dominant-baseline', 'middle')
            .style('font-size', fontSize)
            .style('font-weight', '600')
            .style('fill', ISOTYPE_COLORS[iso])
            .text(iso);
        });
      }

      // Bars for each isotype
      activeIsotypes.forEach(iso => {
        const isoY = yIso(iso)!;
        const dVals = dData.map(m => getIsotypeFreq(m, iso));
        const cVals = cData.map(m => getIsotypeFreq(m, iso));
        const dStats = meanSEM(dVals);
        const cStats = meanSEM(cVals);

        // Disease bar (top)
        if (dVals.length > 0) {
          const barY = hasComparison ? isoY : isoY + 1;
          colG.append('rect')
            .attr('x', 0)
            .attr('y', barY)
            .attr('width', Math.max(0, x(dStats.mean)))
            .attr('height', barH)
            .attr('fill', DISEASE_COLOR)
            .attr('fill-opacity', 0.7)
            .attr('rx', 2);

          // SEM error bar
          if (dStats.sem > 0) {
            const errX = x(dStats.mean);
            const errTop = x(Math.min(globalMax, dStats.mean + dStats.sem));
            const errBot = x(Math.max(0, dStats.mean - dStats.sem));
            const errY = barY + barH / 2;
            colG.append('line')
              .attr('x1', errBot).attr('x2', errTop)
              .attr('y1', errY).attr('y2', errY)
              .style('stroke', DISEASE_COLOR).style('stroke-width', 1.2);
            // Caps
            colG.append('line')
              .attr('x1', errTop).attr('x2', errTop)
              .attr('y1', errY - 3).attr('y2', errY + 3)
              .style('stroke', DISEASE_COLOR).style('stroke-width', 1.2);
            colG.append('line')
              .attr('x1', errBot).attr('x2', errBot)
              .attr('y1', errY - 3).attr('y2', errY + 3)
              .style('stroke', DISEASE_COLOR).style('stroke-width', 1.2);
          }
        }

        // Control bar (bottom)
        if (hasComparison && cVals.length > 0) {
          const barY = isoY + barH + 2;
          colG.append('rect')
            .attr('x', 0)
            .attr('y', barY)
            .attr('width', Math.max(0, x(cStats.mean)))
            .attr('height', barH)
            .attr('fill', CONTROL_COLOR)
            .attr('fill-opacity', 0.6)
            .attr('rx', 2);

          // SEM error bar
          if (cStats.sem > 0) {
            const errX = x(cStats.mean);
            const errTop = x(Math.min(globalMax, cStats.mean + cStats.sem));
            const errBot = x(Math.max(0, cStats.mean - cStats.sem));
            const errY = barY + barH / 2;
            colG.append('line')
              .attr('x1', errBot).attr('x2', errTop)
              .attr('y1', errY).attr('y2', errY)
              .style('stroke', CONTROL_COLOR).style('stroke-width', 1.2);
            colG.append('line')
              .attr('x1', errTop).attr('x2', errTop)
              .attr('y1', errY - 3).attr('y2', errY + 3)
              .style('stroke', CONTROL_COLOR).style('stroke-width', 1.2);
            colG.append('line')
              .attr('x1', errBot).attr('x2', errBot)
              .attr('y1', errY - 3).attr('y2', errY + 3)
              .style('stroke', CONTROL_COLOR).style('stroke-width', 1.2);
          }
        }

        // P-value annotation (right side of bars)
        if (hasComparison) {
          const testResult = allTests.find(t => t.tp === tp && t.iso === iso);
          if (testResult) {
            const isoMid = isoY + yIso.bandwidth() / 2;
            const maxBarEnd = Math.max(x(dStats.mean + dStats.sem), x(cStats.mean + cStats.sem));
            const labelX = Math.min(barMaxW - 2, maxBarEnd + 6);

            if (testResult.test.valid) {
              const p = testResult.adjustedP ?? testResult.test.p;
              const isSignificant = p < 0.05;
              const pLabel = colG.append('text')
                .attr('x', labelX)
                .attr('y', isoMid)
                .attr('dominant-baseline', 'middle')
                .style('font-size', publicationMode ? '10px' : '8px')
                .style('fill', isSignificant ? '#D32F2F' : '#aaa')
                .text(isSignificant ? `${formatPValue(p)} ${significanceStars(p)}` : formatPValue(p));

              if (!publicationMode) {
                pLabel.append('title').text(
                  `${iso}: ${formatPValue(p)} (BH-adjusted)\n` +
                  `r = ${testResult.test.r.toFixed(3)}, n = ${testResult.test.n1}+${testResult.test.n2}`
                );
              }
            } else {
              colG.append('text')
                .attr('x', labelX)
                .attr('y', isoMid)
                .attr('dominant-baseline', 'middle')
                .style('font-size', '7px')
                .style('fill', '#ccc')
                .text('n too small');
            }
          }
        }
      });

      // Timepoint label below
      colG.append('text')
        .attr('x', barMaxW / 2)
        .attr('y', chartHeight + 32)
        .attr('text-anchor', 'middle')
        .style('font-size', labelFontSize)
        .style('font-weight', '600')
        .style('fill', '#444')
        .text(tp);
    });

    // Legend
    const legendY = totalHeight - legendHeight + 4;
    const items: { label: string; color: string }[] = [];
    if (diseaseData.length > 0) {
      items.push({ label: diseaseName, color: DISEASE_COLOR });
    }
    if (hasComparison) {
      items.push({ label: controlName, color: CONTROL_COLOR });
    }
    items.push({ label: 'Error bars: ± SEM', color: 'none' });

    let legendX = margin.left;
    items.forEach((item) => {
      const lg = svg.append('g').attr('transform', `translate(${legendX}, ${legendY})`);
      if (item.color !== 'none') {
        lg.append('rect').attr('width', 12).attr('height', 12).attr('rx', 2)
          .attr('fill', item.color).attr('fill-opacity', 0.7);
        lg.append('text').attr('x', 16).attr('y', 10).text(item.label)
          .style('font-size', fontSize).style('fill', publicationMode ? '#333' : '#6B7280');
        legendX += item.label.length * 7 + 28;
      } else {
        lg.append('text').attr('x', 0).attr('y', 10).text(item.label)
          .style('font-size', '9px').style('fill', '#999').style('font-style', 'italic');
      }
    });
  }

  // ── Tooltip ──────────────────────
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

<div class="chart-wrapper" class:pub-mode={publicationMode} bind:this={container}>
  {#if !hasIsotypeData}
    <div class="no-data">
      <p class="no-data-title">No isotype data available</p>
      <p class="no-data-hint">Isotype comparison requires C gene annotation (IgG/IgM/IgA/IgD/IgE).</p>
    </div>
  {:else if diseaseData.length === 0 && controlData.length === 0}
    <div class="no-data">
      <p class="no-data-title">No per-patient data available.</p>
    </div>
  {:else}
    <svg></svg>
    {#if tooltipVisible}
      <div class="tooltip" style={tooltipStyle}>
        {#each tooltipText.split('\n') as line}
          <div>{line}</div>
        {/each}
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
  .chart-wrapper.pub-mode {
    background: #fff;
  }
  .no-data {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 160px;
    text-align: center;
  }
  .no-data-title {
    font-size: var(--text-sm, 13px);
    font-weight: 600;
    color: var(--text-secondary, #666);
    margin: 0 0 4px 0;
  }
  .no-data-hint {
    font-size: var(--text-xs, 11px);
    color: var(--text-tertiary, #999);
    margin: 0;
  }
  .tooltip {
    position: absolute;
    pointer-events: none;
    background: var(--gray-800, #1f2937);
    color: #fff;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.4;
    white-space: nowrap;
    z-index: 100;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
</style>
