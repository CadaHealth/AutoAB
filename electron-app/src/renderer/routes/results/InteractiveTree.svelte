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
  let tree: any = null;
  let display: any = null; // TreeRender object returned by tree.render()
  let hasAttemptedLoad = false;
  let previousNewickPath = '';
  
  // Watch for newickPath changes and reload
  $: if (newickPath !== previousNewickPath) {
    console.log('[InteractiveTree] Tree changed, reloading...');
    previousNewickPath = newickPath;
    hasAttemptedLoad = false;
    isLoading = true;
    error = '';
    newickString = '';
    
    // Clean up old tree
    if (display && display.svg) {
      display.svg.remove();
    }
    display = null;
    tree = null;
    
    loadNewickFile();
  }
  
  async function loadNewickFile() {
    try {
      if (window.electronAPI) {
        const result: any = await window.electronAPI.readFile(newickPath);
        if (result.success && result.data) {
          newickString = result.data;
        } else {
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
      console.log('[InteractiveTree] Newick loaded, length:', newickString.length);
      isLoading = false;
    } catch (e: any) {
      error = e.message || 'Unknown error loading tree';
      isLoading = false;
    }
  }
  
  onMount(() => {
    console.log('[InteractiveTree] Component mounted');
  });
  
  // Reactive statement: Load tree when both newickString and containerDiv are ready
  $: if (newickString && containerDiv && !hasAttemptedLoad && !error) {
    console.log('[InteractiveTree] Both ready, loading phylotree...');
    console.log('[InteractiveTree] Tree has', cloneSize, 'sequences');
    hasAttemptedLoad = true;
    
    // Add timeout for large trees
    const timeoutMs = cloneSize > 100 ? 60000 : 30000; // 60s for large, 30s for medium
    const timeoutId = setTimeout(() => {
      if (isLoading) {
        error = `Tree is too large (${cloneSize} sequences). phylotree.js timed out after ${timeoutMs/1000}s.`;
        isLoading = false;
      }
    }, timeoutMs);
    
    loadPhylotree().then(() => {
      clearTimeout(timeoutId);
      console.log('[InteractiveTree] Tree loaded successfully!');
      isLoading = false;
    }).catch((e) => {
      clearTimeout(timeoutId);
      console.error('[InteractiveTree] Failed to load tree:', e);
      error = `Failed to render tree: ${e.message}`;
      isLoading = false;
    });
  }
  
  onDestroy(() => {
    if (display && display.svg) {
      display.svg.remove();
    }
  });
  
  async function loadPhylotree() {
    console.log('[InteractiveTree] Step 1: loadPhylotree called');
    
    if (!newickString || !containerDiv) {
      console.error('[InteractiveTree] Missing data - newickString:', !!newickString, 'containerDiv:', !!containerDiv);
      error = 'Missing Newick data or container';
      return;
    }
    
    console.log('[InteractiveTree] Step 2: Importing phylotree library...');
    // Import phylotree - it exports { phylotree } as a named export
    const { phylotree: Phylotree } = await import('phylotree');
    console.log('[InteractiveTree] Step 3: phylotree class imported');
    
    // Clear container
    d3.select(containerDiv).selectAll('*').remove();
    
    console.log('[InteractiveTree] Step 4: Getting container dimensions...');
    
    // Double-check containerDiv is still available (safety check)
    if (!containerDiv) {
      throw new Error('Container div became null during rendering');
    }
    
    // Get container dimensions
    const rect = containerDiv.getBoundingClientRect();
    const width = rect.width || 1200;
    const height = rect.height || 800;
    
    try {
      console.log('[InteractiveTree] Step 5: Creating phylotree instance with Newick string...');
      // Create phylotree instance (API: new Phylotree(newick))
      tree = new Phylotree(newickString);
      console.log('[InteractiveTree] Step 6: Phylotree instance created');
      
      // Use actual tip count for layout (collapsed trees have fewer tips than clone size)
      const tipCount = tree.getTips ? tree.getTips().length : cloneSize;
      console.log('[InteractiveTree] Tree has', tipCount, 'tips (clone has', cloneSize, 'sequences)');
      
      console.log('[InteractiveTree] Step 7: Rendering tree (may take a few seconds)...');
      
      // Calculate spacing, font size, and container height based on actual tip count
      // (collapsed trees have fewer tips, so we don't over-allocate vertical space)
      let topBottomSpacing: number = 20;
      let fontSize = '11px';
      let calculatedHeight = height;
      
      if (tipCount < 10) {
        topBottomSpacing = 80; // Large spacing for small trees
        fontSize = '11px';
        calculatedHeight = Math.max(600, tipCount * topBottomSpacing);
      } else if (tipCount < 30) {
        topBottomSpacing = 50; // Medium spacing
        fontSize = '10px';
        calculatedHeight = Math.max(600, tipCount * topBottomSpacing);
      } else if (tipCount < 60) {
        topBottomSpacing = 35; // Smaller spacing
        fontSize = '9px';
        calculatedHeight = Math.max(800, tipCount * topBottomSpacing);
      } else if (tipCount < 100) {
        topBottomSpacing = 28; // Compact
        fontSize = '8px';
        calculatedHeight = Math.max(1000, tipCount * topBottomSpacing);
      } else if (tipCount < 200) {
        topBottomSpacing = 25; // Compact spacing
        fontSize = '8px';
        calculatedHeight = Math.max(1200, tipCount * topBottomSpacing);
      } else if (tipCount < 300) {
        topBottomSpacing = 20; // Very compact
        fontSize = '7px';
        calculatedHeight = Math.max(1500, tipCount * topBottomSpacing);
      } else {
        topBottomSpacing = 16; // Minimum spacing for very large trees
        fontSize = '6px';
        calculatedHeight = Math.max(2000, tipCount * topBottomSpacing);
      }
      
      // Cap height to avoid excessively tall SVGs (e.g. 5000px max)
      const maxHeight = 4000;
      calculatedHeight = Math.min(calculatedHeight, maxHeight);
      
      console.log('[InteractiveTree] Using top-bottom-spacing:', topBottomSpacing, 'font-size:', fontSize, 'calculated-height:', calculatedHeight, 'for', tipCount, 'tips');
      
      // Render the tree - render() returns a TreeRender object
      // phylotree will create its own SVG inside the container
      display = tree.render({
        container: containerDiv, // Pass the DOM element directly
        height: calculatedHeight,
        width: width,
        'left-right-spacing': 'fit-to-size',
        'top-bottom-spacing': topBottomSpacing,
        'node_circle_size': () => {
          // Return 0 for no circles, or size based on node type
          return 0;
        },
        'node-styler': (element: any, data: any) => {
          // Style nodes (germline in red, others in blue)
          const isGermline = data.name && data.name.includes('GERM');
          
          element
            .selectAll("circle")
            .attr("r", isGermline ? 6 : 3)
            .style("fill", isGermline ? "#dc2626" : "#3b82f6")
            .style("stroke", isGermline ? "#991b1b" : "#1e40af");
            
          element
            .selectAll("text")
            .style("fill", isGermline ? "#dc2626" : "#374151")
            .style("font-weight", isGermline ? "bold" : "normal")
            .style("font-size", fontSize)
            .style("font-family", "monospace");
        },
        'edge-styler': (element: any) => {
          element
            .style("stroke", "#6b7280")
            .style("stroke-width", "2px");
        },
        zoom: true, // Use phylotree's built-in zoom (handles scale bar, etc.)
        brush: false,
        'show-scale': true,
        'align-tips': false
      });
      
      console.log('[InteractiveTree] Step 8: Tree rendered successfully!');
      console.log('[InteractiveTree] Display object:', display);
      console.log('[InteractiveTree] Display.svg:', display?.svg);
      console.log('[InteractiveTree] Container children before append:', containerDiv.children.length);
      
      // phylotree creates SVG with d3.create() which doesn't attach to DOM
      // We need to manually append it to the container
      if (display && display.svg) {
        const svgNode = display.svg.node();
        console.log('[InteractiveTree] SVG node:', svgNode);
        console.log('[InteractiveTree] SVG node parent:', svgNode?.parentNode);
        
        if (svgNode) {
          if (!containerDiv.contains(svgNode)) {
            console.log('[InteractiveTree] Appending SVG to container...');
            containerDiv.appendChild(svgNode);
            console.log('[InteractiveTree] SVG appended! Container now has', containerDiv.children.length, 'children');
            console.log('[InteractiveTree] Container HTML:', containerDiv.innerHTML.substring(0, 200));
          } else {
            console.log('[InteractiveTree] SVG already in container');
          }
          
          console.log('[InteractiveTree] phylotree.js built-in zoom is enabled - use mouse/trackpad to zoom/pan');
        } else {
          console.warn('[InteractiveTree] SVG node is null');
        }
      } else {
        console.warn('[InteractiveTree] Display or SVG not found after render');
      }
      
    } catch (e: any) {
      error = `Failed to render tree: ${e.message}`;
      console.error('Phylotree error:', e);
    }
  }
  
  // phylotree.js handles zoom/pan automatically with mouse/trackpad
  function resetZoom() {
    console.log('[InteractiveTree] Resetting zoom by reloading tree');
    
    // Clean up old tree first
    if (display && display.svg) {
      display.svg.remove();
    }
    display = null;
    tree = null;
    
    // Reset state to trigger reactive re-load
    hasAttemptedLoad = false;
    error = '';
    newickString = '';
    isLoading = true;
    
    // Reload the Newick file (this will trigger the reactive statement to re-render)
    loadNewickFile();
  }
  
  // Helper: Inline all computed styles into SVG elements
  function inlineStyles(svgNode: SVGSVGElement): SVGSVGElement {
    const clonedSvg = svgNode.cloneNode(true) as SVGSVGElement;
    
    // Get all elements in both original and cloned SVG
    const originalElements = svgNode.querySelectorAll('*');
    const clonedElements = clonedSvg.querySelectorAll('*');
    
    // Copy computed styles to inline styles
    originalElements.forEach((originalEl, index) => {
      const clonedEl = clonedElements[index] as HTMLElement | SVGElement;
      const computedStyle = window.getComputedStyle(originalEl);
      
      // Check element class to determine if it's a branch/edge
      const className = (originalEl as any).className;
      const classList = (typeof className === 'object' && className.baseVal) ? className.baseVal : className;
      const isBranch = typeof classList === 'string' && classList.includes('branch');
      const isNode = typeof classList === 'string' && (classList.includes('node') || classList.includes('internal-node'));
      
      // For branches/edges: explicitly set fill="none" and apply stroke styles
      if (isBranch) {
        (clonedEl as SVGElement).setAttribute('fill', 'none');
        const stroke = computedStyle.getPropertyValue('stroke');
        const strokeWidth = computedStyle.getPropertyValue('stroke-width');
        const strokeLinecap = computedStyle.getPropertyValue('stroke-linecap');
        
        if (stroke && stroke !== 'none') (clonedEl as SVGElement).setAttribute('stroke', stroke);
        if (strokeWidth) (clonedEl as SVGElement).setAttribute('stroke-width', strokeWidth);
        if (strokeLinecap) (clonedEl as SVGElement).setAttribute('stroke-linecap', strokeLinecap);
      }
      
      // For nodes: preserve fill and remove stroke if not needed
      if (isNode) {
        const fill = computedStyle.getPropertyValue('fill');
        const stroke = computedStyle.getPropertyValue('stroke');
        
        if (fill && fill !== 'none') (clonedEl as SVGElement).setAttribute('fill', fill);
        if (stroke && stroke !== 'none') (clonedEl as SVGElement).setAttribute('stroke', stroke);
      }
      
      // List of style properties to copy for all elements
      const stylesToCopy = [
        'opacity', 'font-size', 'font-family', 'font-weight',
        'text-anchor', 'dominant-baseline', 'color'
      ];
      
      stylesToCopy.forEach(prop => {
        const value = computedStyle.getPropertyValue(prop);
        if (value && value !== 'none' && value !== 'normal') {
          (clonedEl as HTMLElement).style.setProperty(prop, value);
        }
      });
      
      // Handle text elements specifically
      if (originalEl.tagName === 'text') {
        const fill = computedStyle.getPropertyValue('fill');
        const fontSize = computedStyle.getPropertyValue('font-size');
        const fontFamily = computedStyle.getPropertyValue('font-family');
        const fontWeight = computedStyle.getPropertyValue('font-weight');
        
        if (fill) (clonedEl as SVGElement).setAttribute('fill', fill);
        if (fontSize) (clonedEl as SVGElement).setAttribute('font-size', fontSize);
        if (fontFamily) (clonedEl as SVGElement).setAttribute('font-family', fontFamily);
        if (fontWeight) (clonedEl as SVGElement).setAttribute('font-weight', fontWeight);
      }
      
      // Handle circle elements (node markers)
      if (originalEl.tagName === 'circle') {
        const fill = computedStyle.getPropertyValue('fill');
        const stroke = computedStyle.getPropertyValue('stroke');
        const strokeWidth = computedStyle.getPropertyValue('stroke-width');
        
        if (fill) (clonedEl as SVGElement).setAttribute('fill', fill);
        if (stroke) (clonedEl as SVGElement).setAttribute('stroke', stroke);
        if (strokeWidth) (clonedEl as SVGElement).setAttribute('stroke-width', strokeWidth);
      }
    });
    
    return clonedSvg;
  }
  
  // Export tree as PNG
  async function exportTreeAsPNG() {
    if (!display || !display.svg) {
      console.error('[InteractiveTree] No SVG available for export');
      return;
    }
    
    try {
      const svgNode = display.svg.node();
      
      // Clone and inline all computed styles
      const styledSvg = inlineStyles(svgNode);
      
      // Serialize the styled SVG
      const svgData = new XMLSerializer().serializeToString(styledSvg);
      
      // Create a canvas to convert SVG to PNG
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      const img = new Image();
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      
      img.onload = async () => {
        // Set canvas size to match SVG
        canvas.width = svgNode.width.baseVal.value || 1200;
        canvas.height = svgNode.height.baseVal.value || 800;
        
        // Draw white background
        ctx!.fillStyle = 'white';
        ctx!.fillRect(0, 0, canvas.width, canvas.height);
        
        // Draw SVG
        ctx!.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        
        // Convert to PNG and download
        canvas.toBlob(async (blob) => {
          if (blob) {
            const pngUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = pngUrl;
            a.download = `${treeName.replace(/\s+/g, '_')}.png`;
            a.click();
            URL.revokeObjectURL(pngUrl);
            console.log('[InteractiveTree] Exported tree as PNG');
          }
        }, 'image/png');
      };
      
      img.onerror = (e) => {
        console.error('[InteractiveTree] Failed to load SVG for export:', e);
        alert('Export failed. Please try again or use a different browser.');
      };
      
      img.src = url;
    } catch (e: any) {
      console.error('[InteractiveTree] Export failed:', e);
      alert(`Export failed: ${e.message}`);
    }
  }
  
  // Export tree as SVG
  function exportTreeAsSVG() {
    if (!display || !display.svg) {
      console.error('[InteractiveTree] No SVG available for export');
      return;
    }
    
    try {
      const svgNode = display.svg.node();
      
      // Clone and inline all computed styles
      const styledSvg = inlineStyles(svgNode);
      
      // Serialize the styled SVG
      const svgData = new XMLSerializer().serializeToString(styledSvg);
      
      const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `${treeName.replace(/\s+/g, '_')}.svg`;
      a.click();
      
      URL.revokeObjectURL(url);
      console.log('[InteractiveTree] Exported tree as SVG');
    } catch (e: any) {
      console.error('[InteractiveTree] Export failed:', e);
      alert(`Export failed: ${e.message}`);
    }
  }
</script>

<div class="interactive-tree-wrapper">
  <div class="tree-controls">
    <span class="control-hint">Drag to pan • Scroll to zoom</span>

    <button class="btn btn-secondary btn-xs" on:click={resetZoom} title="Reset View">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M8 2a6 6 0 1 0 4.2 10.2M12 2v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Reset
    </button>

    <button class="btn btn-primary btn-xs" on:click={exportTreeAsPNG} title="Export PNG" disabled={!display}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M8 1v8M8 9l-3-3M8 9l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 11v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      PNG
    </button>

    <button class="btn btn-secondary btn-xs" on:click={exportTreeAsSVG} title="Export SVG" disabled={!display}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M8 1v8M8 9l-3-3M8 9l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 11v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      SVG
    </button>
  </div>
  
  {#if isLoading}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading interactive tree...</p>
      {#if cloneSize > 100}
        <p class="loading-hint">Large tree with {cloneSize} sequences - this may take 20-40 seconds</p>
      {:else if cloneSize > 50}
        <p class="loading-hint">Loading tree with {cloneSize} sequences - this may take 10-20 seconds</p>
      {/if}
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
  .interactive-tree-wrapper {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: white;
    position: relative;
  }
  
  .tree-controls {
    padding: 3px var(--space-2);
    border-bottom: 1px solid var(--gray-200);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
    background: var(--gray-50);
  }

  .control-hint {
    font-size: 10px;
    color: var(--gray-500);
    white-space: nowrap;
    margin-right: auto;
  }

  .btn-xs {
    font-size: 11px;
    padding: 2px 6px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    border-radius: var(--border-radius-sm);
    line-height: 1.3;
  }
  
  .tree-container {
    flex: 1;
    overflow: auto; /* Allow scrolling for large trees */
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
  
  .loading-hint {
    font-size: 12px;
    color: var(--gray-500);
    margin-top: var(--space-2);
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
  
  /* Phylotree overrides */
  :global(.tree-container svg) {
    font-family: system-ui, -apple-system, sans-serif;
  }
  
  :global(.tree-container .node text) {
    font-size: 11px;
    fill: var(--gray-700);
  }
  
  :global(.tree-container .branch) {
    stroke: var(--gray-400);
    stroke-width: 2px;
    fill: none;
  }
</style>

