/**
 * Application State Stores
 * 
 * Svelte stores for managing application state
 */

import { writable, derived, get, type Writable, type Readable } from 'svelte/store';

// ============================================
// Types
// ============================================

export type AppView = 'wizard' | 'results';
export type WizardStep = 1 | 2 | 3;

export interface WizardTimepoint {
  id: string;
  label: string;
  fastaDir: string | null;
  fastaFiles: string[];
  annotationFiles: string[];
}

/**
 * CohortType, historically constrained to disease/control for the 2-cohort
 * Long-COVID study. Now free-form to support N treatment groups (e.g. 4 mouse
 * treatment groups: IgG/CTLA-4/LC/LCP).
 *
 * The literal values 'disease' and 'control' remain reserved for backwards
 * compatibility with saved sessions, and as the defaults when the user toggles
 * "Add control cohort" in 2-cohort mode.
 */
export type CohortType = string;

/** Reserved values still recognised as "the 2-cohort study defaults". */
export const COHORT_DEFAULT_DISEASE = 'disease';
export const COHORT_DEFAULT_CONTROL = 'control';

/** Input data format the wizard ingests at Step 1. */
export type InputFormat = 'fasta' | 'airr_tsv';

/** Species, drives reference-database selection in the pipeline. */
export type Species = 'human' | 'mouse' | 'custom';

export interface WizardCohort {
  id: string;
  name: string;
  type: CohortType;
  timepoints: WizardTimepoint[];
}

export interface WizardState {
  step: WizardStep;
  studyName: string;
  timepoints: WizardTimepoint[];
  /**
   * All cohorts (≥1). For single-cohort studies, this array still holds one
   * entry (kept in lockstep with `timepoints` for backwards compat). For N-cohort
   * studies (`hasControlCohort` true), there are 2..N entries.
   */
  cohorts: WizardCohort[];
  /**
   * True when the wizard is in multi-cohort mode. Name kept for backwards
   * compat, really means "more than one cohort", not literally "has a control".
   */
  hasControlCohort: boolean;
  cleanFasta: boolean;
  /** Species, defaults to 'human' to preserve existing behaviour. */
  species: Species;
  databaseType: 'IMGT' | 'Custom';
  customDatabaseV: string | null;
  customDatabaseD: string | null;
  customDatabaseJ: string | null;
  cloneMode: 'allele' | 'gene';
  linkageMethod: 'single' | 'average' | 'complete';
  runCovidMatching: boolean;
  covAbdabPath: string | null;
  /** Input format selected on Step 1. Defaults to 'fasta'. */
  inputFormat: InputFormat;
  /** Only used when inputFormat === 'airr_tsv'. */
  airrInput: AirrInputConfig | null;
}

/**
 * Configuration for BD Rhapsody (or equivalent) AIRR-TSV input.
 * Filled in on Step 1 when the user picks "AIRR TSV + Sample Tag CSV" mode.
 * The renderer hands this to a Node-side preprocessor that produces a staged
 * folder identical in structure to what the FASTA-mode flow produces, so
 * everything downstream is unchanged.
 */
export interface AirrInputConfig {
  /** Absolute path to the AIRR-format TSV (gzipped or not). */
  airrTsvPath: string;
  /** Absolute path to the BD Rhapsody Sample_Tag_Calls.csv. */
  sampleTagCsvPath: string;
  /**
   * One entry per SampleTag. The user fills the `group` and `mouseLabel` fields
   * after the wizard parses the SampleTag CSV's tag list. Multiplet and
   * Undetermined cells are always dropped during staging.
   */
  tagAssignments: SampleTagAssignment[];
}

export interface SampleTagAssignment {
  /** e.g. "SampleTag01_mm" */
  sampleTag: string;
  /** User-assigned cohort name, e.g. "IgG" or empty if not yet assigned. */
  group: string;
  /** Per-mouse label inside that cohort, e.g. "Mouse1". Optional. */
  mouseLabel: string;
  /** Optional single timepoint (for endpoint studies leave empty). */
  timepoint: string;
}

export interface AnalysisProgress {
  stage: string;
  percent: number;
  message: string;
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: Date;
}

export interface SequenceData {
  id: string;
  name: string;
  file?: string;
  v_gene: string | null;
  d_gene: string | null;
  j_gene: string | null;
  v_locus: string | null;
  d_locus: string | null;
  j_locus: string | null;
  cdr3_dna: string | null;
  cdr3_peptide: string | null;
  somatic_mutations: number | null;
  isotype: string | null;   // Chain type: Heavy, Kappa, Lambda
  c_call?: string | null;   // Constant region for Ig class: IGHM, IGHG1, IGHA1, etc.
  clone_id?: number;
  clone_count?: number;
  productive?: boolean;
  dna_sequence?: string | null;
  aa_sequence?: string | null;
  lineage_id?: number | null;  // Cross-timepoint lineage identifier
}

export interface FileGroup {
  filename: string;
  sequences: SequenceData[];
  cloneGroups: CloneGroup[];
  expanded: boolean;
}

export interface PublicCloneResult {
  id: string;
  cdr3_aa: string;
  cdr3_dna: string;
  v_gene: string;
  j_gene: string;
  sequence_count: number;
  patient_count: number;
  patients: string[];
  sequences: string[];
  /** Patient filename -> list of sequence IDs (for per-patient counts) */
  sequences_by_patient?: Record<string, string[]>;
  unique_cdr3_variants: number;
  avg_intra_cluster_similarity: number;
}

export interface VisualizationData {
  heatmap: {
    clones: string[];
    patients: string[];
    matrix: number[][];
    /** Normalized frequencies (% of patient repertoire) */
    frequencies: number[][];
    /** Raw sequence counts (for tooltips) */
    rawCounts?: number[][];
    /** Total sequences per patient (for normalization context) */
    patientTotals?: number[];
  };
  chord: {
    nodes: string[];
    links: Array<{source: string; target: string; value: number}>;
  };
  upset: {
    sets: Record<string, number>;
    intersections: Array<{sets: string[]; size: number}>;
  };
  network: {
    nodes: Array<{id: string; type: 'clone' | 'patient'; label: string}>;
    edges: Array<{source: string; target: string; count: number}>;
  };
}

export interface CovidMatchAlignment {
  query_aligned: string;
  reference_aligned: string;
  match_string: string;
  identity: number;
  matches: number;
  length: number;
}

export interface CovidMatchResult {
  antibody_name: string;
  identity: number;
  alignment: CovidMatchAlignment;
  db_info: {
    binds_to: string;
    neutralizes: string;
    v_gene: string;
    j_gene: string;
    origin: string;
    ab_or_nb: string;
  };
}

export interface CovidCloneData {
  clone_id: number;
  size: number;
  cdr3_aa: string;  // IMGT CDR3 format (trimmed)
  cdr3_aa_raw: string;  // Original AIRR Junction format
  vh_aa: string;  // Translated from DNA
  v_gene: string;
  j_gene: string;
  files: string[];
  vh_matches: CovidMatchResult[];
  cdr3_matches: CovidMatchResult[];
  has_high_vh_match: boolean;
  has_high_cdr3_match: boolean;
}

export interface CovidMatchData {
  top_clones: CovidCloneData[];
  stats: {
    total_clones_analyzed: number;
    clones_with_vh_matches: number;
    clones_with_cdr3_matches: number;
    clones_with_high_matches: number;
    database_size: number;
  };
}

export interface PublicClonesData {
  public_clones: PublicCloneResult[];
  top_x: PublicCloneResult[];
  stats: {
    total_public_clones: number;
    total_sequences_in_public_clones: number;
    max_patient_sharing: number;
    total_patients: number;
    clustering_mode: string;
    similarity_threshold: number;
    top_n_displayed: number;
  };
  method: string;
  visualizations: VisualizationData;
}

export interface TreeMetadata {
  path: string;
  clone_id: number | null;
  clone_size: number;
  timepoint?: string;  // e.g. "T1", "T2" - set when trees are built per timepoint
}

export interface TimepointMapping {
  [stagedFilename: string]: { timepoint: string; originalFile: string };
}

export interface CohortResults {
  cohortType: CohortType;
  cohortName: string;
  sequences: SequenceData[];
  fileGroups: FileGroup[];
  treeImages: string[];
  treeMetadata: TreeMetadata[];
  timepointMapping: TimepointMapping;
  outputDir: string;
  fileIdMapping: Record<string, string>;
  /** Covid matching results for the top-N expanded clones (default mode) */
  covidMatchData: CovidMatchData | null;
  /** Covid matching results for the union of public clones across timepoints */
  covidMatchDataPublic?: CovidMatchData | null;
  studyDesign?: StudyDesign;
}

export interface ResultsState {
  sequences: SequenceData[];
  fileGroups: FileGroup[];
  dlSequences: SequenceData[];
  dlFileGroups: FileGroup[];
  selectedSequenceId: string | null;
  selectedDlSequenceId: string | null;
  treeImages: string[];
  treeMetadata: TreeMetadata[];
  outputDir: string | null;
  /** Mapping of numeric file ID (e.g. "1001") to original filename */
  fileIdMapping: Record<string, string>;
  /** Mapping of staged filename to timepoint label + original file */
  timepointMapping: TimepointMapping;
  publicClonesData: PublicClonesData | null;
  isAnalyzingPublicClones: boolean;
  covidMatchData: CovidMatchData | null;
  /** Covid matching results run against the union of public clones */
  covidMatchDataPublic: CovidMatchData | null;
  isAnalyzingCovidMatching: boolean;
  /** Per-cohort results when control cohort is present */
  cohortResults: CohortResults[];
}

export interface AnalysisState {
  isRunning: boolean;
  isSessionLoad: boolean;  // True when loading a previous session (not a real pipeline run)
  pendingLoadOutputDir: string | null;  // When loading a session, the outputDir we expect; ignore results for other dirs
  progress: AnalysisProgress | null;
  logs: LogEntry[];
  error: string | null;
  thresholdRequest: number | { label: string; calculated: number }[] | null;
}

// ============================================
// Session History
// ============================================

export interface SessionCohortEntry {
  cohortType: CohortType;
  cohortName: string;
  outputDir: string;
}

export interface SessionEntry {
  id: string;
  name: string;
  outputDir: string;
  date: string;        // ISO 8601 timestamp
  fileCount: number;
  fastaDir: string;
  studyName?: string;
  studyDesign?: StudyDesign;
  cohorts?: SessionCohortEntry[];
  /**
   * Depth normalisation as it stood when the session was last viewed. Absent
   * on sessions saved before the feature existed, and absence reads as off, so
   * an old session restores to exactly the numbers it was saved with.
   */
  depthNormalization?: {
    enabled: boolean;
    depth: number;
    replicates: number;
    seed: number;
  };
}

/** Persist the depth-normalisation view setting for one session. */
export function saveDepthNormalization(
  outputDir: string,
  settings: SessionEntry['depthNormalization']
): void {
  const sessions = getSessions();
  const s = sessions.find(x => x.outputDir === outputDir);
  if (!s) return;
  s.depthNormalization = settings;
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

const SESSIONS_KEY = 'bcr_sessions';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function getSessions(): SessionEntry[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const sessions: SessionEntry[] = JSON.parse(raw);
    // Sort by date descending (most recent first)
    return sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch {
    return [];
  }
}

export function saveSession(entry: Omit<SessionEntry, 'id'>): SessionEntry {
  const sessions = getSessions();

  // If a session with the same outputDir already exists, update it in place
  const existingIndex = sessions.findIndex(s => s.outputDir === entry.outputDir);
  if (existingIndex >= 0) {
    const existing = sessions[existingIndex];
    const updated: SessionEntry = { ...existing, ...entry, id: existing.id };
    sessions.splice(existingIndex, 1); // remove old position
    sessions.unshift(updated);          // move to top (most recent)
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    return updated;
  }

  // Otherwise create a new session
  const newEntry: SessionEntry = {
    id: generateId(),
    ...entry
  };
  sessions.unshift(newEntry);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  return newEntry;
}

export function deleteSession(id: string): void {
  const sessions = getSessions().filter(s => s.id !== id);
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export function renameSession(id: string, newName: string): void {
  const sessions = getSessions();
  const session = sessions.find(s => s.id === id);
  if (session) {
    session.name = newName;
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }
}

/** Update the study design for a session matching the given outputDir. Called when user edits design. */
export function updateSessionStudyDesign(outputDir: string, design: StudyDesign): void {
  const sessions = getSessions();
  const session = sessions.find(s => s.outputDir === outputDir);
  if (session) {
    session.studyDesign = design;
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }
}


// ============================================
// Study Design (Data Organizer)
// ============================================

export interface StudyTimepoint {
  id: string;
  label: string;
  order: number;
  files: string[];
}

export interface StudyGroup {
  id: string;
  name: string;
  color: string;
  timepoints: StudyTimepoint[];
}

export interface StudyDesign {
  groups: StudyGroup[];
  unassigned: string[];
}

export const GROUP_COLORS = [
  '#0066CC', '#E85D04', '#2D9F3F', '#9B59B6',
  '#E74C3C', '#00ACC1', '#F39C12', '#7F8C8D'
];

export const studyDesign: Writable<StudyDesign> = writable({
  groups: [],
  unassigned: []
});

let _saveTimeout: ReturnType<typeof setTimeout> | null = null;

export async function saveStudyDesign(design: StudyDesign): Promise<void> {
  return saveStudyDesignImmediate(design);
}

/** Immediately flush study design to disk (no debounce). Used on component destroy. */
export async function saveStudyDesignImmediate(design: StudyDesign): Promise<void> {
  const outputDir = get(resultsState).outputDir;
  if (!outputDir) {
    console.warn('[StudyDesign] saveStudyDesignImmediate: no outputDir, skipping');
    return;
  }
  return saveStudyDesignToOutputDir(outputDir, design);
}

/** Save study design to a specific output dir. Use when switching sessions - pass the dir we're leaving. */
export async function saveStudyDesignToOutputDir(outputDir: string | null, design: StudyDesign): Promise<void> {
  if (_saveTimeout) clearTimeout(_saveTimeout);
  if (!outputDir) {
    console.warn('[StudyDesign] saveStudyDesignToOutputDir: no outputDir, skipping');
    return;
  }
  const filePath = outputDir + '/study_design.json';
  try {
    if (window.electronAPI) {
      const content = JSON.stringify(design, null, 2);
      console.log('[StudyDesign] Saving to', filePath, '- groups:', design.groups.length, 'unassigned:', design.unassigned?.length ?? 0);
      const result = await window.electronAPI.writeFile(filePath, content);
      if (result && !result.success) {
        console.error('[StudyDesign] writeFile FAILED:', result.error);
      } else {
        console.log('[StudyDesign] Saved OK to', filePath);
        updateSessionStudyDesign(outputDir, design);
      }
    }
  } catch (e) {
    console.error('[StudyDesign] Failed to save:', e);
  }
}

export async function loadStudyDesign(): Promise<StudyDesign | null> {
  try {
    const outputDir = get(resultsState).outputDir;
    if (!outputDir || !window.electronAPI) {
      console.log('[StudyDesign] loadStudyDesign: no outputDir or no electronAPI');
      return null;
    }
    const filePath = outputDir + '/study_design.json';
    console.log('[StudyDesign] Loading from', filePath);
    const result = await window.electronAPI.readFile(filePath);
    if (result.success && result.content) {
      const parsed = JSON.parse(result.content);
      console.log('[StudyDesign] Loaded OK:', parsed?.groups?.length ?? 0, 'groups');
      return parsed;
    } else {
      console.log('[StudyDesign] File not found or empty:', filePath, result);
    }
  } catch (e) {
    console.warn('[StudyDesign] Failed to load:', e);
  }
  return null;
}


// ============================================
// Stores
// ============================================

// Current view
export const currentView: Writable<AppView> = writable('wizard');

// Wizard state
export const wizardState: Writable<WizardState> = writable({
  step: 1,
  studyName: '',
  timepoints: [],
  cohorts: [],
  hasControlCohort: false,
  cleanFasta: false,
  species: 'human',
  databaseType: 'IMGT',
  customDatabaseV: null,
  customDatabaseD: null,
  customDatabaseJ: null,
  cloneMode: 'allele',
  linkageMethod: 'average',
  runCovidMatching: false,
  covAbdabPath: null,
  inputFormat: 'fasta',
  airrInput: null
});

// Analysis state
export const analysisState: Writable<AnalysisState> = writable({
  isRunning: false,
  isSessionLoad: false,
  pendingLoadOutputDir: null,
  progress: null,
  logs: [],
  error: null,
  thresholdRequest: null
});

// Results state
export const resultsState: Writable<ResultsState> = writable({
  sequences: [],
  fileGroups: [],
  dlSequences: [],
  dlFileGroups: [],
  selectedSequenceId: null,
  selectedDlSequenceId: null,
  treeImages: [],
  treeMetadata: [],
  outputDir: null,
  fileIdMapping: {},
  timepointMapping: {},
  publicClonesData: null,
  isAnalyzingPublicClones: false,
  covidMatchData: null,
  covidMatchDataPublic: null,
  isAnalyzingCovidMatching: false,
  cohortResults: []
});


// ============================================
// Derived Stores
// ============================================

// Can proceed to next wizard step
// Step 1: must have study name and either a valid FASTA selection or a valid
// AIRR-mode configuration (paths + at least one assigned group).
export const canProceedStep1: Readable<boolean> = derived(
  wizardState,
  ($state) => {
    if ($state.studyName.trim().length === 0) return false;

    // AIRR + SampleTag mode
    if ($state.inputFormat === 'airr_tsv') {
      const ai = $state.airrInput;
      if (!ai?.airrTsvPath || !ai?.sampleTagCsvPath) return false;
      if (!ai.tagAssignments?.length) return false;
      // Require at least one tag actually assigned to a group
      return ai.tagAssignments.some(a => a.group?.trim().length > 0);
    }

    // FASTA mode
    if ($state.hasControlCohort) {
      return $state.cohorts.length >= 2 &&
        $state.cohorts.every(c => c.timepoints.length > 0 && c.timepoints.every(tp => tp.fastaFiles.length > 0));
    }
    return $state.timepoints.length > 0 && $state.timepoints.every(tp => tp.fastaFiles.length > 0);
  }
);

export const canProceedStep2: Readable<boolean> = derived(
  wizardState,
  ($state) => {
    if ($state.databaseType === 'IMGT') return true;
    return (
      $state.customDatabaseV !== null &&
      $state.customDatabaseD !== null &&
      $state.customDatabaseJ !== null
    );
  }
);

// Selected sequence
export const selectedSequence: Readable<SequenceData | null> = derived(
  resultsState,
  ($state) => {
    if (!$state.selectedSequenceId) return null;
    const found = $state.sequences.find(s => s.id === $state.selectedSequenceId);
    if (found) return found;
    for (const cohort of $state.cohortResults) {
      const cohortFound = cohort.sequences.find(s => s.id === $state.selectedSequenceId);
      if (cohortFound) return cohortFound;
    }
    return null;
  }
);

// Selected DL sequence
export const selectedDlSequence: Readable<SequenceData | null> = derived(
  resultsState,
  ($state) => {
    if (!$state.selectedDlSequenceId) return null;
    return $state.dlSequences.find(s => s.id === $state.selectedDlSequenceId) || null;
  }
);

// Search filter for sequences
export const sequenceSearchQuery: Writable<string> = writable('');

// Helper function to sort sequences by clone size (largest first)
const sortSequencesByClone = (sequences: SequenceData[]): SequenceData[] => {
  return [...sequences].sort((a, b) => {
    // Sequences with clones come first
    const aHasClone = a.clone_id !== undefined && a.clone_id !== null && (a.clone_count ?? 0) > 0;
    const bHasClone = b.clone_id !== undefined && b.clone_id !== null && (b.clone_count ?? 0) > 0;
    
    // If one has a clone and the other doesn't, clone comes first
    if (aHasClone && !bHasClone) return -1;
    if (!aHasClone && bHasClone) return 1;
    
    // If both have clones, sort by clone_count (descending)
    if (aHasClone && bHasClone) {
      const aCount = a.clone_count ?? 0;
      const bCount = b.clone_count ?? 0;
      if (bCount !== aCount) {
        return bCount - aCount; // Descending order
      }
      // If same clone count, sort by clone_id for consistency
      return (a.clone_id ?? 0) - (b.clone_id ?? 0);
    }
    
    // If neither has a clone, maintain original order
    return 0;
  });
};

export const filteredFileGroups: Readable<FileGroup[]> = derived(
  [resultsState, sequenceSearchQuery],
  ([$results, $query]) => {
    const lowerQuery = $query.trim().toLowerCase();
    
    let groups = $results.fileGroups;
    
    // Apply search filter if query exists
    if (lowerQuery) {
      groups = groups
        .map(group => ({
          ...group,
          sequences: group.sequences.filter(seq =>
            seq.name.toLowerCase().includes(lowerQuery) ||
            seq.v_gene?.toLowerCase().includes(lowerQuery) ||
            seq.d_gene?.toLowerCase().includes(lowerQuery) ||
            seq.j_gene?.toLowerCase().includes(lowerQuery) ||
            seq.cdr3_peptide?.toLowerCase().includes(lowerQuery)
          )
        }))
        .filter(group => group.sequences.length > 0);
    }
    
    // Sort sequences within each group by clone size
    return groups.map(group => ({
      ...group,
      sequences: sortSequencesByClone(group.sequences)
    }));
  }
);

// Filtered DL file groups (same logic as traditional clustering)
export const filteredDlFileGroups: Readable<FileGroup[]> = derived(
  [resultsState, sequenceSearchQuery],
  ([$results, $query]) => {
    const lowerQuery = $query.trim().toLowerCase();
    
    let groups = $results.dlFileGroups;
    
    // Apply search filter if query exists
    if (lowerQuery) {
      groups = groups
        .map(group => ({
          ...group,
          sequences: group.sequences.filter(seq =>
            seq.name.toLowerCase().includes(lowerQuery) ||
            seq.v_gene?.toLowerCase().includes(lowerQuery) ||
            seq.d_gene?.toLowerCase().includes(lowerQuery) ||
            seq.j_gene?.toLowerCase().includes(lowerQuery) ||
            seq.cdr3_peptide?.toLowerCase().includes(lowerQuery)
          )
        }))
        .filter(group => group.sequences.length > 0);
    }
    
    // Sort sequences within each group by clone size
    return groups.map(group => ({
      ...group,
      sequences: sortSequencesByClone(group.sequences)
    }));
  }
);


// ============================================
// Actions
// ============================================

export function resetWizard(): void {
  wizardState.set({
    step: 1,
    studyName: '',
    timepoints: [],
    cohorts: [],
    hasControlCohort: false,
    cleanFasta: false,
    species: 'human',
    databaseType: 'IMGT',
    customDatabaseV: null,
    customDatabaseD: null,
    customDatabaseJ: null,
    cloneMode: 'allele',
    linkageMethod: 'average',
    runCovidMatching: false,
    covAbdabPath: null,
    inputFormat: 'fasta',
    airrInput: null
  });
}

export function resetAnalysis(): void {
  analysisState.set({
    isRunning: false,
    isSessionLoad: false,
    pendingLoadOutputDir: null,
    progress: null,
    logs: [],
    error: null,
    thresholdRequest: null
  });
}

export function addLog(level: LogEntry['level'], message: string): void {
  analysisState.update(state => ({
    ...state,
    logs: [...state.logs, { level, message, timestamp: new Date() }]
  }));
}

export function setProgress(progress: AnalysisProgress): void {
  analysisState.update(state => ({
    ...state,
    progress
  }));
}

// Helper function to group sequences by clone within a file
function groupSequencesByClone(sequences: SequenceData[]): CloneGroup[] {
  const cloneMap = new Map<number | null, SequenceData[]>();
  
  for (const seq of sequences) {
    const cloneId = seq.clone_id !== undefined ? seq.clone_id : null;
    if (!cloneMap.has(cloneId)) {
      cloneMap.set(cloneId, []);
    }
    cloneMap.get(cloneId)!.push(seq);
  }
  
  // Separate into categories
  const multiSeqClones: CloneGroup[] = [];  // Clones with ≥2 sequences
  const singletonSeqs: SequenceData[] = [];  // Clones with 1 sequence
  const noCloneSeqs: SequenceData[] = [];    // Sequences without clone_id
  
  for (const [cloneId, seqs] of cloneMap.entries()) {
    if (cloneId === null) {
      // No clone ID assigned
      noCloneSeqs.push(...seqs);
    } else if (seqs.length === 1) {
      // Singleton clone
      singletonSeqs.push(...seqs);
    } else {
      // Multi-sequence clone
      multiSeqClones.push({
        cloneId,
        sequences: seqs,
        expanded: false,  // Collapsed by default
        size: seqs.length
      });
    }
  }
  
  // Sort multi-sequence clones by size (largest first)
  multiSeqClones.sort((a, b) => b.size - a.size);
  
  // Build final groups array
  const groups: CloneGroup[] = [...multiSeqClones];
  
  // Add "Singletons" folder if there are any
  if (singletonSeqs.length > 0) {
    groups.push({
      cloneId: -1,  // Special ID for Singletons folder
      sequences: singletonSeqs,
      expanded: false,  // Collapsed by default
      size: singletonSeqs.length
    });
  }
  
  // Add "No Clone" folder if there are any
  if (noCloneSeqs.length > 0) {
    groups.push({
      cloneId: null,
      sequences: noCloneSeqs,
      expanded: false,  // Collapsed by default
      size: noCloneSeqs.length
    });
  }
  
  return groups;
}

export function processSequenceResults(data: {
  sequences: SequenceData[];
  file_groups?: Record<string, SequenceData[]>;
  output_dir?: string;
  file_id_mapping?: Record<string, string>;
}): void {
  const fileGroupsMap = data.file_groups && typeof data.file_groups === 'object' ? data.file_groups : {};
  const fileGroups: FileGroup[] = Object.entries(fileGroupsMap).map(([filename, sequences]) => ({
    filename,
    sequences: Array.isArray(sequences) ? sequences : [],
    cloneGroups: groupSequencesByClone(Array.isArray(sequences) ? sequences : []),
    expanded: true
  }));
  
  resultsState.update(state => ({
    ...state,
    sequences: data.sequences,
    fileGroups,
    ...(data.output_dir != null && { outputDir: data.output_dir }),
    ...(data.file_id_mapping != null && { fileIdMapping: data.file_id_mapping })
  }));
}

export function processDlSequenceResults(data: { sequences: SequenceData[]; file_groups: Record<string, SequenceData[]> }): void {
  const fileGroups: FileGroup[] = Object.entries(data.file_groups).map(([filename, sequences]) => ({
    filename,
    sequences,
    expanded: true
  }));
  
  resultsState.update(state => ({
    ...state,
    dlSequences: data.sequences,
    dlFileGroups: fileGroups
  }));
}

export function toggleFileGroup(filename: string): void {
  resultsState.update(state => ({
    ...state,
    fileGroups: state.fileGroups.map(group =>
      group.filename === filename
        ? { ...group, expanded: !group.expanded }
        : group
    ),
    cohortResults: state.cohortResults.map(cohort => ({
      ...cohort,
      fileGroups: cohort.fileGroups.map(group =>
        group.filename === filename
          ? { ...group, expanded: !group.expanded }
          : group
      )
    }))
  }));
}

export function selectSequence(id: string): void {
  resultsState.update(state => ({
    ...state,
    selectedSequenceId: id
  }));
}

export function selectDlSequence(id: string): void {
  resultsState.update(state => ({
    ...state,
    selectedDlSequenceId: id
  }));
}

export function toggleDlFileGroup(filename: string): void {
  resultsState.update(state => ({
    ...state,
    dlFileGroups: state.dlFileGroups.map(group =>
      group.filename === filename
        ? { ...group, expanded: !group.expanded }
        : group
    )
  }));
}

export function toggleCloneGroup(filename: string, cloneId: number | null): void {
  const toggleClones = (fileGroups: FileGroup[]) =>
    fileGroups.map(fileGroup => {
      if (fileGroup.filename === filename) {
        return {
          ...fileGroup,
          cloneGroups: fileGroup.cloneGroups.map(cloneGroup =>
            cloneGroup.cloneId === cloneId
              ? { ...cloneGroup, expanded: !cloneGroup.expanded }
              : cloneGroup
          )
        };
      }
      return fileGroup;
    });

  resultsState.update(state => ({
    ...state,
    fileGroups: toggleClones(state.fileGroups),
    cohortResults: state.cohortResults.map(cohort => ({
      ...cohort,
      fileGroups: toggleClones(cohort.fileGroups)
    }))
  }));
}

// Public clone actions
export const publicClonesActions = {
  startAnalysis() {
    resultsState.update(s => ({ ...s, isAnalyzingPublicClones: true }));
  },
  
  updateResults(data: PublicClonesData) {
    resultsState.update(s => ({
      ...s,
      publicClonesData: data,
      isAnalyzingPublicClones: false
    }));
  },
  
  clearResults() {
    resultsState.update(s => ({ ...s, publicClonesData: null }));
  }
};

