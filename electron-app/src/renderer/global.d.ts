/**
 * Global type declarations for the renderer process
 */

interface DetectedTimepointFolder {
  label: string;
  dir: string;
  files: string[];
}

interface DirectoryResult {
  path: string;
  fileCount: number;
  files: string[];
  /** Detected timepoint subfolders (if any) */
  detectedTimepoints?: DetectedTimepointFolder[];
}

interface FileResult {
  success: boolean;
  content?: string;
  error?: string;
}

interface AppPaths {
  backend: string;
  bin: string;
  data: string;
  userData: string;
  temp: string;
}

interface DatabasePaths {
  type: string;
  v: string;
  d: string;
  j: string;
}

interface PipelineConfig {
  fasta_dir: string;
  clean_fasta: boolean;
  database_type: 'IMGT' | 'Custom';
  database_v?: string;
  database_d?: string;
  database_j?: string;
  output_dir?: string;
  clone_mode?: 'allele' | 'gene';
  linkage_method?: 'single' | 'average' | 'complete';
  run_covid_matching?: boolean;
  cov_abdab_database_path?: string;
  study_name?: string;
  timepoints?: { label: string; files: string[] }[];
  cohort_type?: string;
  cohort_name?: string;
}

interface ProgressData {
  stage: string;
  percent: number;
  message: string;
  cohort_type?: string;
  cohort_name?: string;
}

interface LogData {
  level: string;
  message: string;
}

interface ResultData {
  artifact: string;
  path?: string;
  data?: any;
  cohort_type?: string;
  cohort_name?: string;
}

interface ThresholdRequestData {
  calculated: number;
  timepoint_thresholds?: { label: string; calculated: number; plot_base64?: string }[];
  cohort_type?: string;
  cohort_name?: string;
}

interface CompleteData {
  success: boolean;
  error?: string;
  cohort_type?: string;
  cohort_name?: string;
  output_dir?: string;
}

interface ErrorData {
  message: string;
}

interface ElectronAPI {
  // Dialog operations
  selectDirectory: () => Promise<DirectoryResult | null>;
  selectFile: (options?: { filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  saveFile: (options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;

  // App info
  getPaths: () => Promise<AppPaths>;
  getDefaultDatabases: () => Promise<DatabasePaths>;
  getCovidDatabase: () => Promise<string | null>;

  // Pipeline operations
  startPipeline: (config: PipelineConfig) => Promise<{ success: boolean; error?: string }>;
  sendThresholdResponse: (value: number | Record<string, number>) => Promise<void>;
  cancelPipeline: () => Promise<void>;
  stageFiles: (timepoints: { label: string; files: string[]; annotationFiles?: string[] }[], studyName: string) => Promise<{ success: boolean; stagingDir?: string; timepointMapping?: any; error?: string }>;

  stageFromAirr: (input: {
    airrTsvPath: string;
    sampleTagCsvPath: string;
    tagAssignments: { sampleTag: string; group: string; mouseLabel: string; timepoint: string }[];
    studyName: string;
  }) => Promise<{
    success: boolean;
    error?: string;
    cohorts?: { name: string; stagingDir: string; timepointMapping: Record<string, { timepoint: string; originalFile: string }> }[];
    summary?: any;
  }>;

  // Load results from a previous run
  loadResults: (outputDir: string, savePrevious?: { outputDir: string; design: any }, cohorts?: { cohortType: string; cohortName: string; outputDir: string }[]) => Promise<void>;

  // Public clone analysis
  runPublicCloneAnalysis: (config: {
    output_dir: string;
    mode: 'exact' | 'lenient' | 'custom';
    similarity_threshold?: number;
    max_mismatches?: number;
    top_n?: number;
  }) => Promise<{ success: boolean; error?: string }>;

  // Pipeline events
  onPipelineProgress: (callback: (data: ProgressData) => void) => () => void;
  onPipelineLog: (callback: (data: LogData) => void) => () => void;
  onPipelineResult: (callback: (data: ResultData) => void) => () => void;
  onThresholdRequest: (callback: (data: ThresholdRequestData) => void) => () => void;
  onPipelineComplete: (callback: (data: CompleteData) => void) => () => void;
  onPipelineError: (callback: (data: ErrorData) => void) => () => void;

  // COVID matching analysis
  runCovidMatchingAnalysis: (config: {
    output_dir: string;
    cov_abdab_database_path: string;
    top_n_clones?: number;
    mode?: 'top_n' | 'public_clones';
    specific_clone_ids?: number[];
  }) => Promise<{ success: boolean; error?: string }>;

  // COVID matching events
  onCovidMatchResult: (callback: (data: any) => void) => () => void;
  onCovidMatchComplete: (callback: (data: any) => void) => () => void;
  onCovidMatchError: (callback: (data: any) => void) => () => void;

  // Public clone analysis events
  onPublicCloneResult: (callback: (data: any) => void) => () => void;
  onPublicCloneComplete: (callback: (data: any) => void) => () => void;
  onPublicCloneError: (callback: (data: any) => void) => () => void;

  // File system operations
  readFile: (filePath: string) => Promise<FileResult>;
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
  writeBinaryFile: (filePath: string, base64Data: string) => Promise<{ success: boolean; error?: string }>;
  copyFile: (sourcePath: string, destPath: string) => Promise<{ success: boolean; error?: string }>;
  fileExists: (filePath: string) => Promise<boolean>;
  readDir: (dirPath: string) => Promise<{ success: boolean; files?: string[]; error?: string }>;
  readImageBase64: (imagePath: string) => Promise<{ success: boolean; data?: string; error?: string }>;

  // Dependencies / setup screen
  checkDependencies: () => Promise<DependencyReport>;
  runDependencyFix: (fix: FixAction) => Promise<{ success: boolean; message: string }>;
  openRDownloadPage: () => Promise<{ success: boolean; url: string }>;
  onDependencyFixLog: (callback: (line: string) => void) => () => void;
}

type FixAction = 'install-rosetta' | 'install-r-packages' | 'download-r';

interface DependencyItem {
  id: string;
  label: string;
  status: 'ok' | 'missing' | 'error';
  required: boolean;
  detail?: string;
  problem?: string;
  fix?: FixAction;
}

interface DependencyReport {
  ok: boolean;
  items: DependencyItem[];
  platform: string;
  arch: string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};

