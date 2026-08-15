/**
 * Validate the depth-normalisation layer against the reference study.
 *
 * The point is that the application must reproduce numbers that were computed
 * outside it, otherwise the tool would say something different from the
 * analysis it was built for. So this runs the real TypeScript, bundled with
 * esbuild, over the clone-pass tables of the reference run. A Python
 * reimplementation would only prove that two reimplementations agree.
 *
 * Depths are hardwired to 10 and 20 and do not go through suggestDepth():
 * a validation that used the default would silently start testing something
 * else the moment the default rule changed.
 *
 *   node scripts/validate-rarefaction.mjs
 */
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTS = process.env.AUTOAB_OUTS
  || path.resolve(appDir, '..', 'geneGUI', 'outs');
const RUNS = {
  Disease: 'run_2026-08-11T00-21-47_35nw',
  Control: 'run_2026-08-11T00-27-59_bz04',
};

/**
 * Reference values. The medians come from the study tables and are reproducible
 * to three decimals. The p-values deliberately are not asserted to a decimal:
 * at D = 10 every donor sits at 99.8% of ln(10), so the ranking is decided by
 * noise and p moves between roughly 0.45 and 0.75 with the draw scheme while
 * the medians do not move at all. What must hold is the side of 0.05 it lands
 * on, which is the criterion that actually protects a conclusion.
 */
const EXPECT = {
  10: { tp: 'T3', disease: 2.298, control: 2.292, keptD: 19, keptC: 11 },
  20: { tp: 'T3', disease: 2.988, control: 2.965, keptD: 19, keptC: 6 },
};
const MEDIAN_TOL = 0.003;

// ---------------------------------------------------------------- bundle
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoab-rarefy-'));
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(entry, `
export { rarefyDonor, cloneAssigned, suggestDepth, retentionAt, metricCeiling,
         ceilingFraction, DEFAULT_REPLICATES, DEFAULT_SEED, MIN_USEFUL_DEPTH }
  from '${path.join(appDir, 'src/renderer/lib/utils/rarefaction').replace(/\\/g, '/')}';
export { computeDiversity }
  from '${path.join(appDir, 'src/renderer/lib/utils/repertoire-metrics').replace(/\\/g, '/')}';
export { wilcoxonRankSum, benjaminiHochberg }
  from '${path.join(appDir, 'src/renderer/lib/utils/statistics').replace(/\\/g, '/')}';
`);
const bundlePath = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: bundlePath, logLevel: 'error' });
const lib = await import(bundlePath);

// ---------------------------------------------------------------- load data
function loadRun(run) {
  const dir = path.join(OUTS, run);
  const idmap = JSON.parse(fs.readFileSync(path.join(dir, 'file_id_mapping.json'), 'utf8'));
  const tsv = fs.readFileSync(path.join(dir, 'ig_out_data_db-pass_clone-pass.tsv'), 'utf8').split('\n');
  const head = tsv[0].split('\t');
  const ci = head.indexOf('clone_id');
  const si = head.indexOf('sequence_id');
  const ti = head.indexOf('timepoint');
  const byDonor = new Map();
  for (let i = 1; i < tsv.length; i++) {
    if (!tsv[i]) continue;
    const f = tsv[i].split('\t');
    if (!f[ci]) continue;
    const fid = f[si].slice(f[si].lastIndexOf('_') + 1);
    const fname = idmap[fid];
    if (!fname) continue;
    const donor = fname.split('_')[1];
    const key = `${donor}|${f[ti]}`;
    if (!byDonor.has(key)) byDonor.set(key, []);
    // Only clone_id is needed: every metric under test is clone-derived.
    byDonor.get(key).push({ clone_id: Number(f[ci]) });
  }
  return byDonor;
}

const data = {};
for (const [group, run] of Object.entries(RUNS)) {
  const dir = path.join(OUTS, run);
  if (!fs.existsSync(dir)) {
    console.log(`SKIP: reference run not present at ${dir}`);
    console.log('Set AUTOAB_OUTS to the directory holding the reference runs.');
    process.exit(0);
  }
  data[group] = loadRun(run);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const TPS = ['T1', 'T2', 'T3'];
let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };
const pass = (m) => console.log(`  ok    ${m}`);

// ---------------------------------------------------------------- depth rule
console.log('\n=== suggested depth ===');
const allDepths = [];
for (const g of Object.keys(RUNS)) {
  for (const seqs of data[g].values()) allDepths.push(lib.cloneAssigned(seqs).length);
}
const sug = lib.suggestDepth(allDepths);
const minDepth = Math.min(...allDepths);
console.log(`  donor depths: min ${minDepth}, max ${Math.max(...allDepths)}, n ${allDepths.length}`);
console.log(`  suggested D = ${sug.depth}, keeps ${sug.kept}/${sug.total}${sug.atFloor ? ' (at floor)' : ''}`);
if (sug.depth <= minDepth && minDepth < lib.MIN_USEFUL_DEPTH) {
  fail(`suggestion collapsed onto the shallowest donor (${minDepth})`);
} else {
  pass('suggestion is not driven by the shallowest donor');
}

// ---------------------------------------------------------------- rarefy
for (const depth of [10, 20]) {
  const exp = EXPECT[depth];
  console.log(`\n=== depth ${depth}  (ln D = ${Math.log(depth).toFixed(3)}, ${lib.DEFAULT_REPLICATES} draws, seed ${lib.DEFAULT_SEED}) ===`);
  console.log('  tp   group     kept/total   Shannon   % of ceiling');

  const shannon = {};
  for (const tp of TPS) {
    shannon[tp] = {};
    for (const g of Object.keys(RUNS)) {
      const donors = [...data[g].entries()].filter(([k]) => k.endsWith(`|${tp}`));
      const vals = [];
      for (const [key, seqs] of donors) {
        const m = lib.rarefyDonor(seqs, depth, key);
        if (m) vals.push(m.shannonEntropy);
      }
      shannon[tp][g] = vals;
      const med = median(vals);
      const frac = lib.ceilingFraction('shannon', depth, med);
      console.log(`  ${tp}   ${g.padEnd(9)} ${String(vals.length).padStart(3)}/${String(donors.length).padEnd(6)} `
        + `${med.toFixed(3).padStart(8)}   ${(frac * 100).toFixed(1)}%`);
    }
    const t = lib.wilcoxonRankSum(shannon[tp].Disease, shannon[tp].Control);
    console.log(`       -> p = ${t.valid ? t.p.toFixed(4) : 'n too small'}`);
  }

  // assertions, all on the timepoint the study reports
  const tp = exp.tp;
  const dMed = median(shannon[tp].Disease);
  const cMed = median(shannon[tp].Control);
  const t = lib.wilcoxonRankSum(shannon[tp].Disease, shannon[tp].Control);

  const chk = (label, got, want) => {
    if (Math.abs(got - want) <= MEDIAN_TOL) pass(`${label} ${got.toFixed(3)} (expected ${want})`);
    else fail(`${label} ${got.toFixed(3)}, expected ${want} +/- ${MEDIAN_TOL}`);
  };
  chk(`${tp} Disease median`, dMed, exp.disease);
  chk(`${tp} Control median`, cMed, exp.control);

  const kd = shannon[tp].Disease.length;
  const kc = shannon[tp].Control.length;
  if (kd === exp.keptD && kc === exp.keptC) pass(`${tp} donors retained ${kd}/${kc}`);
  else fail(`${tp} donors retained ${kd}/${kc}, expected ${exp.keptD}/${exp.keptC}`);

  if (!t.valid) fail(`${tp} test invalid`);
  else if (t.p > 0.05) pass(`${tp} p = ${t.p.toFixed(3)}, above 0.05 as the study reports`);
  else fail(`${tp} p = ${t.p.toFixed(3)} crosses 0.05, the study reports no resolvable difference`);

  // the ceiling caveat the numbers above are meaningless without
  const fd = lib.ceilingFraction('shannon', depth, dMed);
  const fc = lib.ceilingFraction('shannon', depth, cMed);
  if (fd > 0.97 && fc > 0.97) {
    console.log(`  note  both medians are above 97% of ln(${depth}); at this depth the`);
    console.log('        metric has no room left to separate groups, so the large p-value');
    console.log('        means "not resolvable here", not "the groups are alike"');
  }
}

// ---------------------------------------------------------------- determinism
console.log('\n=== determinism ===');
const key = [...data.Disease.keys()].find((k) => k.endsWith('|T3'));
const a = lib.rarefyDonor(data.Disease.get(key), 10, key);
const b = lib.rarefyDonor(data.Disease.get(key), 10, key);
if (a && b && a.shannonEntropy === b.shannonEntropy) pass('repeated calls return identical values');
else fail('repeated calls disagree, the seeding is not deterministic');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
