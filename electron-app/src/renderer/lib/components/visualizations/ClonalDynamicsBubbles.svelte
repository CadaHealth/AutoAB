<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import type { ClonalDynamicsEntry } from '../../utils/public-clones';

  export let entries: ClonalDynamicsEntry[] = [];
  export let timepointLabels: string[] = [];
  export let timepointTotals: { label: string; total: number }[] = [];
  export let onCloneClick: (entry: ClonalDynamicsEntry, timepoint?: string) => void = () => {};
  export let colorMode: 'identity' | 'public_private' = 'identity';
  export let rankingMode: 'overall' | 'per_timepoint' = 'overall';
  export let publicCloneIds: Set<number> = new Set();
  export let cohortLabel: string = '';

  let container: HTMLDivElement;
  let width = 600;
  let ro: ResizeObserver;
  let tooltipEl: HTMLDivElement;

  const CLONE_PALETTE = [
    '#E41A1C', '#377EB8', '#4DAF4A', '#984EA3', '#FF7F00',
    '#FFFF33', '#A65628', '#F781BF', '#999999', '#66C2A5',
    '#FC8D62', '#8DA0CB', '#E78AC3', '#A6D854', '#FFD92F',
    '#E5C494', '#B3B3B3', '#1B9E77', '#D95F02', '#7570B3',
    '#E7298A', '#66A61E', '#E6AB02', '#A6761D', '#666666',
    '#7FC97F', '#BEAED4', '#FDC086', '#FFFF99', '#386CB0'
  ];
  const COLOR_PUBLIC = '#55a868';
  const COLOR_PRIVATE = '#4c72b0';
  const COLOR_OTHER = '#E8EAED';
  const TOP_N_LABELED = 30;

  onMount(() => {
    ro = new ResizeObserver((es) => {
      for (const e of es) width = e.contentRect.width;
    });
    ro.observe(container);
  });
  onDestroy(() => ro?.disconnect());

  $: if (container && entries.length > 0 && timepointLabels.length > 0) {
    drawBubbles(entries, timepointLabels, width, colorMode, rankingMode, publicCloneIds);
  }

  interface PackNode {
    entry: ClonalDynamicsEntry;
    rawCount: number;
    frequency: number;
    globalRank: number;
    isHighlighted: boolean;
  }

  function parseGlobalRank(label: string): number {
    const m = label.match(/^C(\d+)$/);
    return m ? parseInt(m[1], 10) : 999;
  }

  function drawBubbles(ents: ClonalDynamicsEntry[], tpLabels: string[], w: number) {
    if (!container) return;

    const svg: any = d3.select(container).select('svg');
    svg.selectAll('*').remove();

    const nTp = tpLabels.length;
    if (nTp === 0 || ents.length === 0) return;

    const gap = 12;
    const headerH = 48;
    const circleD = Math.min((w - gap * (nTp - 1)) / nTp, 400);
    const totalW = nTp * circleD + (nTp - 1) * gap;
    const svgW = totalW;
    const svgH = circleD + headerH;

    svg.attr('width', svgW).attr('height', svgH).attr('viewBox', `0 0 ${svgW} ${svgH}`);

    tpLabels.forEach((tpLabel, tpIdx) => {
      const cx = tpIdx * (circleD + gap) + circleD / 2;
      const cy = headerH + circleD / 2;
      const radius = circleD / 2 - 2;

      const tpTotal = timepointTotals.find(t => t.label === tpLabel)?.total ?? 0;

      svg.append('text')
        .attr('x', cx)
        .attr('y', 14)
        .attr('text-anchor', 'middle')
        .style('font-size', '12px')
        .style('font-weight', '600')
        .style('fill', 'var(--gray-800)')
        .text(tpLabel);

      svg.append('text')
        .attr('x', cx)
        .attr('y', 30)
        .attr('text-anchor', 'middle')
        .style('font-size', '10px')
        .style('fill', 'var(--gray-500)')
        .text(tpTotal > 0 ? `${tpTotal.toLocaleString()} seqs` : '');

      svg.append('circle')
        .attr('cx', cx)
        .attr('cy', cy)
        .attr('r', radius)
        .attr('fill', 'none')
        .attr('stroke', 'var(--gray-300)')
        .attr('stroke-width', 1.5);

      const nodes: PackNode[] = [];
      for (const entry of ents) {
        const tpSize = entry.timepointSizes.find(t => t.label === tpLabel);
        const rawCount = tpSize?.rawCount ?? 0;
        const frequency = tpSize?.frequency ?? 0;
        if (rawCount <= 0) continue;
        const globalRank = parseGlobalRank(entry.cloneLabel);
        nodes.push({ entry, rawCount, frequency, globalRank, isHighlighted: false });
      }

      if (nodes.length === 0) return;

      // Determine which clones are highlighted based on ranking mode
      if (rankingMode === 'overall') {
        for (const n of nodes) {
          n.isHighlighted = n.globalRank <= TOP_N_LABELED;
        }
      } else {
        const sorted = [...nodes].sort((a, b) => b.rawCount - a.rawCount);
        const topIds = new Set(sorted.slice(0, TOP_N_LABELED).map(n => n.entry));
        for (const n of nodes) {
          n.isHighlighted = topIds.has(n.entry);
        }
      }

      // d3 pack layout
      const root = d3.hierarchy({ children: nodes } as any)
        .sum((d: any) => d.frequency || 0.0001)
        .sort((a: any, b: any) => (b.value ?? 0) - (a.value ?? 0));

      const pack = (d3.pack as any)()
        .size([radius * 2, radius * 2])
        .padding(1);

      pack(root);

      const tpGroup = svg.append('g')
        .attr('transform', `translate(${cx - radius}, ${cy - radius})`);

      // Clip to bounding circle
      const clipId = `clip-tp-${tpIdx}`;
      tpGroup.append('defs')
        .append('clipPath')
        .attr('id', clipId)
        .append('circle')
        .attr('cx', radius)
        .attr('cy', radius)
        .attr('r', radius);

      const clippedGroup = tpGroup.append('g')
        .attr('clip-path', `url(#${clipId})`);

      const leaves = root.leaves();

      // Draw bubbles
      leaves.forEach((leaf: any) => {
        const node: PackNode = leaf.data;
        const fillColor = getBubbleColor(node);

        clippedGroup.append('circle')
          .attr('cx', leaf.x)
          .attr('cy', leaf.y)
          .attr('r', leaf.r)
          .attr('fill', fillColor)
          .attr('stroke', node.isHighlighted ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.05)')
          .attr('stroke-width', node.isHighlighted ? 0.5 : 0.2)
          .style('cursor', node.isHighlighted ? 'pointer' : 'default')
          .on('click', () => {
            if (node.isHighlighted) {
              onCloneClick(node.entry, tpLabel);
            }
          })
          .on('mouseenter', (event: MouseEvent) => {
            showTooltip(event, node, tpLabel);
          })
          .on('mouseleave', () => hideTooltip());

        if (node.isHighlighted && leaf.r > 10) {
          clippedGroup.append('text')
            .attr('x', leaf.x)
            .attr('y', leaf.y)
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'central')
            .style('font-size', Math.min(leaf.r * 0.8, 11) + 'px')
            .style('font-weight', '600')
            .style('fill', 'white')
            .style('pointer-events', 'none')
            .text(node.entry.cloneLabel);
        }
      });
    });
  }

  function getBubbleColor(node: PackNode): string {
    if (!node.isHighlighted) return COLOR_OTHER;
    if (colorMode === 'public_private') {
      return publicCloneIds.has(node.entry.cloneId) ? COLOR_PUBLIC : COLOR_PRIVATE;
    }
    return CLONE_PALETTE[(node.globalRank - 1) % CLONE_PALETTE.length];
  }

  function showTooltip(event: MouseEvent, node: PackNode, tpLabel: string) {
    if (!tooltipEl) return;
    const pctStr = (node.frequency * 100).toFixed(2);
    const publicStr = publicCloneIds.has(node.entry.cloneId) ? 'Public' : 'Private';
    tooltipEl.innerHTML = `
      <strong>${node.entry.cloneLabel}</strong>, ${node.entry.totalRawCount.toLocaleString()} total seqs<br/>
      <span style="color:var(--gray-500)">${tpLabel}:</span> ${node.rawCount.toLocaleString()} seqs (${pctStr}%)<br/>
      <span style="color:var(--gray-500)">CDR3:</span> <code style="font-size:10px">${node.entry.cdr3Aa || '-'}</code><br/>
      <span style="color:var(--gray-500)">V/J:</span> ${node.entry.vGene} / ${node.entry.jGene}<br/>
      <span style="color:var(--gray-500)">Status:</span> ${node.entry.status.replace('_', ' ')}<br/>
      <span style="color:var(--gray-500)">Type:</span> ${publicStr}
    `;
    tooltipEl.style.display = 'block';
    const rect = container.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();
    const tipW = tipRect.width || 280;
    const tipH = tipRect.height || 100;
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    let left = cursorX + 12;
    if (left + tipW > rect.width) left = cursorX - tipW - 12;
    if (left < 0) left = 4;
    let top = cursorY - 10;
    if (top + tipH > rect.height) top = cursorY - tipH - 10;
    if (top < 0) top = 4;
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  import { exportHtmlAsPng } from '../../utils/export-figure';

  export async function exportPng() {
    if (!container) return;
    const name = cohortLabel ? `clonal_dynamics_bubbles_${cohortLabel}.png` : 'clonal_dynamics_bubbles.png';
    await exportHtmlAsPng(container, name);
  }
</script>

<div class="bubbles-wrapper" bind:this={container}>
  <svg></svg>
  <div class="bubble-tooltip" bind:this={tooltipEl}></div>

  {#if colorMode === 'public_private'}
    <div class="bubble-legend">
      <span class="legend-item">
        <span class="legend-dot" style="background:{COLOR_PUBLIC}"></span>
        Public (shared across patients)
      </span>
      <span class="legend-item">
        <span class="legend-dot" style="background:{COLOR_PRIVATE}"></span>
        Private (single patient)
      </span>
      <span class="legend-item">
        <span class="legend-dot" style="background:{COLOR_OTHER}"></span>
        Other
      </span>
    </div>
  {/if}
</div>

<style>
  .bubbles-wrapper {
    position: relative;
    width: 100%;
    overflow-x: auto;
    overflow-y: visible;
    padding: 4px 0;
  }
  .bubbles-wrapper svg {
    display: block;
    margin: 0 auto;
  }
  .bubble-tooltip {
    display: none;
    position: absolute;
    background: var(--gray-900);
    color: white;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.5;
    pointer-events: none;
    z-index: 100;
    max-width: 280px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .bubble-tooltip code {
    background: rgba(255,255,255,0.15);
    padding: 1px 3px;
    border-radius: 3px;
    font-family: var(--font-mono);
  }
  .bubble-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    justify-content: center;
    padding: 8px 4px 4px;
    font-size: 10px;
    color: var(--gray-600);
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .legend-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>
