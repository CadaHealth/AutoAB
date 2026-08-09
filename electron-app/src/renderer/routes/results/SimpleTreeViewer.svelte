<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  
  export let newickPath: string;
  export let treeName: string;
  export let cloneSize: number;
  
  let containerDiv: HTMLDivElement;
  let newickString: string = '';
  let isLoading = true;
  let error: string = '';
  let svg: any = null;
  let zoomBehavior: any = null;
  let hasRendered = false;
  let previousNewickPath = '';
  
  // Watch for newickPath changes and reload
  $: if (newickPath !== previousNewickPath) {
    console.log('[SimpleTreeViewer] Tree changed from', previousNewickPath, 'to', newickPath);
    previousNewickPath = newickPath;
    hasRendered = false;
    isLoading = true;
    error = '';
    newickString = '';
    loadNewickFile();
  }
  
  async function loadNewickFile() {
    console.log('[SimpleTreeViewer] Loading Newick file:', newickPath);

    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.readFile(newickPath);
        if (result.success && result.data) {
          newickString = result.data;
        } else {
          console.error('[SimpleTreeViewer] Failed to read file:', result.error);
          error = `Failed to read Newick file: ${result.error || 'Unknown error'}`;
          isLoading = false;
          return;
        }
      } else {
        // Demo mode: load from bundled demo data
        const { getDemoData } = await import('../../lib/demo-loader');
        const demoData = getDemoData();
        const nw = demoData?.newick_trees?.[newickPath];
        if (nw) {
          newickString = nw;
        } else {
          error = 'Tree data not available in demo';
          isLoading = false;
          return;
        }
      }
      console.log('[SimpleTreeViewer] Newick loaded, length:', newickString.length);
      isLoading = false;
    } catch (e: any) {
      console.error('[SimpleTreeViewer] Exception:', e);
      error = e.message || 'Unknown error loading tree';
      isLoading = false;
    }
  }
  
  onMount(() => {
    console.log('[SimpleTreeViewer] Component mounted');
  });
  
  // Reactive statement: render when BOTH newickString AND containerDiv are ready
  $: if (newickString && containerDiv && !hasRendered && !error) {
    console.log('[SimpleTreeViewer] ✅ Both newickString and containerDiv ready!');
    console.log('[SimpleTreeViewer] newickString length:', newickString.length);
    console.log('[SimpleTreeViewer] containerDiv:', containerDiv);
    
    // Clean up old SVG if exists
    if (svg) {
      console.log('[SimpleTreeViewer] Cleaning up old SVG...');
      svg.remove();
      svg = null;
    }
    
    hasRendered = true;
    renderTree();
  }
  
  onDestroy(() => {
    if (svg) {
      svg.remove();
    }
  });
  
  function parseNewick(newick: string): any {
    // Simple Newick parser
    const tokens: any[] = [];
    let depth = 0;
    let currentToken = '';
    
    for (let i = 0; i < newick.length; i++) {
      const char = newick[i];
      
      if (char === '(' || char === ',' || char === ')' || char === ';' || char === ':') {
        if (currentToken) {
          tokens.push({ type: 'name', value: currentToken.trim(), depth });
          currentToken = '';
        }
        
        if (char === '(') {
          tokens.push({ type: 'open', depth });
          depth++;
        } else if (char === ')') {
          depth--;
          tokens.push({ type: 'close', depth });
        } else if (char === ',') {
          tokens.push({ type: 'comma', depth });
        } else if (char === ':') {
          tokens.push({ type: 'colon', depth });
        } else if (char === ';') {
          tokens.push({ type: 'end', depth });
        }
      } else {
        currentToken += char;
      }
    }
    
    // Build simple tree structure
    const leaves: string[] = [];
    tokens.forEach(token => {
      if (token.type === 'name' && !token.value.match(/^\d+\.?\d*e?-?\d*$/)) {
        leaves.push(token.value);
      }
    });
    
    return { leaves, raw: newick };
  }
  
  function renderTree() {
    console.log('[SimpleTreeViewer] Rendering tree...');
    isLoading = true;
    
    try {
      // Parse Newick
      const tree = parseNewick(newickString);
      console.log('[SimpleTreeViewer] Parsed tree with', tree.leaves.length, 'leaves');
      
      // Clear container
      d3.select(containerDiv).selectAll('*').remove();
      
      // Get dimensions
      const rect = containerDiv.getBoundingClientRect();
      const width = rect.width || 1200;
      const height = rect.height || 800;
      
      console.log('[SimpleTreeViewer] Container dimensions:', width, 'x', height);
      
      // Create SVG
      svg = d3.select(containerDiv)
        .append('svg')
        .attr('width', '100%')
        .attr('height', '100%')
        .attr('viewBox', `0 0 ${width} ${height}`)
        .style('background', '#ffffff');
      
      const g = svg.append('g');
      
      // Add zoom behavior
      zoomBehavior = d3.zoom()
        .scaleExtent([0.1, 10])
        .on('zoom', (event: any) => {
          g.attr('transform', event.transform);
        });
      
      svg.call(zoomBehavior);
      
      // Simple vertical tree layout
      const leaves = tree.leaves;
      // Increase minimum spacing to prevent label overlap (60px minimum)
      const nodeHeight = Math.max(60, height / (leaves.length + 2));
      const startY = nodeHeight;
      
      // Helper function to truncate long labels
      const truncateLabel = (label: string, maxLength: number = 40) => {
        if (label.length <= maxLength) return label;
        return label.substring(0, maxLength - 3) + '...';
      };
      
      // Draw simple dendrogram
      leaves.forEach((leaf, i) => {
        const y = startY + (i * nodeHeight);
        const x = width - 300;
        
        // Draw horizontal line
        g.append('line')
          .attr('x1', x - 100)
          .attr('y1', y)
          .attr('x2', x)
          .attr('y2', y)
          .attr('stroke', leaf.includes('GERM') ? '#dc2626' : '#3b82f6')
          .attr('stroke-width', 2);
        
        // Draw node circle
        g.append('circle')
          .attr('cx', x)
          .attr('cy', y)
          .attr('r', leaf.includes('GERM') ? 6 : 4)
          .attr('fill', leaf.includes('GERM') ? '#dc2626' : '#3b82f6')
          .attr('stroke', leaf.includes('GERM') ? '#991b1b' : '#1e40af')
          .attr('stroke-width', 2);
        
        // Draw label with truncation and tooltip
        const labelText = g.append('text')
          .attr('x', x + 10)
          .attr('y', y)
          .attr('dy', '0.35em')
          .attr('font-size', '11px')
          .attr('font-family', 'monospace')
          .attr('fill', leaf.includes('GERM') ? '#dc2626' : '#374151')
          .attr('font-weight', leaf.includes('GERM') ? 'bold' : 'normal')
          .text(truncateLabel(leaf));
        
        // Add tooltip title for full label
        labelText.append('title').text(leaf);
      });
      
      // Draw connecting vertical lines
      if (leaves.length > 1) {
        g.append('line')
          .attr('x1', width - 400)
          .attr('y1', startY)
          .attr('x2', width - 400)
          .attr('y2', startY + ((leaves.length - 1) * nodeHeight))
          .attr('stroke', '#6b7280')
          .attr('stroke-width', 2);
        
        // Connect to horizontal lines
        leaves.forEach((leaf, i) => {
          const y = startY + (i * nodeHeight);
          g.append('line')
            .attr('x1', width - 400)
            .attr('y1', y)
            .attr('x2', width - 300)
            .attr('y2', y)
            .attr('stroke', '#6b7280')
            .attr('stroke-width', 2);
        });
      }
      
      console.log('[SimpleTreeViewer] Tree rendered successfully!');
      isLoading = false;
      
    } catch (e: any) {
      console.error('[SimpleTreeViewer] Render error:', e);
      error = `Failed to render tree: ${e.message}`;
      isLoading = false;
    }
  }
  
  function zoomIn() {
    if (svg && zoomBehavior) {
      svg.transition().duration(300).call(zoomBehavior.scaleBy, 1.3);
    }
  }
  
  function zoomOut() {
    if (svg && zoomBehavior) {
      svg.transition().duration(300).call(zoomBehavior.scaleBy, 0.7);
    }
  }
  
  function resetZoom() {
    if (svg && zoomBehavior) {
      svg.transition().duration(500).call(
        zoomBehavior.transform,
        d3.zoomIdentity
      );
    }
  }
</script>

<div class="tree-wrapper">
  <div class="tree-controls">
    <div class="control-group">
      <button class="btn btn-secondary btn-sm" on:click={zoomIn} title="Zoom In">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M10 10l4 4M6 4v4M4 6h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      
      <button class="btn btn-secondary btn-sm" on:click={zoomOut} title="Zoom Out">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M10 10l4 4M4 6h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      
      <button class="btn btn-secondary btn-sm" on:click={resetZoom} title="Reset Zoom">
        Reset
      </button>
    </div>
    
    <div class="info-text">
      <strong>{treeName}</strong> • {cloneSize} sequences • 
      🖱️ Drag to pan • Scroll to zoom • 
      <span class="germ-indicator">●</span> = Germline
    </div>
  </div>
  
  {#if isLoading}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading tree...</p>
    </div>
  {:else if error}
    <div class="error-state">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="22" stroke="currentColor" stroke-width="2"/>
        <path d="M24 14v14M24 32v0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <p class="error-message">{error}</p>
    </div>
  {:else}
    <div class="tree-container" bind:this={containerDiv}></div>
  {/if}
</div>

<style>
  .tree-wrapper {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: white;
  }
  
  .tree-controls {
    padding: var(--space-3);
    border-bottom: 1px solid var(--gray-200);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-shrink: 0;
    background: var(--gray-50);
  }
  
  .control-group {
    display: flex;
    gap: var(--space-2);
  }
  
  .info-text {
    font-size: 12px;
    color: var(--gray-700);
  }
  
  .germ-indicator {
    color: #dc2626;
    font-size: 16px;
    line-height: 1;
  }
  
  .tree-container {
    flex: 1;
    overflow: hidden;
    position: relative;
    background: white;
    cursor: grab;
  }
  
  .tree-container:active {
    cursor: grabbing;
  }
  
  .loading-state,
  .error-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    color: var(--gray-600);
  }
  
  .error-state {
    color: var(--color-error);
  }
  
  .error-message {
    max-width: 400px;
    text-align: center;
  }
  
  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid var(--gray-200);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>

