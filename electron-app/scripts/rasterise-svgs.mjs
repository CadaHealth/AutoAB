/**
 * Rasterise exported SVGs to high-resolution PNGs.
 *
 * No rsvg-convert, inkscape or cairo on this machine, and zooming the app's own
 * window produced smaller bitmaps rather than larger ones, because a screenshot
 * captures CSS pixels. Electron is a browser, so each SVG is loaded into a blank
 * page at N times its intrinsic size and captured there -- vector art scales
 * losslessly, so the result is a genuine Nx bitmap.
 *
 *   node scripts/rasterise-svgs.mjs <dir> [scale]
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = process.argv[2];
const SCALE = Number(process.argv[3] || 3);
if (!DIR) throw new Error('usage: rasterise-svgs.mjs <dir> [scale]');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.svg')).sort();
if (!files.length) throw new Error(`no SVGs in ${DIR}`);
console.log(`${files.length} SVGs, scale ${SCALE}x`);

const env = { ...process.env, NODE_ENV: 'production', AUTOAB_NO_DEVTOOLS: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const app = await electron.launch({ args: [appDir], cwd: appDir, env });
let win = null;
for (let i = 0; i < 60 && !win; i++) {
  win = app.windows().find((w) => !w.url().startsWith('devtools://')) || null;
  if (!win) await new Promise((r) => setTimeout(r, 500));
}
await win.waitForLoadState('domcontentloaded');

for (const f of files) {
  const svg = fs.readFileSync(path.join(DIR, f), 'utf8').replace(/^<\?xml[^>]*\?>\s*/, '');
  const m = svg.match(/width="(\d+)"[\s\S]*?height="(\d+)"/);
  const w = m ? Number(m[1]) : 900;
  const h = m ? Number(m[2]) : 400;
  const W = Math.round(w * SCALE);
  const H = Math.round(h * SCALE);

  await win.setViewportSize({ width: Math.min(W + 40, 8000), height: Math.min(H + 40, 8000) });
  await win.setContent(
    `<body style="margin:0;background:#fff">
       <div id="wrap" style="width:${W}px;height:${H}px;background:#fff">
         ${svg.replace(/^<svg /, `<svg width="${W}" height="${H}" `)}
       </div>
     </body>`,
    { waitUntil: 'load' }
  );
  await win.waitForTimeout(500);
  const target = path.join(DIR, f.replace(/\.svg$/, '.png'));
  await win.locator('#wrap').screenshot({ path: target });
  const kb = Math.round(fs.statSync(target).size / 1024);
  console.log(`  ${f} -> ${path.basename(target)}  ${W}x${H}  ${kb} KB`);
}

await app.close();
console.log('done');
