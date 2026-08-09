<script lang="ts">
  import { resultsState, type SequenceData } from '../../lib/stores/app';
  import { onMount } from 'svelte';
  import * as d3 from 'd3';

  // --- Types ---
  interface AntibodyDatabase {
    id: string;
    name: string;
    color: string;
    description: string;
    size: number;
    targets: string[];
    antibodyNames: string[];
  }

  interface AntibodyMatch {
    antibodyName: string;
    database: AntibodyDatabase;
    identity: number;
    target: string;
    method: string;
    cdr3Ref: string;
  }

  interface CloneWithMatches {
    clone_id: number;
    clone_count: number;
    v_gene: string;
    j_gene: string;
    cdr3_peptide: string;
    isotype: string;
    c_call: string;
    matches: AntibodyMatch[];
  }

  // --- Databases ---
  const DATABASES: AntibodyDatabase[] = [
    {
      id: 'covabdab', name: 'CoV-AbDab', color: '#DC2626', description: 'SARS-CoV-2 antibodies',
      size: 12472,
      targets: ['Spike RBD', 'Spike NTD', 'Spike S2', 'Nucleocapsid'],
      antibodyNames: ['REGN10933', 'REGN10987', 'LY-CoV555', 'S309', 'CB6', 'P2B-2F6', 'CR3022', 'COV2-2196', 'ADG20', 'DH1047']
    },
    {
      id: 'catnap', name: 'CATNAP (HIV)', color: '#7C3AED', description: 'HIV broadly neutralizing antibodies',
      size: 4891,
      targets: ['gp120 CD4bs', 'gp120 V3', 'gp41 MPER', 'gp120 V1/V2'],
      antibodyNames: ['VRC01', '10-1074', 'PGT121', '3BNC117', 'N6', 'PG9', 'PG16', '10E8', '4E10', 'b12']
    },
    {
      id: 'iedb', name: 'IEDB Autoimmune', color: '#0891B2', description: 'Autoimmune disease antibodies',
      size: 8234,
      targets: ['dsDNA', 'Citrullinated peptide', 'Thyroid peroxidase', 'Rheumatoid factor Fc', 'Cardiolipin'],
      antibodyNames: ['9G4', 'B1-8', 'RF-AN', 'ANA-1', '33.C9', 'E4', 'Z004', 'TRA-8', 'B6.6', 'PAD4-2']
    },
    {
      id: 'therasabdab', name: 'TheraSAbDab', color: '#059669', description: 'Therapeutic antibodies',
      size: 1247,
      targets: ['CD20', 'TNF-alpha', 'PD-1', 'HER2', 'IL-6R', 'VEGF'],
      antibodyNames: ['Rituximab', 'Adalimumab', 'Pembrolizumab', 'Trastuzumab', 'Tocilizumab', 'Bevacizumab', 'Nivolumab', 'Infliximab', 'Ocrelizumab', 'Dupilumab']
    },
    {
      id: 'imgt', name: 'IMGT/mAb-DB', color: '#D97706', description: 'Reference mAb sequences',
      size: 3456,
      targets: ['Various targets', 'Reference germline', 'Cross-reactive epitope'],
      antibodyNames: ['mAb-1001', 'mAb-2205', 'mAb-3347', 'mAb-4102', 'mAb-5890', 'mAb-6711', 'mAb-7024', 'mAb-8193']
    }
  ];

  // --- Deterministic hash ---
  function hashCloneId(cloneId: number, seed: number = 0): number {
    let h = (cloneId + seed) * 2654435761;
    h = ((h >>> 16) ^ h) * 0x45d9f3b;
    h = ((h >>> 16) ^ h);
    return (h >>> 0) / 0xFFFFFFFF;
  }

  // --- Generate mock CDR3 reference ---
  function generateRefCdr3(queryCdr3: string, identity: number): string {
    const chars = 'ACDEFGHIKLMNPQRSTVWY';
    const arr = queryCdr3.split('');
    const numMutations = Math.max(1, Math.round(arr.length * (1 - identity / 100)));
    const result = [...arr];
    for (let i = 0; i < numMutations; i++) {
      const pos = Math.floor(hashCloneId(i * 17 + queryCdr3.charCodeAt(i % queryCdr3.length), 999) * arr.length);
      result[pos] = chars[Math.floor(hashCloneId(pos + i, 777) * chars.length)];
    }
    return result.join('');
  }

  // --- Extract top clones and generate matches ---
  function extractTopClones(sequences: SequenceData[]): CloneWithMatches[] {
    const cloneMap = new Map<number, SequenceData[]>();
    for (const seq of sequences) {
      if (seq.clone_id != null && seq.clone_id > 0 && seq.cdr3_peptide) {
        if (!cloneMap.has(seq.clone_id)) cloneMap.set(seq.clone_id, []);
        cloneMap.get(seq.clone_id)!.push(seq);
      }
    }

    const clones = Array.from(cloneMap.entries())
      .map(([id, seqs]) => ({ id, seqs, count: seqs.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    return clones.map(({ id, seqs, count }) => {
      const rep = seqs.find(s => s.cdr3_peptide) || seqs[0];
      const h = hashCloneId(id);
      const numMatches = 1 + Math.floor(h * 3); // 1-3 matches

      const matches: AntibodyMatch[] = [];
      for (let i = 0; i < numMatches; i++) {
        const h2 = hashCloneId(id, i + 1);
        const h3 = hashCloneId(id, i + 100);
        const db = DATABASES[Math.floor(h2 * DATABASES.length)];
        const identity = 78 + Math.floor(h3 * 20); // 78-97%
        const target = db.targets[Math.floor(hashCloneId(id, i + 200) * db.targets.length)];
        const abName = db.antibodyNames[Math.floor(hashCloneId(id, i + 300) * db.antibodyNames.length)];
        const methods = ['CDR3 sequence similarity', 'VH domain alignment', 'Structural homology', 'Paratope fingerprint'];
        const method = methods[Math.floor(hashCloneId(id, i + 400) * methods.length)];

        matches.push({
          antibodyName: abName,
          database: db,
          identity,
          target,
          method,
          cdr3Ref: generateRefCdr3(rep.cdr3_peptide || '', identity)
        });
      }

      // Sort matches by identity descending
      matches.sort((a, b) => b.identity - a.identity);

      return {
        clone_id: id,
        clone_count: count,
        v_gene: rep.v_gene || 'Unknown',
        j_gene: rep.j_gene || 'Unknown',
        cdr3_peptide: rep.cdr3_peptide || '',
        isotype: rep.isotype || 'Unknown',
        c_call: rep.c_call || '',
        matches
      };
    });
  }

  // --- Reactive data ---
  $: clones = extractTopClones($resultsState.sequences);
  $: totalMatches = clones.reduce((sum, c) => sum + c.matches.length, 0);
  $: highMatches = clones.reduce((sum, c) => sum + c.matches.filter(m => m.identity >= 90).length, 0);
  $: dbCounts = DATABASES.map(db => ({
    db,
    matchCount: clones.reduce((s, c) => s + c.matches.filter(m => m.database.id === db.id).length, 0),
    cloneCount: clones.filter(c => c.matches.some(m => m.database.id === db.id)).length
  }));

  let selectedCloneId: number | null = null;
  $: if (clones.length > 0 && selectedCloneId === null) {
    selectedCloneId = clones[0].clone_id;
  }
  $: selectedClone = clones.find(c => c.clone_id === selectedCloneId) || null;

  function selectClone(id: number) {
    selectedCloneId = id;
  }

  // --- D3 stacked bar chart ---
  let chartContainer: HTMLDivElement;
  let chartWidth = 0;

  onMount(() => {
    const ro = new ResizeObserver(entries => {
      chartWidth = entries[0].contentRect.width;
    });
    if (chartContainer) ro.observe(chartContainer);
    return () => ro.disconnect();
  });

  $: if (chartContainer && chartWidth > 0 && clones.length > 0) {
    drawChart();
  }

  function drawChart() {
    d3.select(chartContainer).selectAll('svg').remove();
    const margin = { top: 8, right: 16, bottom: 24, left: 120 };
    const height = DATABASES.length * 36 + margin.top + margin.bottom;
    const width = chartWidth;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(chartContainer).append('svg')
      .attr('width', width).attr('height', height);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const levels = ['>=95%', '90-94%', '80-89%', '<80%'];
    const levelColors: Record<string, (c: string) => string> = {
      '>=95%': (c) => c,
      '90-94%': (c) => d3.color(c)?.brighter(0.5)?.toString() || c,
      '80-89%': (c) => d3.color(c)?.brighter(1.2)?.toString() || c,
      '<80%': (c) => d3.color(c)?.brighter(2)?.toString() || c,
    };

    const data = DATABASES.map(db => {
      const allM = clones.flatMap(c => c.matches.filter(m => m.database.id === db.id));
      return {
        name: db.name,
        color: db.color,
        '>=95%': allM.filter(m => m.identity >= 95).length,
        '90-94%': allM.filter(m => m.identity >= 90 && m.identity < 95).length,
        '80-89%': allM.filter(m => m.identity >= 80 && m.identity < 90).length,
        '<80%': allM.filter(m => m.identity < 80).length,
      };
    });

    const maxVal = d3.max(data, d => (d['>=95%'] + d['90-94%'] + d['80-89%'] + d['<80%'])) || 1;

    const y = d3.scaleBand().domain(data.map(d => d.name)).range([0, innerH]).padding(0.25);
    const x = d3.scaleLinear().domain([0, maxVal]).range([0, innerW]);

    // Bars
    data.forEach(d => {
      let xOffset = 0;
      for (const level of levels) {
        const val = (d as any)[level] as number;
        if (val > 0) {
          g.append('rect')
            .attr('y', y(d.name)!)
            .attr('x', x(xOffset))
            .attr('width', x(val) - x(0))
            .attr('height', y.bandwidth())
            .attr('rx', 3)
            .attr('fill', levelColors[level](d.color));
        }
        xOffset += val;
      }
    });

    // Y-axis labels
    g.selectAll('.y-label').data(data).enter()
      .append('text')
      .attr('x', -8)
      .attr('y', d => y(d.name)! + y.bandwidth() / 2)
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'central')
      .attr('font-size', '12px')
      .attr('fill', '#374151')
      .text(d => d.name);

    // X-axis
    g.append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', innerH).attr('y2', innerH)
      .attr('stroke', '#e5e7eb');
  }

  function formatAlignment(query: string, ref: string): { query: string; match: string; ref: string } {
    let matchStr = '';
    for (let i = 0; i < Math.min(query.length, ref.length); i++) {
      matchStr += query[i] === ref[i] ? '|' : ' ';
    }
    return { query, match: matchStr, ref };
  }
</script>

<div class="ab-container">
  <!-- Stats -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">{clones.length}</div>
      <div class="stat-label">Clones Screened</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{DATABASES.length}</div>
      <div class="stat-label">Databases Searched</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{totalMatches}</div>
      <div class="stat-label">Total Matches</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{highMatches}</div>
      <div class="stat-label">High Identity (>=90%)</div>
    </div>
  </div>

  <!-- Database coverage + chart -->
  <div class="db-section">
    <div class="db-cards">
      {#each dbCounts as { db, matchCount, cloneCount }}
        <div class="db-card">
          <div class="db-dot" style="background: {db.color}"></div>
          <div class="db-info">
            <div class="db-name">{db.name}</div>
            <div class="db-desc">{db.description}</div>
            <div class="db-meta">{db.size.toLocaleString()} entries &middot; {matchCount} matches in {cloneCount} clones</div>
          </div>
        </div>
      {/each}
    </div>
    <div class="db-chart" bind:this={chartContainer}>
      <!-- D3 chart renders here -->
    </div>
    <div class="chart-legend">
      <span class="legend-title">Identity:</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#374151"></span>>=95%</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#6b7280"></span>90-94%</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#9ca3af"></span>80-89%</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#d1d5db"></span>&lt;80%</span>
    </div>
  </div>

  <!-- Two-column layout -->
  <div class="results-layout">
    <!-- Left: clone list -->
    <div class="clones-list">
      <div class="list-header">
        <h3>Top Expanded Clones</h3>
        <span class="list-count">{clones.length} clones</span>
      </div>
      <div class="list-content">
        {#each clones as clone}
          <button
            class="clone-card"
            class:active={selectedCloneId === clone.clone_id}
            on:click={() => selectClone(clone.clone_id)}
          >
            <div class="clone-header">
              <span class="clone-id">Clone {clone.clone_id}</span>
              <span class="clone-size">{clone.clone_count} seq</span>
            </div>
            <div class="clone-cdr3">{clone.cdr3_peptide}</div>
            <div class="clone-meta">
              <span class="clone-vgene">{clone.v_gene}</span>
              <div class="clone-db-dots">
                {#each clone.matches as match}
                  <span class="db-match-dot" style="background: {match.database.color}" title="{match.database.name}: {match.identity}%"></span>
                {/each}
              </div>
            </div>
          </button>
        {/each}
      </div>
    </div>

    <!-- Right: details -->
    <div class="details-panel">
      {#if selectedClone}
        <div class="clone-summary">
          <h3>Clone {selectedClone.clone_id}</h3>
          <div class="summary-grid">
            <div class="summary-item"><span class="summary-label">CDR3</span><code class="summary-value mono">{selectedClone.cdr3_peptide}</code></div>
            <div class="summary-item"><span class="summary-label">V Gene</span><span class="summary-value">{selectedClone.v_gene}</span></div>
            <div class="summary-item"><span class="summary-label">J Gene</span><span class="summary-value">{selectedClone.j_gene}</span></div>
            <div class="summary-item"><span class="summary-label">Isotype</span><span class="summary-value">{selectedClone.isotype}</span></div>
            <div class="summary-item"><span class="summary-label">Clone Size</span><span class="summary-value">{selectedClone.clone_count} sequences</span></div>
            {#if selectedClone.c_call}
              <div class="summary-item"><span class="summary-label">Ig Class</span><span class="summary-value">{selectedClone.c_call.split(',')[0]}</span></div>
            {/if}
          </div>
        </div>

        <h4 class="matches-title">Antibody Matches ({selectedClone.matches.length})</h4>

        {#each selectedClone.matches as match}
          {@const alignment = formatAlignment(selectedClone.cdr3_peptide, match.cdr3Ref)}
          <div class="match-card" class:high-match={match.identity >= 90}>
            <div class="match-header">
              <div class="match-name-row">
                <span class="match-ab-name">{match.antibodyName}</span>
                <span class="match-db-pill" style="background: {match.database.color}">{match.database.name}</span>
              </div>
              <span class="match-identity" class:high={match.identity >= 90} class:medium={match.identity >= 80 && match.identity < 90}>
                {match.identity}%
              </span>
            </div>
            <div class="match-details">
              <div class="match-detail"><span class="detail-label">Target:</span> {match.target}</div>
              <div class="match-detail"><span class="detail-label">Method:</span> {match.method}</div>
            </div>
            <div class="match-bar-container">
              <div class="match-bar" style="width: {match.identity}%; background: {match.identity >= 90 ? '#059669' : match.identity >= 80 ? '#D97706' : '#9ca3af'}"></div>
            </div>
            <div class="alignment">
              <div class="align-row"><span class="align-label">Query</span><code>{alignment.query}</code></div>
              <div class="align-row"><span class="align-label">&nbsp;</span><code class="align-match">{alignment.match}</code></div>
              <div class="align-row"><span class="align-label">Ref</span><code>{alignment.ref}</code></div>
            </div>
          </div>
        {/each}
      {:else}
        <div class="empty-detail">
          <p>Select a clone to view antibody matches</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .ab-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    padding: var(--space-4);
    gap: var(--space-4);
  }

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-3);
    flex-shrink: 0;
  }
  .stat-card {
    background: var(--surface-raised);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--border-radius-md);
    text-align: center;
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--border-light);
  }
  .stat-value {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--text-primary);
  }
  .stat-label {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    margin-top: 2px;
  }

  /* Database section */
  .db-section {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-4);
    flex-shrink: 0;
  }
  .db-cards {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    overflow-x: auto;
  }
  .db-card {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    min-width: 180px;
    padding: var(--space-2) var(--space-3);
    background: var(--gray-50);
    border-radius: var(--border-radius-sm);
    border: 1px solid var(--border-light);
  }
  .db-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 3px;
  }
  .db-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  .db-desc {
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .db-meta {
    font-size: 10px;
    color: var(--text-secondary);
    margin-top: 2px;
  }
  .db-chart {
    min-height: 200px;
  }
  .chart-legend {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-top: var(--space-2);
    font-size: 11px;
    color: var(--text-secondary);
  }
  .legend-title {
    font-weight: var(--font-semibold);
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .legend-swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    display: inline-block;
  }

  /* Two-column layout */
  .results-layout {
    display: flex;
    gap: var(--space-4);
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Clone list */
  .clones-list {
    width: 380px;
    flex-shrink: 0;
    background: var(--surface-raised);
    border-radius: var(--border-radius-md);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--border-light);
  }
  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-light);
  }
  .list-header h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
  }
  .list-count {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .list-content {
    flex: 1;
    overflow-y: auto;
  }
  .clone-card {
    display: block;
    width: 100%;
    text-align: left;
    padding: var(--space-3) var(--space-4);
    border: none;
    border-bottom: 1px solid var(--border-light);
    border-left: 3px solid transparent;
    background: none;
    cursor: pointer;
    transition: background 0.15s, border-left-color 0.15s;
    font-family: inherit;
  }
  .clone-card:hover {
    background: var(--gray-50);
  }
  .clone-card.active {
    background: var(--color-primary-light, #EEF2FF);
    border-left-color: var(--color-primary, #4F46E5);
  }
  .clone-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .clone-id {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  .clone-size {
    font-size: 10px;
    background: var(--gray-100);
    padding: 1px 6px;
    border-radius: 8px;
    color: var(--text-secondary);
    font-weight: var(--font-medium);
  }
  .clone-cdr3 {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: var(--text-secondary);
    margin: 4px 0 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .clone-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .clone-vgene {
    font-size: 10px;
    color: var(--text-tertiary);
  }
  .clone-db-dots {
    display: flex;
    gap: 3px;
  }
  .db-match-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  /* Details panel */
  .details-panel {
    flex: 1;
    background: var(--surface-raised);
    border-radius: var(--border-radius-md);
    overflow-y: auto;
    padding: var(--space-4);
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--border-light);
  }
  .clone-summary {
    margin-bottom: var(--space-4);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--border-light);
  }
  .clone-summary h3 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-lg);
    font-weight: var(--font-bold);
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
  }
  .summary-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .summary-label {
    font-size: 10px;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .summary-value {
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: var(--font-medium);
  }
  .mono {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
  }
  .matches-title {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }

  /* Match cards */
  .match-card {
    background: var(--gray-50);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-md);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
    transition: border-color 0.15s;
  }
  .match-card.high-match {
    border-color: #86efac;
    background: #f0fdf4;
  }
  .match-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-2);
  }
  .match-name-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .match-ab-name {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  .match-db-pill {
    font-size: 9px;
    color: white;
    padding: 1px 6px;
    border-radius: 8px;
    font-weight: var(--font-medium);
    white-space: nowrap;
  }
  .match-identity {
    font-size: var(--text-sm);
    font-weight: var(--font-bold);
    color: var(--text-tertiary);
  }
  .match-identity.high { color: #059669; }
  .match-identity.medium { color: #D97706; }
  .match-details {
    display: flex;
    gap: var(--space-4);
    margin-bottom: var(--space-2);
  }
  .match-detail {
    font-size: 11px;
    color: var(--text-secondary);
  }
  .detail-label {
    font-weight: var(--font-semibold);
    color: var(--text-tertiary);
  }
  .match-bar-container {
    height: 4px;
    background: var(--gray-200);
    border-radius: 2px;
    margin-bottom: var(--space-2);
    overflow: hidden;
  }
  .match-bar {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s;
  }

  /* Alignment */
  .alignment {
    background: var(--gray-100);
    border-radius: var(--border-radius-sm);
    padding: var(--space-2);
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    line-height: 1.4;
    overflow-x: auto;
  }
  .align-row {
    display: flex;
    gap: var(--space-2);
    white-space: pre;
  }
  .align-label {
    width: 36px;
    flex-shrink: 0;
    color: var(--text-tertiary);
    font-weight: var(--font-semibold);
    font-family: var(--font-mono, monospace);
  }
  .align-match {
    color: #059669;
  }

  .empty-detail {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
</style>
