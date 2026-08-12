/**
 * Drive the two-cohort, three-timepoint study through the real wizard and
 * capture the result views as images.
 *
 * Only dialog.showOpenDialog is replaced, and only to answer with a directory
 * from a queue. The 10x pair detection, the staging step and the pipeline all
 * run for real, which is the point: this is the path a user takes.
 *
 *   node scripts/e2e-cohorts.mjs <outputDir>
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = process.argv[2] || path.join(appDir, 'figures');
const ROOT = '/Users/teichmann/Desktop/LongCovid_Symptom_FASTA';

const COHORTS = [
  { name: 'Disease', dirs: ['MemoryProblems_T1', 'MemoryProblems_T2', 'MemoryProblems_T3'] },
  { name: 'Control', dirs: ['NonLongCovid_T1', 'NonLongCovid_T2', 'NonLongCovid_T3'] },
];
const LABELS = ['T1', 'T2', 'T3'];

const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
fs.mkdirSync(SHOTS, { recursive: true });

const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

step('Launching application');
const app = await electron.launch({ args: [appDir], cwd: appDir, env });

let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
if (!win) throw new Error('no application window appeared');
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1600, height: 1100 });
await win.waitForTimeout(2000);

if (await win.locator('h1:has-text("Setup")').count()) {
  const missing = await win.locator('li.item:not(.ok) .label').allInnerTexts();
  if (missing.length) console.log(`  ! setup reports missing: ${missing.join(', ')}`);
  await win.locator('button:has-text("Continue")').last().click();
  await win.waitForTimeout(800);
  ok('setup screen dismissed');
}

await win.waitForSelector('text=Define Study', { timeout: 30000 });
ok('wizard rendered');

// Answer the directory picker from a queue, in the order the folders are asked
// for. Everything downstream of the dialog stays the production code path.
const queue = COHORTS.flatMap((c) => c.dirs.map((d) => path.join(ROOT, d)));
await app.evaluate(({ dialog }, dirs) => {
  let i = 0;
  dialog.showOpenDialog = async () => {
    const filePaths = [dirs[Math.min(i, dirs.length - 1)]];
    i += 1;
    return { canceled: false, filePaths };
  };
}, queue);
ok(`directory queue armed (${queue.length} folders)`);

win.on('console', (m) => {
  const t = m.text();
  if (/error|failed/i.test(t)) console.log(`    [renderer] ${t.slice(0, 200)}`);
});

// ------------------------------------------------------------------ step 1
step('Step 1, Define Study with two cohorts');
await win.fill('input[placeholder*="Memory Loss"]', 'LC MP vs NLC');

await win.locator('input[type="checkbox"]').first().check();
await win.waitForTimeout(1000);
const sections = win.locator('.cohort-section');
if ((await sections.count()) !== 2) {
  throw new Error(`expected 2 cohort sections, saw ${await sections.count()}`);
}
ok('multi-cohort mode enabled');

for (let ci = 0; ci < COHORTS.length; ci++) {
  const section = sections.nth(ci);
  await section.locator('input.cohort-name-input').fill(COHORTS[ci].name);
  for (let t = 0; t < LABELS.length; t++) {
    await section.locator('button:has-text("Add Timepoint")').click();
    await win.waitForTimeout(600);
    const cards = section.locator('input.tp-label-input');
    await cards.nth(t).fill(LABELS[t]);
    // A card that already has a folder relabels its button to "Change Folder",
    // so the only "Select Folder" left belongs to the card just added.
    await section.locator('button:has-text("Select Folder")').last().click();
    await win.waitForTimeout(3000);
  }
  ok(`${COHORTS[ci].name}: 3 timepoints attached`);
}

await win.screenshot({ path: path.join(SHOTS, '01_define_study.png') });

const cont = () => win.locator('button:has-text("Continue")').last();
for (let i = 0; i < 30 && (await cont().isDisabled()); i++) await win.waitForTimeout(500);
await cont().click();
await win.waitForTimeout(1200);

// ------------------------------------------------------------------ step 2
step('Step 2, reference and options');
if (await win.locator('button:has-text("Human")').count()) {
  await win.locator('button:has-text("Human")').first().click();
  await win.waitForTimeout(600);
}
await win.screenshot({ path: path.join(SHOTS, '02_configure.png') });
for (let i = 0; i < 30 && (await cont().isDisabled()); i++) await win.waitForTimeout(500);
await cont().click();
await win.waitForTimeout(1200);

// ------------------------------------------------------------------ step 3
step('Step 3, review and start');
await win.screenshot({ path: path.join(SHOTS, '03_review.png') });
const start = win.locator('button:has-text("Start Analysis")').last();
await start.waitFor({ state: 'visible', timeout: 20000 });
await start.click();
ok('analysis started');

// --------------------------------------------------------- threshold prompts
step('Running pipeline, answering threshold dialogs');
const deadline = Date.now() + 30 * 60 * 1000;
let answered = 0;
let sawResults = false;
const fallbacks = [];

while (Date.now() < deadline) {
  // The dialog's action is labelled just "Apply". Matching on the primary
  // button inside the modal keeps this from also hitting the "Apply a single
  // value to all timepoints" helper above it.
  const confirm = win.locator('.modal-actions button.btn-primary:has-text("Apply")');
  if (await confirm.count()) {
    const shot = path.join(SHOTS, `04_threshold_${answered + 1}.png`);
    await win.screenshot({ path: shot }).catch(() => {});
    // The dialog names the method behind each estimate. A run where the model
    // fit failed falls back to the median nearest-neighbour distance, which is
    // far looser and inflates cross-patient clone sharing -- not a run to build
    // results on, so it is reported and the caller can retry.
    const modal = await win.locator('.modal, [class*="modal"]').first().innerText().catch(() => '');
    if (/model fit failed/i.test(modal)) {
      fallbacks.push(modal.split('\n').filter((l) => /fit failed/i.test(l)).join(' | ').slice(0, 160));
      console.log(`    !! fallback threshold in dialog ${answered + 1}`);
    }
    await confirm.last().click().catch(() => {});
    answered += 1;
    console.log(`    threshold dialog ${answered} confirmed`);
    await win.waitForTimeout(2500);
    continue;
  }
  if (await win.locator('text=Analysis Results').count()) { sawResults = true; break; }
  await win.waitForTimeout(4000);
}
console.log(`  thresholds answered: ${answered}`);
if (!sawResults) {
  await win.screenshot({ path: path.join(SHOTS, 'ZZ_timeout.png') }).catch(() => {});
  const body = await win.evaluate(() => document.body.innerText).catch(() => '');
  throw new Error('results never appeared. Screen said:\n' + body.slice(0, 1200));
}
ok('results view reached');
await win.waitForTimeout(6000);

// ------------------------------------------------------------------ figures
step('Capturing result views');
const tabs = ['Sequence Browser', 'Dashboard', 'Phylogenetic Trees', 'Clones', 'COVID-DB Matching'];
let n = 5;
for (const tab of tabs) {
  const el = win.locator(`button:has-text("${tab}"), [role="tab"]:has-text("${tab}")`).first();
  if (!(await el.count())) { console.log(`    (no tab "${tab}")`); continue; }
  await el.click().catch(() => {});
  await win.waitForTimeout(4000);
  const file = path.join(SHOTS, `${String(n).padStart(2, '0')}_${tab.replace(/\W+/g, '_').toLowerCase()}.png`);
  await win.screenshot({ path: file, fullPage: false });
  console.log(`    ${path.basename(file)}`);
  n += 1;
}

// Individual charts, which is what the thesis figures actually show.
await win.locator('button:has-text("Dashboard")').first().click().catch(() => {});
await win.waitForTimeout(4000);
const charts = await win.locator('.chart-card, .metric-card, .chart-container, figure').all();
console.log(`  chart containers found: ${charts.length}`);
for (let i = 0; i < charts.length; i++) {
  const title = (await charts[i].innerText().catch(() => '')).split('\n')[0].slice(0, 40).replace(/\W+/g, '_') || `chart${i}`;
  await charts[i].screenshot({ path: path.join(SHOTS, `chart_${String(i).padStart(2, '0')}_${title}.png`) }).catch(() => {});
}

const out = await win.evaluate(() => document.body.innerText).catch(() => '');
fs.writeFileSync(path.join(SHOTS, 'results_text.txt'), out);
ok(`figures written to ${SHOTS}`);
await app.close();
if (fallbacks.length) {
  console.log(`\nFALLBACK THRESHOLDS: ${fallbacks.length}`);
  fallbacks.forEach((f) => console.log(`  ${f}`));
  process.exit(2);
}
console.log('\nall thresholds came from a model fit');
