/**
 * Demo data loader for web deployment.
 * Fetches pre-generated demo-data.json and populates all Svelte stores.
 */

import { processSequenceResults, resultsState, studyDesign } from './stores/app';
import type { StudyDesign, TimepointMapping, TreeMetadata } from './stores/app';

export interface DemoData {
  sequences: any[];
  file_groups: Record<string, any[]>;
  file_id_mapping: Record<string, string>;
  timepoint_mapping: TimepointMapping;
  study_design: StudyDesign | null;
  cross_timepoint_lineages: any;
  newick_trees: Record<string, string>;
  tree_metadata: Array<{
    key: string;
    clone_id: number | null;
    clone_size: number;
    timepoint?: string;
  }>;
  output_dir: string;
}

/** Cached demo data so tree components can access newick strings */
let _demoData: DemoData | null = null;

export function getDemoData(): DemoData | null {
  return _demoData;
}

export async function loadDemoData(): Promise<void> {
  const resp = await fetch('./demo-data.json');
  if (!resp.ok) throw new Error(`Failed to load demo data: ${resp.status}`);
  const data: DemoData = await resp.json();
  _demoData = data;

  // 1. Process sequences into stores
  processSequenceResults({
    sequences: data.sequences,
    file_groups: data.file_groups,
    output_dir: data.output_dir,
    file_id_mapping: data.file_id_mapping
  });

  // 2. Set tree metadata (use key as path since we load newick from memory)
  const treeMetadata: TreeMetadata[] = data.tree_metadata.map(tm => ({
    path: tm.key,
    clone_id: tm.clone_id,
    clone_size: tm.clone_size,
    ...(tm.timepoint ? { timepoint: tm.timepoint } : {})
  }));

  resultsState.update(s => ({
    ...s,
    treeImages: treeMetadata.map(tm => tm.path),
    treeMetadata,
    timepointMapping: data.timepoint_mapping || {},
    fileIdMapping: data.file_id_mapping || {}
  }));

  // 3. Set study design
  if (data.study_design && data.study_design.groups?.length > 0) {
    studyDesign.set(data.study_design);
  } else {
    // Auto-generate study design from timepoint mapping
    const tpFiles: Record<string, string[]> = {};
    for (const [stagedFile, entry] of Object.entries(data.timepoint_mapping || {})) {
      const tp = entry.timepoint;
      if (!tpFiles[tp]) tpFiles[tp] = [];
      tpFiles[tp].push(stagedFile);
    }
    const tpLabels = Object.keys(tpFiles).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (tpLabels.length > 0) {
      studyDesign.set({
        groups: [{
          id: 'demo',
          name: 'Demo Study',
          color: '#4F46E5',
          timepoints: tpLabels.map((label, idx) => ({
            id: `tp_${idx}`,
            label,
            order: idx,
            files: tpFiles[label]
          }))
        }],
        unassigned: []
      });
    }
  }

  console.log('[DemoLoader] Loaded', data.sequences.length, 'sequences,', Object.keys(data.newick_trees).length, 'trees');
}
