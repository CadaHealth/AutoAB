<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { GroupTimepointMetrics } from '../../utils/repertoire-metrics';

  /**
   * Sequencing depth per donor, as a diagnostic.
   *
   * This panel deliberately runs no statistical test and shows no p-value.
   * Depth is a precondition of every clone-derived metric, not a hypothesis
   * about the cohorts, and any p-value printed here would sooner or later be
   * quoted as though it belonged to the corrected family. It also lives in its
   * own component rather than as a ninth entry in GroupComparisonChart's
   * METRICS array, because that array defines the BH-FDR pool: adding a ninth
   * metric would silently turn 8 x 3 = 24 tests into 27 and move every
   * adjusted p-value the study has already reported.
   *
   * The quantity plotted is diversity.clonedSequences, not totalSequences.
   * The latter counts light chains too, which never reach DefineClones, and
   * the inflation differs per donor.
   */
  export let diseaseData: GroupTimepointMetrics[] = [];
  export let controlData: GroupTimepointMetrics[] = [];
  export let diseaseName: string = 'Disease';
  export let controlName: string = 'Control';
  export let publicationMode: boolean = false;

  /** N-cohort input, mirrors GroupComparisonChart's prop of the same name. */
  export let cohortsData: { name: string; color: string; data: GroupTimepointMetrics[] }[] | null = null;

  const DISEASE_COLOR = '#1565C0';
  const CONTROL_COLOR = '#757575';

  $: cohorts = cohortsData ?? ([
    { name: diseaseName, color: DISEASE_COLOR, data: diseaseData },
    { name: controlName, color: CONTROL_COLOR, data: controlData },
  ].filter(c => c.data.length > 0));

  const depthOf = (m: GroupTimepointMetrics) => m.diversity.clonedSequences;

  $: timepoints = (() => {
    const tps = new Set<string>();
    for (const c of cohorts) for (const m of c.data) tps.add(m.timepointLabel);
    return [...tps].sort();
  })();

  /** Median depth and n per cohort per timepoint, plus the between-cohort ratio. */
  $: summary = timepoints.map((tp) => {
    const per = cohorts.map((c) => {
      const vals = c.data.filter(m => m.timepointLabel === tp).map(depthOf).sort((a, b) => a - b);
      return { name: c.name, color: c.color, n: vals.length, median: d3.quantile(vals, 0.5) ?? 0 };
    }).filter(p => p.n > 0);
    // Ratio is only meaningful between exactly two cohorts; with more, the
    // largest-over-smallest median is reported instead.
    const meds = per.map(p => p.median).filter(v => v > 0);
    const ratio = meds.length >= 2 ? Math.max(...meds) / Math.min(...meds) : null;
    return { tp, per, ratio };
  });

  /** Largest median ratio across timepoints, used for the summary sentence. */
  $: worstRatio = summary.reduce((a, s) => (s.ratio !== null && s.ratio > a ? s.ratio : a), 0);

  let container: HTMLDivElement;
  let svgEl: SVGSVGElement;
  let width = 800;
  let ro: ResizeObserver;

  onMount(() => {
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) width = entry.contentRect.width;
    });
    ro.observe(container);
  });
  onDestroy(() => { ro?.disconnect(); });

  $: if (svgEl && width > 0 && cohorts.length > 0) draw();

  function draw() {
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    if (timepoints.length === 0) return;

    const margin = publicationMode
      ? { top: 16, right: 24, bottom: 56, left: 66 }
      : { top: 16, right: 20, bottom: 52, left: 58 };
    const rowHeight = publicationMode ? 190 : 175;
    const legendHeight = 32;
    const innerW = Math.max(120, width - margin.left - margin.right);
    const totalHeight = rowHeight + margin.top + margin.bottom + legendHeight;

    svg.attr('width', width).attr('height', totalHeight);
    if (publicationMode) svg.style('font-family', 'Arial, Helvetica, sans-serif');

    const fontSize = publicationMode ? '11px' : '10px';
    const labelFontSize = publicationMode ? '12px' : '11px';

    const allVals: number[] = [];
    for (const c of cohorts) for (const m of c.data) allVals.push(depthOf(m));
    if (allVals.length === 0) return;

    // Log scale: donor depth spans 1 to several hundred in real studies, and on
    // a linear axis the shallow donors, which are the whole point of this
    // panel, collapse onto the baseline. Domain starts at 1 because a donor
    // with a single clone-assigned sequence is exactly what must stay visible.
    const rawMax = d3.max(allVals) ?? 10;
    const y = d3.scaleLog()
      .domain([1, Math.max(10, rawMax * 1.25)])
      .range([rowHeight, 0])
      .clamp(true);

    const xTp = d3.scaleBand().domain(timepoints).range([0, innerW]).paddingInner(0.3).paddingOuter(0.15);
    const g = svg.append('g').attr('transform', `translate(${margin.left}, ${margin.top})`);

    g.append('g')
      .call(d3.axisLeft(y).ticks(5, '~s'))
      .selectAll('text').style('font-size', fontSize);

    g.append('g')
      .attr('class', 'grid')
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(() => ''))
      .selectAll('line')
      .style('stroke', publicationMode ? '#E0E0E0' : '#E8EAED')
      .style('stroke-dasharray', publicationMode ? 'none' : '3,3');
    g.selectAll('.grid .domain').remove();

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -rowHeight / 2)
      .attr('y', -46)
      .attr('text-anchor', 'middle')
      .style('font-size', labelFontSize)
      .style('font-weight', publicationMode ? 'bold' : '600')
      .text('Clone-assigned sequences');

    for (const tp of timepoints) {
      const tpX = xTp(tp)!;
      const tpW = xTp.bandwidth();
      const slot = tpW / cohorts.length;
      const boxW = Math.min(slot * 0.45, 48);

      cohorts.forEach((c, ci) => {
        const vals = c.data.filter(m => m.timepointLabel === tp).map(depthOf).sort((a, b) => a - b);
        if (vals.length === 0) return;
        drawBox(g, vals, tpX + slot * (ci + 0.5), boxW, y, c.color);
      });

      g.append('text')
        .attr('x', tpX + tpW / 2)
        .attr('y', rowHeight + 16)
        .attr('text-anchor', 'middle')
        .style('font-size', labelFontSize)
        .style('font-weight', '600')
        .style('fill', '#444')
        .text(tp);

      cohorts.forEach((c, ci) => {
        const vals = c.data.filter(m => m.timepointLabel === tp).map(depthOf);
        if (vals.length === 0) return;
        g.append('text')
          .attr('x', tpX + slot * (ci + 0.5))
          .attr('y', rowHeight + 30)
          .attr('text-anchor', 'middle')
          .style('font-size', '9px')
          .style('fill', c.color)
          .style('opacity', 0.75)
          .text(`n=${vals.length}`);
      });
    }

    const legend = svg.append('g').attr('transform', `translate(${margin.left}, ${totalHeight - legendHeight + 4})`);
    let lx = 0;
    cohorts.forEach((c) => {
      const lg = legend.append('g').attr('transform', `translate(${lx}, 0)`);
      lg.append('rect').attr('width', 11).attr('height', 11).attr('rx', 2).attr('fill', c.color).attr('opacity', 0.75);
      lg.append('text').attr('x', 15).attr('y', 9).text(c.name).style('font-size', fontSize).style('fill', '#444');
      lx += c.name.length * 6.5 + 32;
    });
  }

  // `any` for the d3 handles: this project ships without @types/d3, so
  // d3.Selection and d3.ScaleLogarithmic do not resolve as types.
  function drawBox(
    g: any,
    values: number[],
    cx: number,
    boxWidth: number,
    y: any,
    color: string
  ) {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = d3.quantile(sorted, 0.25)!;
    const median = d3.quantile(sorted, 0.5)!;
    const q3 = d3.quantile(sorted, 0.75)!;
    const half = boxWidth / 2;

    g.append('rect')
      .attr('x', cx - half).attr('y', y(q3))
      .attr('width', boxWidth)
      .attr('height', Math.max(1, y(q1) - y(q3)))
      .attr('fill', color).attr('fill-opacity', publicationMode ? 0.35 : 0.3)
      .attr('stroke', color).attr('stroke-width', publicationMode ? 1.5 : 1.2);

    g.append('line')
      .attr('x1', cx - half).attr('x2', cx + half)
      .attr('y1', y(median)).attr('y2', y(median))
      .style('stroke', color).style('stroke-width', publicationMode ? 2.5 : 2);

    // Whiskers run to the extremes rather than to 1.5 IQR. A donor far below
    // the box is not an outlier to be trimmed here, it is the donor that will
    // drop out first under any depth threshold, so it has to stay on screen.
    g.append('line')
      .attr('x1', cx).attr('x2', cx)
      .attr('y1', y(q1)).attr('y2', y(sorted[0]))
      .style('stroke', color).style('stroke-width', 1.2);
    g.append('line')
      .attr('x1', cx - half).attr('x2', cx + half)
      .attr('y1', y(sorted[0])).attr('y2', y(sorted[0]))
      .style('stroke', color).style('stroke-width', 1.2);
    g.append('line')
      .attr('x1', cx).attr('x2', cx)
      .attr('y1', y(q3)).attr('y2', y(sorted[sorted.length - 1]))
      .style('stroke', color).style('stroke-width', 1.2);
    g.append('line')
      .attr('x1', cx - half).attr('x2', cx + half)
      .attr('y1', y(sorted[sorted.length - 1])).attr('y2', y(sorted[sorted.length - 1]))
      .style('stroke', color).style('stroke-width', 1.2);

    const jitterWidth = boxWidth * 0.7;
    values.forEach((v, i) => {
      const jitter = (seededRandom(i * 7 + v * 13) - 0.5) * jitterWidth;
      g.append('circle')
        .attr('cx', cx + jitter).attr('cy', y(v))
        .attr('r', publicationMode ? 3 : 2.5)
        .attr('fill', color).attr('fill-opacity', 0.55)
        .attr('stroke', '#fff').attr('stroke-width', 0.5);
    });
  }

  /** Deterministic jitter, matching GroupComparisonChart. */
  function seededRandom(seed: number): number {
    const x = Math.sin(seed + 1) * 43758.5453;
    return x - Math.floor(x);
  }
</script>

<div class="depth-panel" bind:this={container}>
  {#if cohorts.length === 0}
    <div class="empty-msg">No per-patient data available.</div>
  {:else}
    <svg bind:this={svgEl}></svg>

    <table class="depth-table">
      <thead>
        <tr>
          <th>Timepoint</th>
          {#each cohorts as c}
            <th style="color:{c.color}">{c.name}<span class="unit">median (n)</span></th>
          {/each}
          <th>Ratio</th>
        </tr>
      </thead>
      <tbody>
        {#each summary as s}
          <tr>
            <td class="tp">{s.tp}</td>
            {#each cohorts as c}
              {@const p = s.per.find(x => x.name === c.name)}
              <td>{p ? `${p.median.toFixed(0)} (${p.n})` : '-'}</td>
            {/each}
            <td class:flag={s.ratio !== null && s.ratio >= 2}>
              {s.ratio === null ? '-' : `${s.ratio.toFixed(1)}x`}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if worstRatio >= 2}
      <p class="warn">
        Median depth differs by up to {worstRatio.toFixed(1)}x between groups. Every
        clone-derived metric below grows with depth at this sample size, so a group
        difference in those metrics may reflect sequence yield rather than repertoire
        structure. Compare at matched depth before interpreting.
      </p>
    {/if}
  {/if}
</div>

<style>
  .depth-panel { position: relative; width: 100%; }
  .depth-panel :global(svg) { display: block; max-width: 100%; }
  .depth-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    margin-top: 8px;
  }
  .depth-table th, .depth-table td {
    padding: 4px 8px;
    text-align: right;
    border-bottom: 1px solid var(--border-light, #e5e7eb);
  }
  .depth-table th:first-child, .depth-table td:first-child { text-align: left; }
  .depth-table th {
    font-weight: 600;
    color: var(--text-secondary, #555);
    white-space: nowrap;
  }
  .depth-table .unit {
    display: block;
    font-weight: 400;
    font-size: 9px;
    color: var(--text-tertiary, #999);
  }
  .depth-table td.tp { font-weight: 600; color: #444; }
  .depth-table td.flag { color: #B45309; font-weight: 600; }
  .warn {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: #FEF3C7;
    border-left: 3px solid #F59E0B;
    border-radius: 3px;
    font-size: 11px;
    line-height: 1.5;
    color: #78350F;
  }
  .empty-msg {
    padding: 24px;
    text-align: center;
    color: var(--text-tertiary, #888);
    font-size: 13px;
  }
</style>
