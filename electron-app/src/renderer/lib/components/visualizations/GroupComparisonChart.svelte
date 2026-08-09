<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { GroupTimepointMetrics } from '../../utils/repertoire-metrics';
  import { wilcoxonRankSum, benjaminiHochberg, formatPValue, significanceStars } from '../../utils/statistics';

  /**
   * Per-sample metrics for disease group (legacy 2-cohort API).
   * Each entry = one patient/file at a specific timepoint.
   * For N-cohort studies, prefer the new cohortsData prop below.
   */
  export let diseaseData: GroupTimepointMetrics[] = [];
  /** Per-sample metrics for control group. */
  export let controlData: GroupTimepointMetrics[] = [];
  /** Disease cohort display name */
  export let diseaseName: string = 'Disease';
  /** Control cohort display name */
  export let controlName: string = 'Control';
  /** Whether to render in publication mode (clean, no UI chrome) */
  export let publicationMode: boolean = false;

  /**
   * N-cohort input. When set, supersedes diseaseData/controlData and the chart
   * renders one box per cohort per timepoint, with pairwise Wilcoxon comparisons
   * vs the first cohort (BH-FDR corrected). Each entry: { name, color, data }.
   */
  export let cohortsData: { name: string; color: string; data: GroupTimepointMetrics[] }[] | null = null;

  /** Resolved cohorts list, either the explicit N-cohort prop or the legacy
   *  2-cohort one. The drawing logic only ever talks to this array. */
  $: cohorts = cohortsData ?? ([
    { name: diseaseName, color: '#1565C0', data: diseaseData },
    { name: controlName, color: '#757575', data: controlData },
  ].filter(c => c.data.length > 0));

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

  // Metrics to show in boxplots
  interface MetricDef {
    key: string;
    label: string;
    accessor: (m: GroupTimepointMetrics) => number;
    tooltip: string;
  }

  const METRICS: MetricDef[] = [
    { key: 'shannon', label: 'Shannon Entropy', accessor: m => m.diversity.shannonEntropy, tooltip: 'Shannon entropy: higher = more diverse repertoire' },
    { key: 'simpson', label: 'Simpson Index', accessor: m => m.diversity.simpsonIndex, tooltip: 'Simpson diversity: probability two random sequences differ' },
    { key: 'chao1', label: 'Chao1', accessor: m => m.diversity.chao1, tooltip: 'Chao1 richness estimator' },
    { key: 'meanSHM', label: 'Mean SHM', accessor: m => m.diversity.meanSHM, tooltip: 'Mean somatic hypermutation count per sequence' },
    { key: 'gini', label: 'Gini Index', accessor: m => m.diversity.giniIndex, tooltip: 'Gini clonal inequality: 0 = even, 1 = dominated' },
    { key: 'expandedFrac', label: '% Expanded Clones', accessor: m => m.diversity.expandedCloneFraction * 100, tooltip: '% of sequences in clones with ≥2 members (Shulman 2022 Fig 2B)' },
    { key: 'top1Frac', label: '% Top-1 Clone', accessor: m => m.diversity.top1CloneFraction * 100, tooltip: '% of repertoire in the single largest clone' },
    { key: 'top10Frac', label: '% Top-10 Clones', accessor: m => m.diversity.top10CloneFraction * 100, tooltip: '% of repertoire in the top-10 largest clones' },
  ];

  const DISEASE_COLOR = '#1565C0';
  const CONTROL_COLOR = '#757575';

  // ── Reactive data processing ──────────────────────────────
  $: hasComparison = diseaseData.length > 0 && controlData.length > 0;

  // Collect all unique timepoint labels across both groups
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

  // Compute all statistical tests
  interface TestResult {
    tp: string;
    metric: MetricDef;
    diseaseVals: number[];
    controlVals: number[];
    test: ReturnType<typeof wilcoxonRankSum>;
    adjustedP?: number;
  }

  $: testResults = (() => {
    if (!hasComparison) return [];
    const results: TestResult[] = [];
    for (const tp of allTimepoints) {
      const dData = diseasByTp.get(tp) ?? [];
      const cData = controlByTp.get(tp) ?? [];
      for (const metric of METRICS) {
        const diseaseVals = dData.map(metric.accessor);
        const controlVals = cData.map(metric.accessor);
        const test = wilcoxonRankSum(diseaseVals, controlVals);
        results.push({ tp, metric, diseaseVals, controlVals, test });
      }
    }
    // Apply BH-FDR correction across all valid tests
    const validIndices = results.map((r, i) => r.test.valid ? i : -1).filter(i => i >= 0);
    const validPs = validIndices.map(i => results[i].test.p);
    const adjusted = benjaminiHochberg(validPs);
    validIndices.forEach((idx, j) => {
      results[idx].adjustedP = adjusted[j];
    });
    return results;
  })();

  /** True when >2 cohorts are supplied via cohortsData, use N-cohort layout. */
  $: isNCohortMode = !!cohortsData && cohortsData.length > 2;

  /**
   * Pairwise Wilcoxon for the N-cohort case: every cohort pair (i, j) with
   * i < j is tested per (metric × timepoint).
   *
   * BH-FDR correction is applied **per metric** (across pairs × timepoints
   * within that metric), not globally, which is the convention in most
   * repertoire papers (e.g., Shulman et al. 2022). Global correction across
   * all metrics × pairs becomes too conservative with small n.
   *
   * Keyed by `${metric.key}|${tp}|${i}|${j}`.
   */
  $: nCohortTests = (() => {
    const map = new Map<string, { p: number; adjustedP?: number; valid: boolean; n1: number; n2: number; i: number; j: number }>();
    if (!isNCohortMode) return map;
    const tps = new Set<string>();
    for (const c of cohorts) for (const m of c.data) tps.add(m.timepointLabel);
    const tpList = [...tps].sort();

    // Build and BH-correct within each metric separately
    for (const metric of METRICS) {
      const flat: { key: string; p: number; valid: boolean; n1: number; n2: number; i: number; j: number }[] = [];
      for (const tp of tpList) {
        for (let i = 0; i < cohorts.length; i++) {
          const aVals = cohorts[i].data.filter(m => m.timepointLabel === tp).map(metric.accessor);
          for (let j = i + 1; j < cohorts.length; j++) {
            const bVals = cohorts[j].data.filter(m => m.timepointLabel === tp).map(metric.accessor);
            const test = wilcoxonRankSum(aVals, bVals);
            flat.push({
              key: `${metric.key}|${tp}|${i}|${j}`,
              p: test.p, valid: test.valid, n1: test.n1, n2: test.n2,
              i, j,
            });
          }
        }
      }
      const validIdx = flat.map((r, k) => r.valid ? k : -1).filter(k => k >= 0);
      const adj = benjaminiHochberg(validIdx.map(k => flat[k].p));
      validIdx.forEach((idx, j) => {
        map.set(flat[idx].key, { ...flat[idx], adjustedP: adj[j] });
      });
      for (const r of flat) if (!r.valid && !map.has(r.key)) map.set(r.key, r);
    }
    return map;
  })();

  /** Greedy interval-packing, assigns each bracket the lowest free level. */
  function packBrackets<T extends { left: number; right: number }>(items: T[]): { item: T; level: number }[] {
    const sorted = [...items].sort((a, b) => a.left - b.left || a.right - b.right);
    const levelRights: number[] = [];
    const result: { item: T; level: number }[] = [];
    for (const it of sorted) {
      let lvl = 0;
      while (lvl < levelRights.length && levelRights[lvl] > it.left) lvl++;
      result.push({ item: it, level: lvl });
      if (lvl === levelRights.length) levelRights.push(it.right);
      else levelRights[lvl] = it.right;
    }
    return result;
  }

  // ── Draw charts (one SVG per metric) ────────────────────
  $: if (container && (cohorts.length > 0 || diseaseData.length > 0 || controlData.length > 0)) {
    drawAllCharts();
  }

  function drawAllCharts() {
    if (!container) return;
    for (const metric of METRICS) {
      const cardEl = container.querySelector(`.metric-card-box:has(svg[data-metric="${metric.key}"])`) as HTMLElement | null;
      const svgEl = container.querySelector(`svg[data-metric="${metric.key}"]`) as SVGSVGElement | null;
      if (svgEl && cardEl) {
        const cardW = cardEl.clientWidth;
        if (isNCohortMode) {
          drawNCohortMetric(d3.select(svgEl), metric, cardW);
        } else {
          drawSingleMetric(d3.select(svgEl), metric, cardW);
        }
      }
    }
  }

  /**
   * N-cohort renderer (3+ cohorts). Boxplots per cohort per timepoint, with
   * pairwise Wilcoxon vs the first cohort shown as small p-values below each
   * non-first box. BH-corrected across all (metric × tp × pair) tests.
   */
  function drawNCohortMetric(
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
    metric: MetricDef,
    w: number
  ) {
    svg.selectAll('*').remove();

    // Gather all timepoints across cohorts (typically 1 for single-endpoint studies)
    const tps = new Set<string>();
    for (const c of cohorts) for (const m of c.data) tps.add(m.timepointLabel);
    const timepoints = [...tps].sort();
    if (timepoints.length === 0) return;

    const margin = { top: 14, right: 16, bottom: 60, left: 50 };
    const rowHeight = 170;
    const legendHeight = 28;
    const innerW = w - margin.left - margin.right;
    const fontSize = '10px';

    // Reserve vertical space at top for the pairwise-comparison brackets.
    // Each timepoint stacks up to C(n,2) brackets independently; pack them
    // and use the deepest stack across timepoints.
    const bracketStep = 14;       // px per stack level
    const bracketBaseGap = 6;     // px between top of boxes and first bracket
    // Worst case for n cohorts = ceil(n/2) levels in greedy packing; compute
    // exactly per-timepoint below. Start with a placeholder for height calc.
    const maxBracketLevels = Math.ceil((cohorts.length * (cohorts.length - 1)) / 4) + 1;
    const bracketSpace = bracketBaseGap + maxBracketLevels * bracketStep + 4;

    const totalHeight = rowHeight + bracketSpace + margin.top + margin.bottom + legendHeight;
    svg.attr('width', w).attr('height', totalHeight);

    // Collect all values for y-scale (robust)
    const allVals: number[] = [];
    for (const c of cohorts) for (const m of c.data) allVals.push(metric.accessor(m));
    if (allVals.length === 0) return;

    const sorted = [...allVals].sort((a, b) => a - b);
    const q1 = d3.quantile(sorted, 0.25) ?? 0;
    const q3 = d3.quantile(sorted, 0.75) ?? 1;
    const iqr = q3 - q1;
    const rawMin = d3.min(allVals) ?? 0;
    const rawMax = d3.max(allVals) ?? 1;
    let dMax: number, dMin: number;
    if (iqr > 0) {
      dMax = Math.min(rawMax, q3 + 2 * iqr);
      dMin = Math.max(rawMin, q1 - 2 * iqr);
    } else { dMax = rawMax; dMin = rawMin; }
    const yPad = (dMax - dMin) * 0.15 || 0.1;
    const y = d3.scaleLinear()
      .domain([Math.max(0, dMin - yPad), dMax + yPad])
      .nice()
      .range([rowHeight, 0]);

    // Outer band per timepoint, inner band per cohort
    const xTp = d3.scaleBand().domain(timepoints).range([0, innerW]).paddingInner(0.2).paddingOuter(0.1);
    const xCohort = d3.scaleBand()
      .domain(cohorts.map((_, i) => String(i)))
      .range([0, xTp.bandwidth()])
      .paddingInner(0.15)
      .paddingOuter(0.05);
    const boxW = Math.min(xCohort.bandwidth() * 0.7, 48);

    const g = svg.append('g').attr('transform', `translate(${margin.left}, ${margin.top + bracketSpace})`);

    // Axes
    g.append('g').call(d3.axisLeft(y).ticks(5)).selectAll('text').style('font-size', fontSize);
    g.append('g').attr('class', 'grid')
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(() => ''))
      .selectAll('line').style('stroke', '#E8EAED').style('stroke-dasharray', '3,3');
    g.selectAll('.grid .domain').remove();

    g.append('text')
      .attr('transform', `rotate(-90)`)
      .attr('x', -rowHeight / 2).attr('y', -38)
      .attr('text-anchor', 'middle')
      .style('font-size', '11px').style('font-weight', '600')
      .text(metric.label);

    // Per-timepoint, per-cohort boxes + pairwise brackets
    for (const tp of timepoints) {
      const tpX = xTp(tp)!;
      const tpW = xTp.bandwidth();

      // Centers of each cohort's box, plus whether it has data at this tp
      const boxCenters: { ci: number; cx: number; n: number; color: string }[] = [];
      cohorts.forEach((c, ci) => {
        const data = c.data.filter(m => m.timepointLabel === tp).map(metric.accessor).sort((a, b) => a - b);
        if (data.length === 0) return;
        const cxOffset = xCohort(String(ci))! + xCohort.bandwidth() / 2;
        const cx = tpX + cxOffset;
        drawBoxplot(g, data, cx, boxW, y, c.color, publicationMode);
        boxCenters.push({ ci, cx, n: data.length, color: c.color });

        g.append('text')
          .attr('x', cx).attr('y', rowHeight + 28)
          .attr('text-anchor', 'middle')
          .style('font-size', '9px').style('fill', c.color).style('opacity', 0.75)
          .text(`n=${data.length}`);
      });

      // Pairwise brackets for this timepoint. Build all (i,j) pairs where
      // both cohorts have data at this tp, then pack into vertical levels.
      type BracketItem = {
        ci: number; cj: number;
        left: number; right: number;
        pVal: number; valid: boolean; n1: number; n2: number;
      };
      const items: BracketItem[] = [];
      for (let a = 0; a < boxCenters.length; a++) {
        for (let b = a + 1; b < boxCenters.length; b++) {
          const ci = boxCenters[a].ci;
          const cj = boxCenters[b].ci;
          const key = `${metric.key}|${tp}|${Math.min(ci, cj)}|${Math.max(ci, cj)}`;
          const t = nCohortTests.get(key);
          if (!t) continue;
          items.push({
            ci, cj,
            left: Math.min(boxCenters[a].cx, boxCenters[b].cx),
            right: Math.max(boxCenters[a].cx, boxCenters[b].cx),
            pVal: t.adjustedP ?? t.p,
            valid: t.valid, n1: t.n1, n2: t.n2,
          });
        }
      }
      const packed = packBrackets(items);

      for (const { item, level } of packed) {
        // y measured upward from the top of the y-axis (which sits at y=0 in g's frame).
        // Level 0 is closest to the boxes; higher levels stack upward.
        const yBracket = -bracketBaseGap - level * bracketStep;
        const yTextOffset = 9;
        const tickDown = 3;
        // Look up the raw p too so we can render "raw (BH adjusted)" side by side.
        const tFull = nCohortTests.get(`${metric.key}|${tp}|${Math.min(item.ci, item.cj)}|${Math.max(item.ci, item.cj)}`);
        const rawP = tFull?.p ?? item.pVal;
        const adjP = tFull?.adjustedP;
        const sigByAdj = item.valid && (adjP ?? item.pVal) < 0.05;
        const sigByRaw = item.valid && rawP < 0.05;
        const stroke = sigByAdj ? '#374151' : (sigByRaw ? '#94a3b8' : '#cbd5e1');
        const fill = sigByAdj ? '#111827' : '#64748b';
        const fontWeight = sigByAdj ? '600' : '400';

        const path = `M ${item.left} ${yBracket + tickDown} L ${item.left} ${yBracket} L ${item.right} ${yBracket} L ${item.right} ${yBracket + tickDown}`;
        g.append('path')
          .attr('d', path)
          .attr('fill', 'none')
          .attr('stroke', stroke)
          .attr('stroke-width', sigByAdj ? 1.2 : 0.8);

        let label: string;
        if (!item.valid) {
          label = `n=${item.n1}+${item.n2}`;
        } else {
          const rawTxt = formatPValue(rawP);
          // Adjusted only useful to show when it differs meaningfully from raw
          if (adjP !== undefined && Math.abs(adjP - rawP) > 0.005) {
            label = `${rawTxt} (BH ${adjP.toFixed(2)}) ${significanceStars(adjP)}`;
          } else {
            label = `${rawTxt} ${significanceStars(rawP)}`;
          }
        }
        g.append('text')
          .attr('x', (item.left + item.right) / 2)
          .attr('y', yBracket - yTextOffset + 7)
          .attr('text-anchor', 'middle')
          .style('font-size', '9px')
          .style('font-weight', fontWeight)
          .style('fill', fill)
          .text(label);
      }

      // Timepoint label below
      g.append('text')
        .attr('x', tpX + tpW / 2).attr('y', rowHeight + 14)
        .attr('text-anchor', 'middle')
        .style('font-size', '11px').style('font-weight', '600').style('fill', '#444')
        .text(tp);
    }

    // Legend (cohort names with their colours)
    const legend = svg.append('g').attr('transform', `translate(${margin.left}, ${totalHeight - legendHeight})`);
    let lx = 0;
    cohorts.forEach((c) => {
      const lg = legend.append('g').attr('transform', `translate(${lx}, 0)`);
      lg.append('rect').attr('width', 11).attr('height', 11).attr('rx', 2).attr('fill', c.color).attr('opacity', 0.75);
      lg.append('text').attr('x', 15).attr('y', 9).text(c.name)
        .style('font-size', fontSize).style('fill', '#444');
      lx += (c.name.length * 6.5) + 32;
    });
  }

  /** Build the legend items (shared across all metric SVGs) */
  function getLegendItems(): { label: string; color: string }[] {
    const items: { label: string; color: string }[] = [];
    if (diseaseData.length > 0) {
      items.push({ label: diseaseName, color: DISEASE_COLOR });
    }
    if (hasComparison) {
      items.push({ label: controlName, color: CONTROL_COLOR });
    }
    return items;
  }

  function drawSingleMetric(
    svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
    metric: MetricDef,
    w: number
  ) {
    svg.selectAll('*').remove();

    const margin = publicationMode
      ? { top: 16, right: 24, bottom: 56, left: 60 }
      : { top: 16, right: 20, bottom: 52, left: 52 };
    const rowHeight = publicationMode ? 170 : 155;
    const pLabelSpace = 24;
    const legendHeight = 32;
    const totalHeight = rowHeight + pLabelSpace + margin.top + margin.bottom + legendHeight;

    const innerW = w - margin.left - margin.right;
    const offsetX = 0;

    svg.attr('width', w).attr('height', totalHeight);

    if (publicationMode) {
      svg.style('font-family', 'Arial, Helvetica, sans-serif');
    }

    const fontSize = publicationMode ? '11px' : '10px';
    const labelFontSize = publicationMode ? '12px' : '11px';
    const pFontSize = publicationMode ? '10px' : '9px';

    // Gather all values for y-scale (robust to outliers)
    const allVals: number[] = [];
    for (const tp of allTimepoints) {
      const dData = diseasByTp.get(tp) ?? [];
      const cData = controlByTp.get(tp) ?? [];
      allVals.push(...dData.map(metric.accessor));
      allVals.push(...cData.map(metric.accessor));
    }

    if (allVals.length === 0) return;

    // IQR-based robust scale
    const sorted = [...allVals].sort((a, b) => a - b);
    const q1All = d3.quantile(sorted, 0.25) ?? 0;
    const q3All = d3.quantile(sorted, 0.75) ?? 1;
    const iqrAll = q3All - q1All;
    const rawMin = d3.min(allVals) ?? 0;
    const rawMax = d3.max(allVals) ?? 1;
    let displayMax: number, displayMin: number;
    if (iqrAll > 0) {
      displayMax = Math.min(rawMax, q3All + 2 * iqrAll);
      displayMin = Math.max(rawMin, q1All - 2 * iqrAll);
    } else {
      displayMax = rawMax;
      displayMin = rawMin;
    }
    const yPad = (displayMax - displayMin) * 0.15 || 0.1;
    const y = d3.scaleLinear()
      .domain([Math.max(0, displayMin - yPad), displayMax + yPad])
      .nice()
      .range([rowHeight, 0]);

    // X scale
    const xTp = d3.scaleBand()
      .domain(allTimepoints)
      .range([0, innerW])
      .paddingInner(0.3)
      .paddingOuter(0.15);

    const g = svg.append('g')
      .attr('transform', `translate(${offsetX + margin.left}, ${margin.top + pLabelSpace})`);

    // Clip path
    const clipPadTop = 8;
    const clipId = `clip-${metric.key}`;
    g.append('defs').append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('x', -4)
      .attr('y', clipPadTop)
      .attr('width', innerW + 8)
      .attr('height', rowHeight - clipPadTop + 4);

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(5))
      .selectAll('text')
      .style('font-size', fontSize);

    // Grid lines
    g.append('g')
      .attr('class', 'grid')
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(() => ''))
      .selectAll('line')
      .style('stroke', publicationMode ? '#E0E0E0' : '#E8EAED')
      .style('stroke-dasharray', publicationMode ? 'none' : '3,3');
    g.selectAll('.grid .domain').remove();

    // Y-axis title
    const titleG = g.append('g')
      .attr('cursor', publicationMode ? 'default' : 'help');
    if (!publicationMode) {
      titleG.append('title').text(metric.tooltip);
    }
    titleG.append('text')
      .attr('transform', `rotate(-90)`)
      .attr('x', -rowHeight / 2)
      .attr('y', -40)
      .attr('text-anchor', 'middle')
      .style('font-size', labelFontSize)
      .style('font-weight', publicationMode ? 'bold' : '600')
      .text(metric.label);

    // Clipped group
    const clippedG = g.append('g').attr('clip-path', `url(#${clipId})`);

    // Draw boxplots for each timepoint
    for (const tp of allTimepoints) {
      const tpX = xTp(tp)!;
      const tpW = xTp.bandwidth();
      const halfW = tpW / 2;
      const boxW = hasComparison ? halfW * 0.32 : tpW * 0.22;

      const dData = diseasByTp.get(tp) ?? [];
      const cData = controlByTp.get(tp) ?? [];
      const dVals = dData.map(metric.accessor).sort((a, b) => a - b);
      const cVals = cData.map(metric.accessor).sort((a, b) => a - b);

      if (dVals.length > 0) {
        const cx = hasComparison ? tpX + halfW * 0.5 : tpX + tpW * 0.5;
        drawBoxplot(clippedG, dVals, cx, boxW, y, DISEASE_COLOR, publicationMode);
      }
      if (hasComparison && cVals.length > 0) {
        const cx = tpX + halfW + halfW * 0.5;
        drawBoxplot(clippedG, cVals, cx, boxW, y, CONTROL_COLOR, publicationMode);
      }

      // Timepoint label
      g.append('text')
        .attr('x', tpX + tpW / 2)
        .attr('y', rowHeight + 16)
        .attr('text-anchor', 'middle')
        .style('font-size', labelFontSize)
        .style('font-weight', '600')
        .style('fill', '#444')
        .text(tp);

      // Per-timepoint outlier count
      const yDomainRange = y.domain();
      const tpAllVals = [...dVals, ...cVals];
      const tpClipped = tpAllVals.filter(v => v > yDomainRange[1] || v < yDomainRange[0]).length;

      // Per-group N counts below timepoint label
      const nDisease = dVals.length;
      const nControl = cVals.length;
      if (hasComparison) {
        g.append('text')
          .attr('x', tpX + halfW * 0.5)
          .attr('y', rowHeight + 30)
          .attr('text-anchor', 'middle')
          .style('font-size', '9px')
          .style('fill', DISEASE_COLOR)
          .style('opacity', 0.7)
          .text(`n=${nDisease}`);
        g.append('text')
          .attr('x', tpX + halfW + halfW * 0.5)
          .attr('y', rowHeight + 30)
          .attr('text-anchor', 'middle')
          .style('font-size', '9px')
          .style('fill', CONTROL_COLOR)
          .text(`n=${nControl}`);
      } else {
        g.append('text')
          .attr('x', tpX + tpW / 2)
          .attr('y', rowHeight + 30)
          .attr('text-anchor', 'middle')
          .style('font-size', '9px')
          .style('fill', '#999')
          .text(`n=${nDisease}`);
      }

      // Per-timepoint outlier note
      if (tpClipped > 0) {
        g.append('text')
          .attr('x', tpX + tpW / 2)
          .attr('y', rowHeight + 42)
          .attr('text-anchor', 'middle')
          .style('font-size', '8px')
          .style('fill', '#bbb')
          .style('font-style', 'italic')
          .text(`${tpClipped} outlier${tpClipped > 1 ? 's' : ''} beyond axis range`);
      }

      // P-value bracket
      if (hasComparison) {
        const testResult = testResults.find(
          r => r.tp === tp && r.metric.key === metric.key
        );
        if (testResult) {
          const pDisplay = testResult.test.valid
            ? formatPValue(testResult.adjustedP ?? testResult.test.p)
            : `n too small (${testResult.test.n1}+${testResult.test.n2})`;
          const stars = testResult.test.valid
            ? significanceStars(testResult.adjustedP ?? testResult.test.p)
            : '';
          const isSignificant = testResult.test.valid &&
            (testResult.adjustedP ?? testResult.test.p) < 0.05;

          const bracketY = -2;
          const leftX = tpX + halfW * 0.5;
          const rightX = tpX + halfW + halfW * 0.5;
          const bracketTop = bracketY - 8;

          g.append('line').attr('x1', leftX).attr('y1', bracketY).attr('x2', leftX).attr('y2', bracketTop).style('stroke', '#666').style('stroke-width', 1);
          g.append('line').attr('x1', leftX).attr('y1', bracketTop).attr('x2', rightX).attr('y2', bracketTop).style('stroke', '#666').style('stroke-width', 1);
          g.append('line').attr('x1', rightX).attr('y1', bracketY).attr('x2', rightX).attr('y2', bracketTop).style('stroke', '#666').style('stroke-width', 1);

          const pTextEl = g.append('text')
            .attr('x', (leftX + rightX) / 2)
            .attr('y', bracketTop - 4)
            .attr('text-anchor', 'middle')
            .style('font-size', pFontSize)
            .style('fill', isSignificant ? '#D32F2F' : '#888');

          pTextEl.text(stars && stars !== 'ns' ? `${pDisplay} ${stars}` : pDisplay);

          if (!publicationMode && testResult.test.valid) {
            pTextEl.append('title').text(
              `Wilcoxon rank-sum (BH-adjusted)\n` +
              `U = ${testResult.test.U}, r = ${testResult.test.r.toFixed(3)}\n` +
              `n(${diseaseName}) = ${testResult.test.n1}, n(${controlName}) = ${testResult.test.n2}`
            );
          }
        }
      }
    }

    // Legend
    const legend = svg.append('g')
      .attr('transform', `translate(${offsetX + margin.left}, ${totalHeight - legendHeight})`);
    const items = getLegendItems();
    items.forEach((item, i) => {
      const lg = legend.append('g').attr('transform', `translate(${i * 180}, 0)`);
      lg.append('rect').attr('width', 12).attr('height', 12).attr('rx', 2).attr('fill', item.color).attr('opacity', 0.7);
      lg.append('text').attr('x', 16).attr('y', 10).text(item.label)
        .style('font-size', fontSize).style('fill', publicationMode ? '#333' : '#6B7280');
    });
  }

  // ── Boxplot drawing helper ────────────────────────────────
  function drawBoxplot(
    g: d3.Selection<any, any, any, any>,
    values: number[],
    cx: number,
    boxWidth: number,
    y: d3.ScaleLinear<number, number>,
    color: string,
    pubMode: boolean
  ) {
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);

    const q1 = d3.quantile(sorted, 0.25)!;
    const median = d3.quantile(sorted, 0.5)!;
    const q3 = d3.quantile(sorted, 0.75)!;
    const iqr = q3 - q1;
    const whiskerLow = Math.max(sorted[0], q1 - 1.5 * iqr);
    const whiskerHigh = Math.min(sorted[n - 1], q3 + 1.5 * iqr);

    const halfBox = boxWidth / 2;

    // Box (filled, with border)
    g.append('rect')
      .attr('x', cx - halfBox)
      .attr('y', y(q3))
      .attr('width', boxWidth)
      .attr('height', Math.max(1, y(q1) - y(q3)))
      .attr('fill', color)
      .attr('fill-opacity', pubMode ? 0.35 : 0.3)
      .attr('stroke', color)
      .attr('stroke-width', pubMode ? 1.5 : 1.2);

    // Median line (same width as box)
    g.append('line')
      .attr('x1', cx - halfBox)
      .attr('x2', cx + halfBox)
      .attr('y1', y(median))
      .attr('y2', y(median))
      .style('stroke', color)
      .style('stroke-width', pubMode ? 2.5 : 2);

    // Whiskers: solid lines, caps same width as box
    // Lower whisker stem
    g.append('line')
      .attr('x1', cx).attr('x2', cx)
      .attr('y1', y(q1)).attr('y2', y(whiskerLow))
      .style('stroke', color).style('stroke-width', 1.2);
    // Lower whisker cap (full box width)
    g.append('line')
      .attr('x1', cx - halfBox).attr('x2', cx + halfBox)
      .attr('y1', y(whiskerLow)).attr('y2', y(whiskerLow))
      .style('stroke', color).style('stroke-width', 1.2);
    // Upper whisker stem
    g.append('line')
      .attr('x1', cx).attr('x2', cx)
      .attr('y1', y(q3)).attr('y2', y(whiskerHigh))
      .style('stroke', color).style('stroke-width', 1.2);
    // Upper whisker cap (full box width)
    g.append('line')
      .attr('x1', cx - halfBox).attr('x2', cx + halfBox)
      .attr('y1', y(whiskerHigh)).attr('y2', y(whiskerHigh))
      .style('stroke', color).style('stroke-width', 1.2);

    // Jittered data points (overlaid on top of the box)
    const jitterWidth = boxWidth * 0.7;
    values.forEach((v, i) => {
      const jitter = (seededRandom(i * 7 + v * 13) - 0.5) * jitterWidth;
      g.append('circle')
        .attr('cx', cx + jitter)
        .attr('cy', y(v))
        .attr('r', pubMode ? 3 : 2.5)
        .attr('fill', color)
        .attr('fill-opacity', 0.55)
        .attr('stroke', '#fff')
        .attr('stroke-width', 0.5);
    });
  }

  /** Simple deterministic pseudo-random for jitter (0-1) */
  function seededRandom(seed: number): number {
    const x = Math.sin(seed + 1) * 43758.5453;
    return x - Math.floor(x);
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

<div class="chart-outer" bind:this={container}>
  {#if cohorts.length === 0}
    <div class="empty-msg">No per-patient data available for comparison.</div>
  {:else}
    {#if !isNCohortMode && !hasComparison}
      <div class="single-group-msg">
        <p>Only one group loaded. Statistical comparison requires both Disease and Control cohorts.</p>
        <p class="sub">Showing distributions for the single group below.</p>
      </div>
    {/if}
    {#each METRICS as metric (metric.key)}
      <div class="metric-card-box" class:pub-mode={publicationMode}>
        <svg data-metric={metric.key}></svg>
      </div>
    {/each}
  {/if}
  {#if tooltipVisible}
    <div class="tooltip" style={tooltipStyle}>
      {#each tooltipText.split('\n') as line}
        <div>{line}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chart-outer {
    position: relative;
    width: 100%;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  @media (max-width: 1100px) {
    .chart-outer {
      grid-template-columns: 1fr;
    }
  }
  .metric-card-box {
    background: var(--surface-raised, #fff);
    border: 1px solid var(--border-light, #e5e7eb);
    border-radius: 8px;
    padding: 8px 4px 4px 4px;
    min-width: 0;
    overflow: hidden;
  }
  .metric-card-box :global(svg) {
    display: block;
    max-width: 100%;
  }
  .metric-card-box.pub-mode {
    background: #fff;
    border: none;
  }
  .empty-msg, .single-group-msg {
    grid-column: 1 / -1;
    padding: 24px;
    text-align: center;
    color: var(--text-tertiary, #888);
    font-size: 13px;
  }
  .single-group-msg .sub {
    font-size: 11px;
    margin-top: 4px;
    color: var(--text-tertiary, #aaa);
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
