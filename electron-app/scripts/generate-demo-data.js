#!/usr/bin/env node
/**
 * Generate demo-data.json from a completed analysis run directory.
 *
 * Usage:
 *   node scripts/generate-demo-data.js /path/to/run_dir
 *   node scripts/generate-demo-data.js  # uses default run dir
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_RUN_DIR = path.resolve(__dirname, '../../geneGUI/outs/run_2026-02-25T05-59-39_lqjm');
const runDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_RUN_DIR;
const OUTPUT_PATH = path.resolve(__dirname, '../src/renderer/public/demo-data.json');

console.log('Generating demo data from:', runDir);

// --- Parsing helpers (mirrors results-loader.ts) ---

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; }
    else if ((c === ',' && !inQuotes) || c === '\n' || c === '\r') {
      result.push(current.trim());
      current = '';
      if (c !== ',') break;
    } else { current += c; }
  }
  if (current.length > 0) result.push(current.trim());
  return result;
}

function parseTsvLine(line) {
  return line.split('\t').map(s => s.trim());
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(l => parseCsvLine(l)).filter(r => r.some(c => c.length > 0));
  return { headers, rows };
}

function parseTsv(content) {
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseTsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseTsvLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function getSeqIdSuffix(seqId) {
  const lastUnderscore = seqId.lastIndexOf('_');
  if (lastUnderscore >= 0) {
    const suffix = seqId.slice(lastUnderscore + 1);
    if (/^\d+$/.test(suffix)) return suffix;
  }
  if (seqId.includes('|||')) return seqId.split('|||').pop() ?? null;
  return null;
}

// --- Load data ---

// 1. combined.fasta - sequence IDs
const fastaContent = fs.readFileSync(path.join(runDir, 'combined.fasta'), 'utf-8');
const sequenceNames = [];
for (const line of fastaContent.split(/\r?\n/)) {
  if (line.startsWith('>')) {
    const id = line.slice(1).trim().split(/\s/)[0];
    if (id) sequenceNames.push(id);
  }
}
console.log(`Found ${sequenceNames.length} sequences in combined.fasta`);

// 2. file_id_mapping
const fileIdMapping = JSON.parse(fs.readFileSync(path.join(runDir, 'file_id_mapping.json'), 'utf-8'));
function resolveFilename(seqId) {
  const suffix = getSeqIdSuffix(seqId);
  if (suffix && fileIdMapping[suffix]) return fileIdMapping[suffix];
  if (seqId.includes('|||')) return seqId.split('|||').pop() ?? 'unknown.fasta';
  return 'unknown.fasta';
}

// 3. outdata.csv
const csvContent = fs.readFileSync(path.join(runDir, 'outdata.csv'), 'utf-8');
const { headers: csvHeaders, rows: csvRows } = parseCsv(csvContent);
const queryIdIdx = csvHeaders.indexOf('query id');
const chainTypeIdx = csvHeaders.indexOf('chain type');
const subjectIdIdx = csvHeaders.indexOf('subject id');
const alignLenIdx = csvHeaders.indexOf('alignment length');

const blastByQuery = {};
for (const row of csvRows) {
  const qid = row[queryIdIdx] ?? '';
  const chain = row[chainTypeIdx] ?? '';
  const subj = row[subjectIdIdx] ?? '';
  const alen = row[alignLenIdx] ?? '';
  if (!blastByQuery[qid]) blastByQuery[qid] = {};
  blastByQuery[qid][chain] = { subjectId: subj, alignmentLength: alen };
}

// 4. Clone data from germ-pass
const clonePassPath = path.join(runDir, 'ig_out_data_db-pass_clone-pass_germ-pass.tsv');
const cloneData = {};
if (fs.existsSync(clonePassPath)) {
  const tsvContent = fs.readFileSync(clonePassPath, 'utf-8');
  const { rows: cloneRows } = parseTsv(tsvContent);
  const cloneCounts = {};
  for (const row of cloneRows) {
    const cid = row['clone_id'] ? parseInt(row['clone_id'], 10) : NaN;
    if (!isNaN(cid)) cloneCounts[cid] = (cloneCounts[cid] ?? 0) + 1;
  }
  for (const row of cloneRows) {
    const seqId = row['sequence_id'] ?? '';
    const cloneId = row['clone_id'] ? parseInt(row['clone_id'], 10) : null;
    const lineageId = row['lineage_id'] ? parseInt(row['lineage_id'], 10) : null;
    cloneData[seqId] = {
      clone_id: isNaN(cloneId) ? null : cloneId,
      clone_count: cloneId != null ? (cloneCounts[cloneId] ?? 0) : 0,
      productive: true,
      cdr3_dna: row['junction'] || null,
      cdr3_peptide: row['junction_aa'] || null,
      dna_sequence: row['sequence'] || null,
      c_call: (row['c_call'] || '').trim() || null,
      ...(lineageId != null && !isNaN(lineageId) ? { lineage_id: lineageId } : {})
    };
  }
}

// 4b. Supplement from clone-pass
const mergedClonePassPath = path.join(runDir, 'ig_out_data_db-pass_clone-pass.tsv');
if (fs.existsSync(mergedClonePassPath)) {
  const cpContent = fs.readFileSync(mergedClonePassPath, 'utf-8');
  const { rows: cpRows } = parseTsv(cpContent);
  const cpCloneCounts = {};
  for (const row of cpRows) {
    const cid = row['clone_id'] ? parseInt(row['clone_id'], 10) : NaN;
    if (!isNaN(cid)) cpCloneCounts[cid] = (cpCloneCounts[cid] ?? 0) + 1;
  }
  for (const row of cpRows) {
    const seqId = row['sequence_id'] ?? '';
    if (!seqId) continue;
    const cCall = (row['c_call'] || '').trim() || null;
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
        ...(cCall ? { c_call: cCall } : {})
      };
    }
  }
}

// 5. Fail file
const failPath = path.join(runDir, 'ig_out_data_db-fail.tsv');
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
const sequences = [];
for (const queryId of sequenceNames) {
  if (!queryId) continue;
  let blast = blastByQuery[queryId] ?? blastByQuery[`reversed|${queryId}`];
  if (!blast && queryId.startsWith('reversed|')) {
    blast = blastByQuery[queryId.replace('reversed|', '')];
  }
  if (!blast) continue;

  const seq = {
    id: queryId,
    name: queryId,
    v_gene: null, d_gene: null, j_gene: null,
    v_locus: null, d_locus: null, j_locus: null,
    cdr3_dna: null, cdr3_peptide: null,
    somatic_mutations: null, isotype: null, c_call: null
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
  const cdr3Row = blast['CDR3'];
  if (cdr3Row && cdr3Row.alignmentLength) {
    seq.somatic_mutations = parseInt(cdr3Row.alignmentLength, 10) || null;
  }

  if (cloneData[queryId]) {
    Object.assign(seq, cloneData[queryId]);
  }
  sequences.push(seq);
}

// 7. Build file_groups
const fileGroups = {};
for (const seq of sequences) {
  const fn = resolveFilename(seq.id);
  if (!fileGroups[fn]) fileGroups[fn] = [];
  fileGroups[fn].push(seq);
}

console.log(`Built ${sequences.length} sequences in ${Object.keys(fileGroups).length} file groups`);

// 8. Collect Newick tree data
const treesDir = path.join(runDir, 'trees');
const newickData = {};
const treeMetadata = [];

if (fs.existsSync(treesDir)) {
  // Compute clone sizes for metadata
  let cloneSizes = {};
  if (fs.existsSync(clonePassPath)) {
    const tsv = fs.readFileSync(clonePassPath, 'utf-8');
    const { rows } = parseTsv(tsv);
    for (const row of rows) {
      const cid = row['clone_id'] ? parseInt(row['clone_id'], 10) : NaN;
      if (!isNaN(cid)) cloneSizes[cid] = (cloneSizes[cid] ?? 0) + 1;
    }
  }

  const entries = fs.readdirSync(treesDir, { withFileTypes: true });
  const subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  function collectTrees(dir, timepoint) {
    const files = fs.readdirSync(dir);
    const newicks = files.filter(f => f.endsWith('.newick'));
    for (const nf of newicks) {
      const newickContent = fs.readFileSync(path.join(dir, nf), 'utf-8').trim();
      const baseName = nf.replace('.newick', '');
      const key = timepoint ? `${timepoint}/${baseName}` : baseName;
      newickData[key] = newickContent;

      const match = baseName.replace('tree_', '');
      const cid = parseInt(match, 10);
      treeMetadata.push({
        key,
        clone_id: isNaN(cid) ? null : cid,
        clone_size: isNaN(cid) ? 0 : (cloneSizes[cid] ?? 0),
        ...(timepoint ? { timepoint } : {})
      });
    }
  }

  if (subdirs.length > 0 && subdirs.some(d => fs.readdirSync(path.join(treesDir, d)).some(f => f.endsWith('.newick')))) {
    for (const subdir of subdirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      collectTrees(path.join(treesDir, subdir), subdir);
    }
  } else {
    collectTrees(treesDir);
  }

  // Sort by timepoint then clone size
  treeMetadata.sort((a, b) => {
    const tpCmp = (a.timepoint || '').localeCompare(b.timepoint || '', undefined, { numeric: true });
    if (tpCmp !== 0) return tpCmp;
    return b.clone_size - a.clone_size;
  });
}

console.log(`Collected ${Object.keys(newickData).length} Newick trees`);

// 9. Load metadata JSON files
const timepointMappingPath = path.join(runDir, 'timepoint_mapping.json');
const timepointMapping = fs.existsSync(timepointMappingPath)
  ? JSON.parse(fs.readFileSync(timepointMappingPath, 'utf-8'))
  : {};

const studyDesignPath = path.join(runDir, 'study_design.json');
const studyDesign = fs.existsSync(studyDesignPath)
  ? JSON.parse(fs.readFileSync(studyDesignPath, 'utf-8'))
  : null;

const crossTimepointPath = path.join(runDir, 'cross_timepoint_lineages.json');
const crossTimepointLineages = fs.existsSync(crossTimepointPath)
  ? JSON.parse(fs.readFileSync(crossTimepointPath, 'utf-8'))
  : null;

// 10. Build output
const demoData = {
  sequences,
  file_groups: fileGroups,
  file_id_mapping: fileIdMapping,
  timepoint_mapping: timepointMapping,
  study_design: studyDesign,
  cross_timepoint_lineages: crossTimepointLineages,
  newick_trees: newickData,
  tree_metadata: treeMetadata,
  output_dir: '/demo'
};

// Strip dna_sequence to save space (not displayed in UI)
for (const seq of demoData.sequences) {
  delete seq.dna_sequence;
  delete seq.aa_sequence;
}
for (const key of Object.keys(demoData.file_groups)) {
  for (const seq of demoData.file_groups[key]) {
    delete seq.dna_sequence;
    delete seq.aa_sequence;
  }
}

const json = JSON.stringify(demoData);
fs.writeFileSync(OUTPUT_PATH, json);
const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
console.log(`\nWrote ${OUTPUT_PATH} (${sizeMB} MB)`);
console.log('Done!');
