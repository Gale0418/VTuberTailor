#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineModuleUrls } from './native/engine-module-urls.mjs';
import { runNativeVerification } from './native/verify.mjs';

const help = `VTuberTailor official Core and atlas verification

Usage:
  node scripts/verify_native.mjs --project <canonical> --export <exportDir> --core <Live2DCubismCore.dll> [--output <newQA>]
  node scripts/verify_native.mjs --help

By default, writes a new export/qa-tailor directory. Existing output directories are refused.
The verifier runs the supplied official Cubism Core DLL and renders offline atlas-backed frames; it does not capture VTube Studio.`;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') return { help: true };
    if (!['--project', '--export', '--core', '--output'].includes(token)) throw new Error(`Unknown argument: ${token}\n\n${help}`);
    if (result[token.slice(2)]) throw new Error(`Duplicate argument: ${token}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}\n\n${help}`);
    result[token.slice(2)] = value;
  }
  for (const required of ['project', 'export', 'core']) if (!result[required]) throw new Error(`Missing required --${required}.\n\n${help}`);
  return result;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(help);
} else {
  try {
    const args = parseArgs(process.argv.slice(2));
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(scriptDir, '..');
    const engineRoot = resolve(process.env.VTUBERTAILOR_ENGINE_ROOT || join(repoRoot, 'vendor', 'puppetloom'));
    const enginePackagePath = join(engineRoot, 'packages', 'core', 'package.json');
    const enginePackage = JSON.parse(await readFile(enginePackagePath, 'utf8'));
    const moduleUrls = engineModuleUrls(engineRoot, enginePackage.main || 'dist/index.js');
    const [engine, projectStore, calibrationStore] = await Promise.all([
      import(moduleUrls.entry),
      import(moduleUrls.projectStore),
      import(moduleUrls.calibrationStore),
    ]);
    const runtimeApi = { ...engine, ...projectStore, ...calibrationStore };
    const require = createRequire(join(engineRoot, 'package.json'));
    const sharp = require('sharp');
    const paths = {
      project: resolve(args.project), exportDir: resolve(args.export), core: resolve(args.core),
      output: resolve(args.output || join(resolve(args.export), 'qa-tailor')),
    };
    for (const [label, path] of Object.entries(paths)) if (!isAbsolute(path)) throw new Error(`${label} path is not absolute: ${path}`);
    if (paths.project === paths.exportDir) throw new Error('--project and --export must be different directories.');
    if ((await stat(paths.output).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)))) throw new Error(`Refusing to overwrite existing QA output: ${paths.output}`);
    await mkdir(dirname(paths.output), { recursive: true });
    await runNativeVerification({ ...paths, engine: runtimeApi, sharp });
  } catch (error) {
    console.error(`verify_native: ${error.message}`);
    process.exitCode = 1;
  }
}
