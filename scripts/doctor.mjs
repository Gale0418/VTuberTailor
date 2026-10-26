import { readFile, access, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = resolve(process.env.VTUBERTAILOR_ENGINE_ROOT || join(root, 'vendor/puppetloom'));
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('doctor [--forbid-root <retired-folder>] [--require-exporter] [--json]\nChecks real runtime paths; historical report text is not treated as an execution dependency.');
  process.exit(0);
}
let forbidden;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--forbid-root') {
    if (!argv[i + 1]) throw Error('Missing --forbid-root value');
    forbidden = resolve(argv[++i]).toLowerCase();
  } else if (!['--json', '--require-exporter'].includes(argv[i])) throw Error(`Unknown option ${argv[i]}`);
}
const checks = [];
async function check(id, action, optional = false) {
  try { checks.push({ id, passed: true, optional, detail: await action() }); }
  catch (error) { checks.push({ id, passed: false, optional, error: error.message }); }
}
async function livePath(path) {
  const actual = await realpath(path);
  if (forbidden && (actual.toLowerCase() === forbidden || actual.toLowerCase().startsWith(forbidden + '/'.replace('/', '\\')))) throw Error(`Dependency resolves into forbidden root: ${actual}`);
  return actual;
}
await check('node-version', async () => {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (!((major === 24 && (minor > 22 || minor === 22 && patch >= 1)) || major > 26 || major === 26 && (minor > 12 || minor === 12 && patch >= 1))) throw Error(`Unsupported Node ${process.versions.node}`);
  return { version: process.versions.node, executable: await livePath(process.execPath) };
});
await check('engine-build', async () => {
  await livePath(engine);
  const { inspectCliBuild } = await import(pathToFileURL(join(engine, 'scripts/lib/cli-build-identity.mjs')).href);
  const state = await inspectCliBuild(engine);
  if (!state.current) throw Error(`CLI build is stale: ${JSON.stringify(state)}`);
  return state;
});
await check('workspace-links', async () => {
  const entries = {};
  for (const name of ['core', 'renderer', 'web-runtime', 'runtime-adapters', 'cli', 'desktop']) entries[name] = await livePath(join(engine, 'node_modules/@puppetloom', name));
  return entries;
});
await check('python-qa', async () => {
  const python = await livePath(join(root, '.runtime/python/Scripts/python.exe'));
  const p = spawnSync(python, ['-c', 'import json,PIL,numpy,yaml;print(json.dumps({"pillow":PIL.__version__,"numpy":numpy.__version__,"pyyaml":yaml.__version__}))'], { encoding: 'utf8', windowsHide: true });
  if (p.error || p.status !== 0) throw Error(p.error?.message || p.stderr);
  return { executable: python, versions: JSON.parse(p.stdout) };
});
await check('native-exporter', async () => {
  const config = JSON.parse(await readFile(join(engine, 'runtime/cubism-exporter/config.json'), 'utf8'));
  const java = await livePath(config.java);
  for (const path of config.classpath.split(';')) await livePath(path);
  for (const item of config.dependencies) await access(await livePath(item.path));
  return { java, sourceSha256: config.sourceSha256, classpathEntries: config.classpath.split(';').length };
}, !argv.includes('--require-exporter'));
const result = { ready: checks.every(c => c.optional || c.passed), root, engine, forbiddenRoot: forbidden ?? null, checks };
console.log(JSON.stringify(result, null, 2));
if (!result.ready) process.exitCode = 1;
