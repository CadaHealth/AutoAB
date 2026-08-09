/**
 * Pure Node/TypeScript loader for BCR analysis results.
 * Loads from disk without spawning Python - ensures correct directory is used.
 */

import * as fs from 'fs';
import * as path from 'path';

interface SequenceRecord {
  id: string;
  name: string;
  v_gene?: string | null;
  d_gene?: string | null;
  j_gene?: string | null;
  v_locus?: string | null;
  d_locus?: string | null;
  j_locus?: string | null;
  cdr3_dna?: string | null;
  cdr3_peptide?: string | null;
  somatic_mutations?: number | null;
  isotype?: string | null;
  c_call?: string | null;
  clone_id?: number | null;
  clone_count?: number;
  productive?: boolean;
  dna_sequence?: string | null;
  aa_sequence?: string | null;
  lineage_id?: number | null;
}

interface LoadCallbacks {
  onProgress: (data: { stage: string; percent: number; message: string }) => void;
  onLog: (data: { level: string; message: string }) => void;
  onResult: (data: { artifact: string; path?: string; data?: any }) => void;
  onComplete: (data: { success: boolean; error?: string }) => void;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === ',' && !inQuotes) || c === '\n' || c === '\r') {
      result.push(current.trim());
      current = '';
      if (c !== ',') break;
    } else {
      current += c;
    }
  }
  if (current.length > 0) result.push(current.trim());
  return result;
}

function parseTsvLine(line: string): string[] {
  return line.split('\t').map(s => s.trim());
}

function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(l => parseCsvLine(l)).filter(r => r.some(c => c.length > 0));
  return { headers, rows };
}

function parseTsv(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseTsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseTsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => { row[h] = vals[j] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function getSeqIdSuffix(seqId: string): string | null {
  const lastUnderscore = seqId.lastIndexOf('_');
  if (lastUnderscore >= 0) {
    const suffix = seqId.slice(lastUnderscore + 1);
    if (/^\d+$/.test(suffix)) return suffix;
  }
  if (seqId.includes('|||')) return seqId.split('|||').pop() ?? null;
  return null;
}

/**
 * Load results from the given output directory. Uses the exact path passed -
 * no Python, no subprocess, no path confusion.
 */
export function loadResultsFromDisk(
  outputDir: string,
  callbacks: LoadCallbacks
): void {
  const absOutputDir = path.resolve(outputDir);
  console.log('[ResultsLoader] Loading from:', absOutputDir);

  try {
    callbacks.onProgress({ stage: 'results', percent: 10, message: 'Loading results...' });
    callbacks.onLog({ level: 'info', message: `Loading results from ${absOutputDir}` });

    // 1. Load sequence IDs from combined.fasta
    const combinedPath = path.join(absOutputDir, 'combined.fasta');
    if (!fs.existsSync(combinedPath)) {
      callbacks.onComplete({ success: false, error: 'combined.fasta not found' });
      return;
    }
    const fastaContent = fs.readFileSync(combinedPath, 'utf-8');
    const sequenceNames: string[] = [];
    for (const line of fastaContent.split(/\r?\n/)) {
      if (line.startsWith('>')) {
        const id = line.slice(1).trim().split(/\s/)[0];
        if (id) sequenceNames.push(id);
      }
    }
    callbacks.onProgress({ stage: 'results', percent: 30, message: `Found ${sequenceNames.length} sequences` });

    // 2. Load file_id_mapping
    const mappingPath = path.join(absOutputDir, 'file_id_mapping.json');
    let fileIdMapping: Record<string, string> = {};
    if (fs.existsSync(mappingPath)) {
      fileIdMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
    }
    const filenameToId = Object.fromEntries(
      Object.entries(fileIdMapping).map(([k, v]) => [v, k])
    );

    function resolveFilename(seqId: string): string {
      const suffix = getSeqIdSuffix(seqId);
      if (suffix && fileIdMapping[suffix]) return fileIdMapping[suffix];
      if (seqId.includes('|||')) return seqId.split('|||').pop() ?? 'unknown.fasta';
      return 'unknown.fasta';
    }

    // 3. Load IgBLAST outdata.csv
    const outdataPath = path.join(absOutputDir, 'outdata.csv');
    if (!fs.existsSync(outdataPath)) {
      callbacks.onComplete({ success: false, error: 'outdata.csv not found' });
      return;
    }
    const csvContent = fs.readFileSync(outdataPath, 'utf-8');
    const { headers: csvHeaders, rows: csvRows } = parseCsv(csvContent);
    const queryIdIdx = csvHeaders.indexOf('query id');
    const chainTypeIdx = csvHeaders.indexOf('chain type');
    const subjectIdIdx = csvHeaders.indexOf('subject id');
    const alignLenIdx = csvHeaders.indexOf('alignment length');

    const blastByQuery: Record<string, Record<string, Record<string, string>>> = {};
    for (const row of csvRows) {
      const qid = row[queryIdIdx] ?? '';
      const chain = row[chainTypeIdx] ?? '';
      const subj = row[subjectIdIdx] ?? '';
      const alen = row[alignLenIdx] ?? '';
      if (!blastByQuery[qid]) blastByQuery[qid] = {};
      blastByQuery[qid][chain] = { subjectId: subj, alignmentLength: alen };
    }

    // 4. Load clonality data
    const clonePassPath = path.join(absOutputDir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv');
    const cloneData: Record<string, Partial<SequenceRecord>> = {};
    if (fs.existsSync(clonePassPath)) {
      const tsvContent = fs.readFileSync(clonePassPath, 'utf-8');
      const { rows: cloneRows } = parseTsv(tsvContent);
      const cloneCounts: Record<number, number> = {};
      for (const row of cloneRows) {
        const cid = row['clone_id'] ? parseInt(row['clone_id'], 10) : NaN;
        if (!isNaN(cid)) cloneCounts[cid] = (cloneCounts[cid] ?? 0) + 1;
      }
      for (const row of cloneRows) {
        const seqId = row['sequence_id'] ?? '';
        const cloneId = row['clone_id'] ? parseInt(row['clone_id'], 10) : null;
        const lineageId = row['lineage_id'] ? parseInt(row['lineage_id'], 10) : null;

        // Compute real SHM: count mismatches between sequence_alignment and germline_alignment
        let shmCount: number | null = null;
        const seqAlign = row['sequence_alignment'] || '';
        const germAlign = row['germline_alignment'] || '';
        if (seqAlign && germAlign && seqAlign.length === germAlign.length) {
          let mismatches = 0;
          for (let i = 0; i < seqAlign.length; i++) {
            const s = seqAlign[i], g = germAlign[i];
            if (s !== '.' && s !== 'N' && g !== '.' && g !== 'N' && s !== g) {
              mismatches++;
            }
          }
          shmCount = mismatches;
        }

        cloneData[seqId] = {
          clone_id: isNaN(cloneId as number) ? null : cloneId,
          clone_count: cloneId != null ? (cloneCounts[cloneId] ?? 0) : 0,
          productive: true,
          cdr3_dna: row['junction'] || null,
          cdr3_peptide: row['junction_aa'] || null,
          dna_sequence: row['sequence'] || null,
          c_call: row['c_call']?.trim() || null,
          somatic_mutations: shmCount,
          ...(lineageId != null && !isNaN(lineageId) ? { lineage_id: lineageId } : {})
        };
      }
    }

    // 4b. Supplement clone_id + c_call from the merged clone-pass file.
    // CreateGermlines drops most heavy chain sequences (D-gene alignment issue),
    // but clone-pass retains them with clone_id. This is critical for isotype data.
    const mergedClonePassPath = path.join(absOutputDir, 'ig_out_data_db-pass_clone-pass.tsv');
    if (fs.existsSync(mergedClonePassPath)) {
      const cpContent = fs.readFileSync(mergedClonePassPath, 'utf-8');
      const { rows: cpRows } = parseTsv(cpContent);
      const cpCloneCounts: Record<number, number> = {};
      for (const row of cpRows) {
        const cid = row['clone_id'] ? parseInt(row['clone_id'], 10) : NaN;
        if (!isNaN(cid)) cpCloneCounts[cid] = (cpCloneCounts[cid] ?? 0) + 1;
      }
      for (const row of cpRows) {
        const seqId = row['sequence_id'] ?? '';
        if (!seqId) continue;
        const cCall = row['c_call']?.trim() || null;
        const cloneId = row['clone_id'] ? parseInt(row['clone_id'], 10) : null;
        const validCloneId = cloneId != null && !isNaN(cloneId) ? cloneId : null;
        if (cloneData[seqId]) {
          if (!cloneData[seqId].c_call && cCall) cloneData[seqId].c_call = cCall;
          if (cloneData[seqId].clone_id == null && validCloneId != null) {
            cloneData[seqId].clone_id = validCloneId;
            cloneData[seqId].clone_count = cpCloneCounts[validCloneId] ?? 0;
            cloneData[seqId].productive = true;
          }
          if (!cloneData[seqId].cdr3_dna && row['junction']) cloneData[seqId].cdr3_dna = row['junction'];
          if (!cloneData[seqId].cdr3_peptide && row['junction_aa']) cloneData[seqId].cdr3_peptide = row['junction_aa'];
        } else if (cCall || validCloneId != null) {
          cloneData[seqId] = {
            clone_id: validCloneId,
            clone_count: validCloneId != null ? (cpCloneCounts[validCloneId] ?? 0) : 0,
            productive: true,
            cdr3_dna: row['junction'] || null,
            cdr3_peptide: row['junction_aa'] || null,
            ...(cCall ? { c_call: cCall } : {}),
          };
        }
      }
    }

    // 5. Load fail file if present
    const failPath = path.join(absOutputDir, 'ig_out_data_db-fail.tsv');
    if (fs.existsSync(failPath)) {
      const failContent = fs.readFileSync(failPath, 'utf-8');
      const { rows: failRows } = parseTsv(failContent);
      for (const row of failRows) {
        const seqId = row['sequence_id'] ?? '';
        cloneData[seqId] = {
          clone_id: null,
          clone_count: 0,
          productive: false,
          cdr3_dna: row['junction'] || null,
          cdr3_peptide: row['junction_aa'] || null
        };
      }
    }

    // 6. Build sequences
    const sequences: SequenceRecord[] = [];
    for (const queryId of sequenceNames) {
      if (!queryId) continue;
      let blast = blastByQuery[queryId] ?? blastByQuery[`reversed|${queryId}`];
      if (!blast && queryId.startsWith('reversed|')) {
        blast = blastByQuery[queryId.replace('reversed|', '')];
      }
      if (!blast) continue;

      const seq: SequenceRecord = {
        id: queryId,
        name: queryId,
        v_gene: null,
        d_gene: null,
        j_gene: null,
        v_locus: null,
        d_locus: null,
        j_locus: null,
        cdr3_dna: null,
        cdr3_peptide: null,
        somatic_mutations: null,
        isotype: null,
        c_call: null
      };

      const vRow = blast['V'];
      if (vRow) {
        seq.v_gene = vRow.subjectId || null;
        if (seq.v_gene) {
          const g = seq.v_gene;
          if (g.includes('*')) {
            const idx = g.indexOf('*');
            if (g.length > 4) seq.v_locus = g[3] + g[2] + g.slice(4, idx);
          }
          if (g.includes('L')) seq.isotype = 'Lambda';
          else if (g.includes('K')) seq.isotype = 'Kappa';
          else seq.isotype = 'Heavy';
        }
      }
      const dRow = blast['D'];
      if (dRow && dRow.subjectId) {
        seq.d_gene = dRow.subjectId;
        if (seq.d_gene.includes('*')) {
          const idx = seq.d_gene.indexOf('*');
          if (seq.d_gene.length > 4) seq.d_locus = seq.d_gene[3] + seq.d_gene[2] + seq.d_gene.slice(4, idx);
        }
      }
      const jRow = blast['J'];
      if (jRow && jRow.subjectId) {
        seq.j_gene = jRow.subjectId;
        if (seq.j_gene.includes('*')) {
          const idx = seq.j_gene.indexOf('*');
          if (seq.j_gene.length > 4) seq.j_locus = seq.j_gene[3] + seq.j_gene[2] + seq.j_gene.slice(4, idx);
        }
      }
      // somatic_mutations is computed from sequence_alignment vs germline_alignment
      // in the cloneData (step 4 above), not from CDR3 alignment length

      if (cloneData[queryId]) {
        Object.assign(seq, cloneData[queryId]);
      }
      sequences.push(seq);
    }

    // 7. Build file_groups
    const fileGroups: Record<string, SequenceRecord[]> = {};
    for (const seq of sequences) {
      const fn = resolveFilename(seq.id);
      if (!fileGroups[fn]) fileGroups[fn] = [];
      fileGroups[fn].push(seq);
    }

    callbacks.onProgress({ stage: 'results', percent: 95, message: 'Sending results...' });

    // 8. Emit sequences - use absOutputDir to guarantee we're loading from the requested path
    callbacks.onResult({
      artifact: 'sequences',
      data: {
        sequences,
        file_groups: fileGroups,
        total_count: sequences.length,
        output_dir: absOutputDir,
        file_id_mapping: fileIdMapping,
        fasta_dir: ''
      }
    });

    // 9. Emit tree images - supports both flat trees/ and per-timepoint trees/T1/ structures
    const treesDir = path.join(absOutputDir, 'trees');
    if (fs.existsSync(treesDir)) {
      let cloneSizes: Record<number, number> = {};
      if (fs.existsSync(clonePassPath)) {
        const tsv = fs.readFileSync(clonePassPath, 'utf-8');
        const { rows } = parseTsv(tsv);
        for (const row of rows) {
          const cid = row['clone_id'] ? parseInt(row['clone_id'], 10) : NaN;
          if (!isNaN(cid)) cloneSizes[cid] = (cloneSizes[cid] ?? 0) + 1;
        }
      }
      
      // Detect per-timepoint subdirectories
      const entries = fs.readdirSync(treesDir, { withFileTypes: true });
      const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
      const hasSubdirs = subdirs.some(d => {
        const subPath = path.join(treesDir, d);
        return fs.readdirSync(subPath).some(f => f.endsWith('.newick'));
      });
      
      const allTreeImages: string[] = [];
      const allTreeMetadata: { path: string; clone_id: number | null; clone_size: number; timepoint?: string }[] = [];
      
      function collectTrees(dir: string, timepoint?: string) {
        const pngs = fs.readdirSync(dir).filter(f => f.endsWith('.png'));
        const newicks = new Set(
          fs.readdirSync(dir).filter(f => f.endsWith('.newick')).map(f => f.replace('.newick', ''))
        );
        const images = pngs
          .filter(f => newicks.has(f.replace('.png', '')))
          .map(f => path.resolve(path.join(dir, f)));
        
        for (const imgPath of images) {
          const match = path.basename(imgPath).replace('tree_', '').replace('.png', '');
          const cid = parseInt(match, 10);
          allTreeImages.push(imgPath);
          allTreeMetadata.push({
            path: imgPath,
            clone_id: isNaN(cid) ? null : cid,
            clone_size: isNaN(cid) ? 0 : (cloneSizes[cid] ?? 0),
            ...(timepoint ? { timepoint } : {})
          });
        }
      }
      
      if (hasSubdirs) {
        for (const subdir of subdirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
          collectTrees(path.join(treesDir, subdir), subdir);
        }
      } else {
        collectTrees(treesDir);
      }
      
      // Sort by timepoint then clone size
      allTreeMetadata.sort((a, b) => {
        const tpCmp = (a.timepoint || '').localeCompare(b.timepoint || '', undefined, { numeric: true });
        if (tpCmp !== 0) return tpCmp;
        return (b.clone_size) - (a.clone_size);
      });
      
      const sortedImages = allTreeMetadata.map(m => m.path);
      
      callbacks.onResult({
        artifact: 'tree_images',
        data: { images: sortedImages, tree_metadata: allTreeMetadata }
      });
    } else {
      callbacks.onResult({
        artifact: 'tree_images',
        data: { images: [], tree_metadata: [] }
      });
    }

    // 10. Load study design if present
    const studyDesignPath = path.join(absOutputDir, 'study_design.json');
    if (fs.existsSync(studyDesignPath)) {
      try {
        const designContent = fs.readFileSync(studyDesignPath, 'utf-8');
        const studyDesign = JSON.parse(designContent);
        if (studyDesign && typeof studyDesign === 'object') {
          callbacks.onResult({
            artifact: 'study_design',
            data: studyDesign
          });
        }
      } catch (e) {
        console.warn('[ResultsLoader] Could not load study_design.json:', e);
      }
    }

    // 11. Load timepoint_mapping if present
    const tpMappingPath = path.join(absOutputDir, 'timepoint_mapping.json');
    if (fs.existsSync(tpMappingPath)) {
      try {
        const tpContent = fs.readFileSync(tpMappingPath, 'utf-8');
        const tpMapping = JSON.parse(tpContent);
        if (tpMapping && typeof tpMapping === 'object') {
          callbacks.onResult({
            artifact: 'timepoint_mapping',
            data: tpMapping
          });
          console.log('[ResultsLoader] Loaded timepoint_mapping.json');
        }
      } catch (e) {
        console.warn('[ResultsLoader] Could not load timepoint_mapping.json:', e);
      }
    }

    // 12. Load COVID matching results if present (both top_n and public_clones variants)
    for (const fname of ['covid_matches.json', 'covid_matches_public.json']) {
      const covidMatchPath = path.join(absOutputDir, fname);
      if (fs.existsSync(covidMatchPath)) {
        try {
          const covidContent = fs.readFileSync(covidMatchPath, 'utf-8');
          const covidData = JSON.parse(covidContent);
          if (covidData && covidData.top_clones) {
            // Ensure mode is set so the frontend can route the result
            if (!covidData.mode) {
              covidData.mode = fname === 'covid_matches_public.json' ? 'public_clones' : 'top_n';
            }
            callbacks.onResult({
              artifact: 'covid_matches',
              data: covidData
            });
            console.log(`[ResultsLoader] Loaded ${fname} (mode=${covidData.mode})`);
          }
        } catch (e) {
          console.warn(`[ResultsLoader] Could not load ${fname}:`, e);
        }
      }
    }

    callbacks.onProgress({ stage: 'complete', percent: 100, message: 'Load complete' });
    callbacks.onLog({ level: 'info', message: `Loaded ${sequences.length} sequences from ${absOutputDir}` });
    callbacks.onComplete({ success: true });
  } catch (err: any) {
    console.error('[ResultsLoader] Error:', err);
    callbacks.onLog({ level: 'error', message: String(err?.message ?? err) });
    callbacks.onComplete({ success: false, error: String(err?.message ?? err) });
  }
}
