import { _electron as electron } from 'playwright';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const app = await electron.launch({ args: ['/Users/teichmann/Downloads/AutoAB-work/electron-app'], cwd: '/Users/teichmann/Downloads/AutoAB-work/electron-app', env });
app.process().stderr.on('data', d => process.stdout.write('[main-stderr] ' + d.toString().slice(0,300)));
app.process().stdout.on('data', d => process.stdout.write('[main-stdout] ' + d.toString().slice(0,300)));
await new Promise(r => setTimeout(r, 12000));
const wins = app.windows();
console.log('Fenster:', wins.length);
for (const w of wins) {
  console.log('  url:', w.url().slice(0, 120));
  console.log('  title:', await w.title().catch(() => '?'));
  const html = await w.evaluate(() => document.documentElement.outerHTML.length).catch(e => 'eval-fehler: ' + e.message.slice(0,80));
  console.log('  html-länge:', html);
}
await app.close();
