import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = resolve(process.env.VTUBERTAILOR_ENGINE_ROOT || join(root, 'vendor/puppetloom'));
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('smoke [--output <new-dir>]\nCreates a separate synthetic-fixture project, verifies it and renders poses. Does not alter character projects or launch VTS.'); process.exit(0); }
let output = join(root, 'local-reports', `smoke-${Date.now()}`);
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--output' || !args[i + 1]) throw Error(`Unknown/missing argument ${args[i]}`);
  output = resolve(args[++i]);
}
if (output === engine || output.startsWith(engine + '/'.replace('/', '\\'))) throw Error('Smoke output must stay outside the engine');
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
function run(label, cliArgs) {
  const child = spawnSync(process.execPath, [join(engine, 'apps/cli/dist/index.js'), ...cliArgs, '--json'], { cwd: engine, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw Error(`${label}: ${child.error?.message || child.stderr || child.stdout}`);
  const parsed = JSON.parse(child.stdout);
  return writeFile(join(output, label + '.json'), JSON.stringify(parsed, null, 2)).then(() => parsed);
}
const project = join(output, 'project');
await run('create', ['create', '--input', join(engine, 'test/fixtures/semantic.psd'), '--output', project, '--name', 'VTuberTailor smoke fixture']);
const verification = await run('verify', ['verify', '--project', project]);
if (!verification.valid) throw Error('Fresh fixture project verification failed');
await run('render', ['render', '--project', project, '--output', join(output, 'poses'), '--suite', 'poses', '--size', '400']);
async function pngs(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await pngs(path));
    else if (entry.name.endsWith('.png')) files.push(path);
  }
  return files;
}
const frames = await pngs(join(output, 'poses'));
if (!frames.length) throw Error('No pose PNGs were produced');
const { loadProject, loadCalibration } = await import(pathToFileURL(join(engine, 'packages/core/dist/project-store.js')).href);
const { projectFingerprint } = await import(pathToFileURL(join(engine, 'packages/core/dist/calibration-store.js')).href);
const model = await loadProject(project), calibration = await loadCalibration(project);
const report = { passed: true, output, engine, node: process.execPath, project, revision: calibration.revision, fingerprint: projectFingerprint(model), layers: model.layers.length, poseFiles: await Promise.all(frames.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }))), limitations: 'Synthetic PSD create/verify/render smoke. This is not character aesthetic, official Core, Editor or VTS live verification.' };
await writeFile(join(output, 'smoke-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, project, layers: model.layers.length, pngs: frames.length, report: join(output, 'smoke-report.json') }));
