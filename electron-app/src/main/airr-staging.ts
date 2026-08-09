/**
 * AIRR + SampleTag → per-cohort staging directory.
 *
 * The existing pipeline (and downstream Svelte UI) consumes one staging
 * folder per cohort, each containing per-patient FASTAs and a
 * timepoint_mapping.json. This module produces that same shape from BD
 * Rhapsody output: a combined AIRR-format TSV (one row per VDJ contig) +
 * a Sample_Tag_Calls.csv (per-cell sample-tag assignments) + a user-
 * provided tag→treatment legend.
 *
 * Flow:
 *   1. Read the SampleTag CSV → cell_id → SampleTag map
 *   2. Stream the (optionally gzipped) AIRR TSV row-by-row, filter to
 *      productive B-cell contigs (IGH/IGK/IGL), drop cells with no real
 *      SampleTag (Multiplet/Undetermined) or unassigned by the user
 *   3. Group rows by (cohort, mouse) and write one FASTA per mouse into
 *      that cohort's staging directory
 *   4. Write timepoint_mapping.json next to each cohort's FASTAs so the
 *      pipeline knows which file maps to which timepoint/patient
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as zlib from 'zlib';

export interface AirrSampleTagAssignment {
  sampleTag: string;      // e.g. "SampleTag04_mm"
  group: string;          // user-assigned cohort name, e.g. "CTLA-4"
  mouseLabel: string;     // per-mouse label inside the cohort, e.g. "Mouse1"
  timepoint: string;      // optional single timepoint label; defaults to "endpoint"
}

export interface StageFromAirrInput {
  airrTsvPath: string;
  sampleTagCsvPath: string;
  tagAssignments: AirrSampleTagAssignment[];
  studyName: string;
  /** Base directory under which to create one staging dir per cohort. */
  outsDir: string;
}

export interface StageFromAirrResult {
  success: boolean;
  error?: string;
  cohorts?: {
    name: string;
    stagingDir: string;
    timepointMapping: Record<string, { timepoint: string; originalFile: string }>;
  }[];
  summary?: {
    rowsScanned: number;
    bCellRowsKept: number;
    cellsAssigned: number;
    cellsDroppedMultipletUndetermined: number;
    cellsDroppedUnassigned: number;
    cohortCellCounts: Record<string, number>;
  };
}

/** Parse the SampleTag_Calls.csv produced by BD Rhapsody. Skips '#' headers. */
async function loadSampleTagMap(csvPath: string): Promise<Map<string, string>> {
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  });

  const map = new Map<string, string>();
  let headerSeen = false;
  let cellIdxIdx = -1;
  let tagIdx = -1;

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) continue;
    const cols = line.split(',');
    if (!headerSeen) {
      cellIdxIdx = cols.findIndex(c => c.trim() === 'Cell_Index');
      tagIdx = cols.findIndex(c => c.trim() === 'Sample_Tag');
      if (cellIdxIdx < 0 || tagIdx < 0) {
        throw new Error(`Sample_Tag_Calls.csv missing required columns (Cell_Index, Sample_Tag): saw ${cols.join(', ')}`);
      }
      headerSeen = true;
      continue;
    }
    const cellId = cols[cellIdxIdx]?.trim();
    const tag = cols[tagIdx]?.trim();
    if (cellId && tag) map.set(cellId, tag);
  }

  return map;
}

/**
 * Open an AIRR TSV (gzipped or plain) as an async-iterable of lines.
 */
function openAirr(airrTsvPath: string): readline.Interface {
  const ext = path.extname(airrTsvPath).toLowerCase();
  const raw = fs.createReadStream(airrTsvPath);
  const input = ext === '.gz' ? raw.pipe(zlib.createGunzip()) : raw;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

/** Filesystem-safe slug. */
function slug(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

export async function stageFromAirr(input: StageFromAirrInput): Promise<StageFromAirrResult> {
  const {
    airrTsvPath,
    sampleTagCsvPath,
    tagAssignments,
    studyName,
    outsDir
  } = input;

  if (!fs.existsSync(airrTsvPath))
    return { success: false, error: `AIRR TSV not found: ${airrTsvPath}` };
  if (!fs.existsSync(sampleTagCsvPath))
    return { success: false, error: `Sample_Tag_Calls.csv not found: ${sampleTagCsvPath}` };
  if (!tagAssignments || tagAssignments.length === 0)
    return { success: false, error: 'No sample-tag → cohort assignments were provided.' };

  // Map of cell_id → SampleTag (e.g. "SampleTag04_mm")
  const cellToTag = await loadSampleTagMap(sampleTagCsvPath);

  // Map SampleTag → user-provided assignment
  const tagToAssignment = new Map<string, AirrSampleTagAssignment>();
  for (const a of tagAssignments) {
    if (a.sampleTag && a.group?.trim()) {
      tagToAssignment.set(a.sampleTag, {
        ...a,
        timepoint: a.timepoint?.trim() || 'endpoint'
      });
    }
  }

  // Build a base staging dir under outsDir (parent of all per-cohort dirs)
  if (!fs.existsSync(outsDir)) fs.mkdirSync(outsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const uniqueId = Math.random().toString(36).slice(2, 6);
  const baseStaging = path.join(outsDir, `airr_staging_${timestamp}_${uniqueId}`);
  fs.mkdirSync(baseStaging, { recursive: true });

  // Per-cohort working state: cohortName → { stagingDir, openMouseStreams, timepointMapping, cellCount }
  type CohortState = {
    name: string;
    stagingDir: string;
    streams: Map<string, fs.WriteStream>;   // mouseLabel → FASTA write stream
    timepointMapping: Record<string, { timepoint: string; originalFile: string }>;
    cellCount: number;
    cellsSeen: Set<string>;
  };
  const cohorts = new Map<string, CohortState>();

  function getOrCreateCohort(name: string): CohortState {
    let c = cohorts.get(name);
    if (c) return c;
    const cohortDir = path.join(baseStaging, slug(name));
    fs.mkdirSync(cohortDir, { recursive: true });
    fs.writeFileSync(path.join(cohortDir, 'study_name.txt'), studyName, 'utf-8');
    c = {
      name,
      stagingDir: cohortDir,
      streams: new Map(),
      timepointMapping: {},
      cellCount: 0,
      cellsSeen: new Set()
    };
    cohorts.set(name, c);
    return c;
  }

  function getOrCreateMouseStream(cohort: CohortState, mouseLabel: string, timepoint: string): { stream: fs.WriteStream; stagedName: string } {
    const key = `${mouseLabel}|${timepoint}`;
    let stream = cohort.streams.get(key);
    if (stream) {
      // Find the previously registered staged filename
      const existing = Object.entries(cohort.timepointMapping).find(([, v]) => v.originalFile === `${mouseLabel}_filtered.fasta` && v.timepoint === timepoint);
      return { stream, stagedName: existing![0] };
    }
    const originalFile = `${mouseLabel}_filtered.fasta`;
    const stagedName = `${timepoint}_${originalFile}`;
    const filePath = path.join(cohort.stagingDir, stagedName);
    stream = fs.createWriteStream(filePath, { encoding: 'utf-8' });
    cohort.streams.set(key, stream);
    cohort.timepointMapping[stagedName] = { timepoint, originalFile };
    return { stream, stagedName };
  }

  // Stream the AIRR TSV
  const rl = openAirr(airrTsvPath);
  let header: string[] | null = null;
  let idx = {
    cell_id: -1,
    cell_type: -1,
    locus: -1,
    productive: -1,
    sequence_id: -1,
    sequence: -1
  };

  const summary = {
    rowsScanned: 0,
    bCellRowsKept: 0,
    cellsAssigned: 0,
    cellsDroppedMultipletUndetermined: 0,
    cellsDroppedUnassigned: 0,
    cohortCellCounts: {} as Record<string, number>
  };

  for await (const line of rl) {
    if (!line) continue;
    if (header === null) {
      header = line.split('\t');
      idx.cell_id = header.indexOf('cell_id');
      idx.cell_type = header.indexOf('cell_type_experimental');
      idx.locus = header.indexOf('locus');
      idx.productive = header.indexOf('productive');
      idx.sequence_id = header.indexOf('sequence_id');
      idx.sequence = header.indexOf('sequence');
      const missing = Object.entries(idx).filter(([, v]) => v < 0).map(([k]) => k);
      if (missing.length > 0) {
        return { success: false, error: `AIRR TSV missing columns: ${missing.join(', ')}` };
      }
      continue;
    }

    summary.rowsScanned++;
    const cols = line.split('\t');
    if (cols.length < header.length) continue;

    // B cells only, productive only, IGH/IGK/IGL only.
    // The 'productive' field is boolean but its on-wire encoding varies
    // across BD pipeline versions (TRUE / True / true / T / 1). Normalise.
    if (cols[idx.cell_type] !== 'B') continue;
    const locus = cols[idx.locus];
    if (locus !== 'IGH' && locus !== 'IGK' && locus !== 'IGL') continue;
    const prod = (cols[idx.productive] || '').trim().toLowerCase();
    if (prod !== 'true' && prod !== 't' && prod !== '1') continue;

    const cellId = cols[idx.cell_id];
    const tag = cellToTag.get(cellId);
    if (!tag) continue;
    if (tag === 'Multiplet' || tag === 'Undetermined') {
      // Counted at cell level (not row level); ignore quietly here
      continue;
    }

    const assignment = tagToAssignment.get(tag);
    if (!assignment) {
      continue;
    }

    const cohort = getOrCreateCohort(assignment.group);
    const { stream } = getOrCreateMouseStream(cohort, assignment.mouseLabel || 'Mouse1', assignment.timepoint || 'endpoint');

    const seqId = cols[idx.sequence_id] || `${cellId}_${locus}`;
    const sequence = cols[idx.sequence] || '';
    if (!sequence) continue;
    stream.write(`>${seqId}\n${sequence}\n`);

    summary.bCellRowsKept++;
    if (!cohort.cellsSeen.has(cellId)) {
      cohort.cellsSeen.add(cellId);
      cohort.cellCount++;
      summary.cellsAssigned++;
    }
  }

  // Close all open streams
  for (const c of cohorts.values()) {
    for (const s of c.streams.values()) s.end();
  }
  await new Promise(resolve => setTimeout(resolve, 100)); // allow flushes

  // Count multiplets / unassigned (cell-level) from the SampleTag map
  for (const tag of cellToTag.values()) {
    if (tag === 'Multiplet' || tag === 'Undetermined') summary.cellsDroppedMultipletUndetermined++;
    else if (tag.startsWith('SampleTag') && !tagToAssignment.has(tag)) summary.cellsDroppedUnassigned++;
  }

  // Persist per-cohort timepoint_mapping.json
  for (const c of cohorts.values()) {
    fs.writeFileSync(
      path.join(c.stagingDir, 'timepoint_mapping.json'),
      JSON.stringify(c.timepointMapping, null, 2),
      'utf-8'
    );
    summary.cohortCellCounts[c.name] = c.cellCount;
  }

  return {
    success: true,
    cohorts: Array.from(cohorts.values()).map(c => ({
      name: c.name,
      stagingDir: c.stagingDir,
      timepointMapping: c.timepointMapping
    })),
    summary
  };
}
