<script lang="ts">
  import type { SequenceData } from '../../lib/stores/app';
  
  export let sequence: SequenceData;
  
  // Function to clean the sequence name for display (remove file ID suffix)
  function cleanSequenceName(name: string): string {
    // Legacy format: |||filename.fasta
    if (name.includes('|||')) {
      return name.split('|||')[0];
    }
    // New format: numeric file ID suffix _XXXX (4+ digits, >= 1001)
    const match = name.match(/^(.+)_(\d{4,})$/);
    if (match && parseInt(match[2]) >= 1001) {
      return match[1];
    }
    // Fallback for old format with _ delimiter
    if (name.includes('_') && (name.endsWith('.fasta') || name.endsWith('.fa'))) {
      const parts = name.split('_');
      // Remove the last part if it looks like a filename
      if (parts[parts.length - 1].includes('.fasta') || parts[parts.length - 1].includes('.fa')) {
        return parts.slice(0, -1).join('_');
      }
    }
    return name;
  }

  /** Convert raw c_call (e.g. "IGHM*01") to friendly isotype name (e.g. "IgM"). */
  function cCallToLabel(cCall: string): string {
    const upper = cCall.toUpperCase();
    if (upper.startsWith('IGHM')) return 'IgM';
    if (upper.startsWith('IGHD')) return 'IgD';
    if (upper.startsWith('IGHG')) return 'IgG';
    if (upper.startsWith('IGHA')) return 'IgA';
    if (upper.startsWith('IGHE')) return 'IgE';
    return cCall; // fallback: raw value
  }

  /** Return a CSS colour class suffix for the isotype. */
  function igColorClass(cCall: string): string {
    const upper = cCall.toUpperCase();
    if (upper.startsWith('IGHM')) return 'igm';
    if (upper.startsWith('IGHD')) return 'igd';
    if (upper.startsWith('IGHG')) return 'igg';
    if (upper.startsWith('IGHA')) return 'iga';
    if (upper.startsWith('IGHE')) return 'ige';
    return '';
  }
</script>

<div class="sequence-details">
  <!-- Header -->
  <div class="details-header">
    <div class="header-main">
      <h2 class="sequence-name">{cleanSequenceName(sequence.name)}</h2>
      <div class="header-badges">
        {#if sequence.c_call}
          <span
            class="badge ig-class {igColorClass(sequence.c_call)}"
            title="{sequence.c_call}"
          >
            {cCallToLabel(sequence.c_call)}
          </span>
        {/if}
        {#if sequence.isotype}
          <span 
            class="badge chain-type"
            class:heavy={sequence.isotype === 'Heavy'}
            class:kappa={sequence.isotype === 'Kappa'}
            class:lambda={sequence.isotype === 'Lambda'}
          >
            {sequence.isotype} chain
          </span>
        {/if}
        {#if sequence.somatic_mutations !== null && sequence.somatic_mutations !== undefined}
          <span class="badge mutations">
            {sequence.somatic_mutations} SHM
          </span>
        {/if}
      </div>
    </div>
  </div>
  
  <!-- Content cards -->
  <div class="details-content">
    <!-- V(D)J Genes Card -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">V(D)J Genes</h3>
      </div>
      <div class="card-body">
        <div class="gene-grid">
          <!-- V Gene -->
          <div class="gene-item">
            <div class="gene-badge v">V</div>
            <div class="gene-info">
              <span class="gene-label">Variable</span>
              {#if sequence.v_gene}
                <span class="gene-allele">{sequence.v_gene}</span>
                {#if sequence.v_locus}
                  <span class="gene-family">{sequence.v_locus}</span>
                {/if}
              {:else}
                <span class="gene-none">Not identified</span>
              {/if}
            </div>
          </div>
          
          <!-- D Gene -->
          <div class="gene-item">
            <div class="gene-badge d">D</div>
            <div class="gene-info">
              <span class="gene-label">Diversity</span>
              {#if sequence.d_gene}
                <span class="gene-allele">{sequence.d_gene}</span>
                {#if sequence.d_locus}
                  <span class="gene-family">{sequence.d_locus}</span>
                {/if}
              {:else}
                <span class="gene-none">Not identified</span>
              {/if}
            </div>
          </div>
          
          <!-- J Gene -->
          <div class="gene-item">
            <div class="gene-badge j">J</div>
            <div class="gene-info">
              <span class="gene-label">Joining</span>
              {#if sequence.j_gene}
                <span class="gene-allele">{sequence.j_gene}</span>
                {#if sequence.j_locus}
                  <span class="gene-family">{sequence.j_locus}</span>
                {/if}
              {:else}
                <span class="gene-none">Not identified</span>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- CDR3 Region Card -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">CDR3 Region</h3>
      </div>
      <div class="card-body">
        {#if sequence.cdr3_dna || sequence.cdr3_peptide}
          <div class="cdr3-info">
            {#if sequence.cdr3_dna}
              <div class="cdr3-row cdr3-row-dna">
                <span class="cdr3-label">DNA Sequence</span>
                <code class="cdr3-sequence dna">{sequence.cdr3_dna}</code>
              </div>
            {/if}
            
            {#if sequence.cdr3_peptide}
              <div class="cdr3-row">
                <span class="cdr3-label">Peptide Sequence</span>
                <code class="cdr3-sequence peptide">{sequence.cdr3_peptide}</code>
              </div>
            {/if}
            
            {#if sequence.cdr3_dna}
              <div class="cdr3-row">
                <span class="cdr3-label">Length</span>
                <span class="cdr3-value">{sequence.cdr3_dna.length} bp</span>
              </div>
            {/if}
          </div>
        {:else}
          <div class="empty-section">
            <span>CDR3 region not identified</span>
          </div>
        {/if}
      </div>
    </div>
    
    <!-- Clonality Card -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Clonality</h3>
      </div>
      <div class="card-body">
        {#if sequence.clone_id !== undefined}
          <div class="clonality-info">
            <div class="clone-main">
              <div class="clone-id-box">
                <span class="clone-label">Clone ID</span>
                <span class="clone-id">{sequence.clone_id}</span>
              </div>
              
              {#if sequence.clone_count !== undefined}
                <div class="clone-stat">
                  <span class="stat-value">{sequence.clone_count}</span>
                  <span class="stat-label">Sequences in Clone</span>
                </div>
              {/if}
            </div>
            
            <div class="clone-meta">
              {#if sequence.productive !== undefined}
                <div class="meta-item">
                  <span class="meta-label">Productive</span>
                  <span class="meta-value" class:positive={sequence.productive} class:negative={!sequence.productive}>
                    {sequence.productive ? 'Yes' : 'No'}
                  </span>
                </div>
              {/if}
            </div>
          </div>
        {:else}
          <div class="empty-section">
            <span>Clone information not available</span>
          </div>
        {/if}
      </div>
    </div>
    
    <!-- Full Sequences Card -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Full Sequences</h3>
      </div>
      <div class="card-body">
        <div class="sequence-debug">
          <div class="seq-row">
            <span class="seq-label">DNA Sequence:</span>
            <code class="seq-display dna">{sequence.dna_sequence || 'Not available'}</code>
          </div>
          <div class="seq-row">
            <span class="seq-label">DNA Length:</span>
            <span class="seq-value">{sequence.dna_sequence?.length || 0} nt</span>
          </div>
          <div class="seq-row">
            <span class="seq-label">AA Sequence (V-J):</span>
            <code class="seq-display aa">{sequence.aa_sequence || 'Not available'}</code>
          </div>
          <div class="seq-row">
            <span class="seq-label">AA Length:</span>
            <span class="seq-value">{sequence.aa_sequence?.length || 0} AA</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .sequence-details {
    padding: 0 !important;
    height: 100%;
    overflow-y: auto;
    width: 100% !important;
    min-width: 0;
    max-width: none !important;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  
  .details-header {
    margin-bottom: 0;
    width: 100%;
    box-sizing: border-box;
    padding: var(--space-4) var(--space-4) 0 var(--space-4);
  }
  
  .header-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  
  .sequence-name {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--text-primary);
    margin: 0;
    word-break: break-all;
    overflow-wrap: break-word;
    max-width: 100%;
  }
  
  .header-badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  
  .badge {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--border-radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
  }
  
  .badge.mutations {
    background: var(--color-warning-light);
    color: var(--color-warning);
  }
  
  /* Chain type (Heavy / Kappa / Lambda) */
  .badge.chain-type {
    background: var(--gray-100);
    color: var(--text-secondary);
  }
  
  .badge.chain-type.heavy {
    background: rgba(139, 92, 246, 0.1);
    color: #8B5CF6;
  }
  
  .badge.chain-type.kappa {
    background: rgba(16, 185, 129, 0.1);
    color: #10B981;
  }
  
  .badge.chain-type.lambda {
    background: rgba(245, 158, 11, 0.1);
    color: #F59E0B;
  }
  
  /* Isotype / Ig class (IgM, IgG, IgA, IgD, IgE) */
  .badge.ig-class {
    background: rgba(0, 102, 204, 0.1);
    color: var(--color-primary);
    font-weight: var(--font-semibold);
  }
  .badge.ig-class.igm { background: rgba(232, 93, 4, 0.12); color: #E85D04; }
  .badge.ig-class.igd { background: rgba(155, 89, 182, 0.12); color: #9B59B6; }
  .badge.ig-class.igg { background: rgba(0, 102, 204, 0.12); color: #0066CC; }
  .badge.ig-class.iga { background: rgba(45, 159, 63, 0.12); color: #2D9F3F; }
  .badge.ig-class.ige { background: rgba(231, 76, 60, 0.12); color: #E74C3C; }
  
  .details-content {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
    gap: var(--space-4);
    align-items: stretch;
    width: 100% !important;
    min-width: 0;
    max-width: none !important;
    box-sizing: border-box;
    padding: var(--space-4);
  }
  
  /* V(D)J Genes card spans full width */
  .card:first-child {
    grid-column: 1 / -1;
  }
  
  /* Ensure cards maintain consistent height and always stretch */
  .card {
    background: var(--surface-raised);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-lg);
    overflow: hidden;
    min-height: 0;
    min-width: 0;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    box-sizing: border-box;
  }
  
  /* Bottom row cards (CDR3 and Clonality) should have equal minimum height */
  .card:nth-child(2),
  .card:nth-child(3) {
    min-height: 300px;
  }
  
  .card-body {
    min-height: 0;
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    width: 100%;
    box-sizing: border-box;
  }
  
  .card-header {
    padding: var(--space-3) var(--space-4);
    background: var(--gray-50);
    border-bottom: 1px solid var(--border-light);
  }
  
  .card-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
  }
  
  .card-body {
    padding: var(--space-4);
  }
  
  /* V(D)J Genes */
  .gene-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    width: 100%;
    box-sizing: border-box;
  }
  
  .gene-item {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-3);
    background: var(--gray-50);
    border-radius: var(--border-radius-md);
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  
  .gene-badge {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--border-radius-md);
    font-size: var(--text-xs);
    font-weight: var(--font-bold);
    color: white;
    flex-shrink: 0;
  }
  
  .gene-badge.v { background: #3B82F6; }
  .gene-badge.d { background: #F59E0B; }
  .gene-badge.j { background: #10B981; }
  
  .gene-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  
  .gene-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  .gene-allele {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    word-break: break-all;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .gene-family {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  
  .gene-none {
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-style: italic;
  }
  
  /* CDR3 Region */
  .cdr3-info {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    min-width: 0;
    flex: 1;
    height: 100%;
    width: 100%;
    box-sizing: border-box;
  }
  
  .cdr3-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-height: 0;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  
  /* Make DNA sequence row expand to fill available space */
  .cdr3-row-dna {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  
  .cdr3-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  .cdr3-sequence {
    display: block;
    padding: var(--space-2) var(--space-3);
    background: var(--gray-50);
    border-radius: var(--border-radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-primary);
    word-break: break-all;
    line-height: 1.5;
    max-height: 120px;
    overflow-y: auto;
    overflow-x: hidden;
    white-space: pre-wrap;
    width: 100%;
    box-sizing: border-box;
  }
  
  .cdr3-sequence.peptide {
    letter-spacing: 2px;
    max-height: 80px;
    overflow-y: auto;
  }
  
  .cdr3-value {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  
  /* Clonality */
  .clonality-info {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    height: 100%;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    justify-content: flex-start;
    box-sizing: border-box;
  }
  
  .clone-main {
    display: flex;
    gap: var(--space-4);
    align-items: center;
  }
  
  .clone-id-box {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .clone-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  .clone-id {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--color-primary);
  }
  
  .clone-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-2) var(--space-4);
    background: var(--color-info-light);
    border-radius: var(--border-radius-md);
  }
  
  .stat-value {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    color: var(--color-info);
  }
  
  .stat-label {
    font-size: var(--text-xs);
    color: var(--color-info);
  }
  
  .clone-meta {
    display: flex;
    gap: var(--space-4);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border-light);
  }
  
  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .meta-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  
  .meta-value {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
  }
  
  .meta-value.positive {
    color: var(--color-success);
  }
  
  .meta-value.negative {
    color: var(--color-error);
  }
  
  .empty-section {
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-style: italic;
  }
  
  /* Debug Sequences */
  .sequence-debug {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  
  .seq-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  
  .seq-label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    font-weight: var(--font-medium);
  }
  
  .seq-display {
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 11px;
    padding: var(--space-2);
    background: var(--surface-base);
    border: 1px solid var(--border-light);
    border-radius: var(--border-radius-sm);
    word-break: break-all;
    overflow-wrap: break-word;
    max-height: 100px;
    overflow-y: auto;
  }
  
  .seq-display.dna {
    color: #3b82f6;
  }
  
  .seq-display.aa {
    color: #10b981;
  }
  
  .seq-value {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
</style>

