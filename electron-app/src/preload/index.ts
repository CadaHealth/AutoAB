/**
 * Preload Script
 * 
 * Exposes a safe API to the renderer process
 */

import { contextBridge, ipcRenderer } from 'electron';

// Types for the API
interface DirectoryResult {
  path: string;
  fileCount: number;
  files: string[];
  detectedTimepoints?: { label: string; dir: string; files: string[] }[];
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
  cohort_type?: string;
  cohort_name?: string;
}

// Expose API to renderer
const api = {
  // Dialog operations
  selectDirectory: (): Promise<DirectoryResult | null> => {
    console.log('[Preload] selectDirectory called');
    return ipcRenderer.invoke('dialog:selectDirectory');
  },
  
  selectFile: (options?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null> => 
    ipcRenderer.invoke('dialog:selectFile', options),
  
  saveFile: (options?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> => 
    ipcRenderer.invoke('dialog:saveFile', options),

  // App info
  getPaths: (): Promise<AppPaths> => 
    ipcRenderer.invoke('app:getPaths'),
  
  getDefaultDatabases: (): Promise<DatabasePaths> => 
    ipcRenderer.invoke('app:getDefaultDatabases'),

  getCovidDatabase: (): Promise<string | null> =>
    ipcRenderer.invoke('app:getCovidDatabase'),

  // Pipeline operations
  startPipeline: (config: PipelineConfig): Promise<{ success: boolean; error?: string }> => 
    ipcRenderer.invoke('pipeline:start', config),
  
  sendThresholdResponse: (value: number | Record<string, number>): Promise<void> => 
    ipcRenderer.invoke('pipeline:thresholdResponse', value),
  
  cancelPipeline: (): Promise<void> => 
    ipcRenderer.invoke('pipeline:cancel'),

  stageFiles: (timepoints: { label: string; files: string[]; annotationFiles?: string[] }[], studyName: string): Promise<{ success: boolean; stagingDir?: string; timepointMapping?: any; error?: string }> =>
    ipcRenderer.invoke('pipeline:stageFiles', timepoints, studyName),

  // Stage from BD Rhapsody AIRR TSV + SampleTag CSV into per-cohort staging dirs.
  stageFromAirr: (input: {
    airrTsvPath: string;
    sampleTagCsvPath: string;
    tagAssignments: { sampleTag: string; group: string; mouseLabel: string; timepoint: string }[];
    studyName: string;
  }): Promise<{
    success: boolean;
    error?: string;
    cohorts?: { name: string; stagingDir: string; timepointMapping: Record<string, { timepoint: string; originalFile: string }> }[];
    summary?: any;
  }> =>
    ipcRenderer.invoke('pipeline:stageFromAirr', input),

  loadResults: (outputDir: string, savePrevious?: { outputDir: string; design: any }, cohorts?: { cohortType: string; cohortName: string; outputDir: string }[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pipeline:loadResults', outputDir, savePrevious, cohorts),

  // Public clone analysis
  runPublicCloneAnalysis: (config: {
    output_dir: string;
    mode: 'exact' | 'lenient' | 'custom';
    similarity_threshold?: number;
    max_mismatches?: number;
    top_n?: number;
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pipeline:runPublicCloneAnalysis', config),

  // COVID matching analysis
  runCovidMatchingAnalysis: (config: {
    output_dir: string;
    cov_abdab_database_path: string;
    top_n_clones?: number;
    /** "top_n" (default) or "public_clones" */
    mode?: 'top_n' | 'public_clones';
    /** When mode="public_clones", the explicit list of clone IDs to match */
    specific_clone_ids?: number[];
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('pipeline:runCovidMatchingAnalysis', config),

  // COVID matching events
  onCovidMatchResult: (callback: (data: any) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:covidMatchResult', handler);
    return () => ipcRenderer.removeListener('pipeline:covidMatchResult', handler);
  },

  onCovidMatchComplete: (callback: (data: any) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:covidMatchComplete', handler);
    return () => ipcRenderer.removeListener('pipeline:covidMatchComplete', handler);
  },

  onCovidMatchError: (callback: (data: any) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:covidMatchError', handler);
    return () => ipcRenderer.removeListener('pipeline:covidMatchError', handler);
  },

  // Pipeline events
  onPipelineProgress: (callback: (data: { stage: string; percent: number; message: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:progress', handler);
    return () => ipcRenderer.removeListener('pipeline:progress', handler);
  },
  
  onPipelineLog: (callback: (data: { level: string; message: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:log', handler);
    return () => ipcRenderer.removeListener('pipeline:log', handler);
  },
  
  onPipelineResult: (callback: (data: { artifact: string; path?: string; data?: any }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:result', handler);
    return () => ipcRenderer.removeListener('pipeline:result', handler);
  },
  
  onThresholdRequest: (callback: (data: { calculated: number; timepoint_thresholds?: { label: string; calculated: number; plot_base64?: string }[] }) => void) => {
    console.log('[Preload] Setting up onThresholdRequest listener');
    const handler = (_: any, data: any) => {
      console.log('[Preload] Received pipeline:threshold-request event:', data);
      callback(data);
    };
    ipcRenderer.on('pipeline:threshold-request', handler);
    console.log('[Preload] Listener registered for pipeline:threshold-request');
    return () => {
      console.log('[Preload] Removing threshold request listener');
      ipcRenderer.removeListener('pipeline:threshold-request', handler);
    };
  },
  
  onPipelineComplete: (callback: (data: { success: boolean; error?: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:complete', handler);
    return () => ipcRenderer.removeListener('pipeline:complete', handler);
  },
  
  onPipelineError: (callback: (data: { message: string }) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:error', handler);
    return () => ipcRenderer.removeListener('pipeline:error', handler);
  },

  // Public clone analysis events
  onPublicCloneResult: (callback: (data: any) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:publicCloneResult', handler);
    return () => ipcRenderer.removeListener('pipeline:publicCloneResult', handler);
  },

  onPublicCloneComplete: (callback: (data: any) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:publicCloneComplete', handler);
    return () => ipcRenderer.removeListener('pipeline:publicCloneComplete', handler);
  },

  onPublicCloneError: (callback: (data: any) => void) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('pipeline:publicCloneError', handler);
    return () => ipcRenderer.removeListener('pipeline:publicCloneError', handler);
  },

  // File system operations
  readFile: (filePath: string): Promise<FileResult> => 
    ipcRenderer.invoke('fs:readFile', filePath),
  
  writeFile: (filePath: string, content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),

  writeBinaryFile: (filePath: string, base64Data: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:writeBinaryFile', filePath, base64Data),

  copyFile: (sourcePath: string, destPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:copyFile', sourcePath, destPath),
  
  fileExists: (filePath: string): Promise<boolean> => 
    ipcRenderer.invoke('fs:exists', filePath),
  
  readDir: (dirPath: string): Promise<{ success: boolean; files?: string[]; error?: string }> => 
    ipcRenderer.invoke('fs:readDir', dirPath),
  
  readImageBase64: (imagePath: string): Promise<{ success: boolean; data?: string; error?: string }> => 
    ipcRenderer.invoke('fs:readImageBase64', imagePath)
};

// Expose the API to the renderer
console.log('[Preload] Script starting...');
console.log('[Preload] contextBridge:', typeof contextBridge);
console.log('[Preload] ipcRenderer:', typeof ipcRenderer);

try {
  console.log('[Preload] Exposing electronAPI to renderer');
  console.log('[Preload] contextBridge available:', typeof contextBridge !== 'undefined');
  console.log('[Preload] api object keys:', Object.keys(api));
  
  if (typeof contextBridge === 'undefined') {
    throw new Error('contextBridge is undefined!');
  }
  
  contextBridge.exposeInMainWorld('electronAPI', api);
  
  console.log('[Preload] electronAPI exposed successfully');
  console.log('[Preload] Done!');
} catch (error: any) {
  console.error('[Preload] FATAL ERROR exposing electronAPI:', error);
  console.error('[Preload] Error stack:', error?.stack);
  // Don't throw - let Electron handle it, but log the error
}

// Type declaration for the renderer
export type ElectronAPI = typeof api;

