#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: node scripts/package_vts.mjs --export <dir> --output <newRuntimeDir> --name <modelName> [options]

Options:
  --preset <existingModel.vtube.json>  Copy preset settings and replace only Name, ModelID, and FileReferences
  --icon <png|jpg>                     Copy model icon into runtime package
  --idle <motion3>                     Validate and add the supplied idle motion
  --idle-lost <motion3>                Validate and add idle motion for tracking lost
  --qa-report <native-report.json>     Require a passed JSON report matching the export fingerprint
  --help                               Show this help
`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const readJson = async (path) => JSON.parse((await readFile(path)).toString('utf8').replace(/^\uFEFF/, ''));
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function parseArgs(argv) {
  const result = {};
  const valueFlags = new Set(['--export', '--output', '--name', '--preset', '--icon', '--idle', '--idle-lost', '--qa-report']);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help') return { help: true };
    if (!valueFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
    if (result[flag] !== undefined) throw new Error(`Duplicate option: ${flag}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
    result[flag] = argv[++i];
  }
  for (const required of ['--export', '--output', '--name']) if (!result[required]) throw new Error(`Required option missing: ${required}`);
  if (!result['--name'].trim()) throw new Error('--name must not be empty');
  return result;
}

function exportMetadata(status) {
  const sourceFingerprint = status?.sourceFingerprint ?? status?.exportFingerprint ?? null;
  const sourceRevision = status?.sourceRevision ?? status?.revision ?? null;
  return { sourceFingerprint, sourceRevision };
}

function gatherReferences(model) {
  const refs = model?.FileReferences;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new Error('model3 JSON has no valid FileReferences object.');
  const entries = [];
  const add = (file, label) => {
    if (file == null || file === '') return;
    if (typeof file !== 'string') throw new Error(`${label} reference must be a string.`);
    entries.push({ file, label });
  };
  add(refs.Moc, 'Moc');
  for (const file of refs.Textures ?? []) add(file, 'Textures');
  for (const key of ['Physics', 'Pose', 'DisplayInfo', 'UserData']) add(refs[key], key);
  for (const [index, item] of (refs.Expressions ?? []).entries()) add(item?.File, `Expressions[${index}]`);
  for (const [group, motions] of Object.entries(refs.Motions ?? {})) {
    if (!Array.isArray(motions)) throw new Error(`Motions.${group} must be an array.`);
    for (const [index, item] of motions.entries()) add(item?.File, `Motions.${group}[${index}]`);
  }
  if (!refs.Moc) throw new Error('model3 FileReferences.Moc is required.');
  return entries;
}

async function safeSourceFile(root, reference) {
  if (isAbsolute(reference) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(reference) || reference.includes('\0')) {
    throw new Error(`Absolute or URI runtime reference is not allowed: ${reference}`);
  }
  const candidate = resolve(root, reference);
  if (!inside(root, candidate)) throw new Error(`Runtime reference escapes export directory: ${reference}`);
  let actual;
  try { actual = await realpath(candidate); } catch { throw new Error(`Runtime dependency is missing: ${reference}`); }
  if (!inside(root, actual)) throw new Error(`Runtime reference resolves outside export directory: ${reference}`);
  const info = await lstat(candidate);
  if (!info.isFile()) throw new Error(`Runtime dependency is not a regular file: ${reference}`);
  return actual;
}

function validateMotion(motion, parameterIds, motionPath) {
  const meta = motion?.Meta;
  if (!meta || typeof meta !== 'object' || !Array.isArray(motion.Curves)) throw new Error(`Invalid motion3 structure: ${motionPath}`);
  if (typeof meta.Duration !== 'number' || !Number.isFinite(meta.Duration) || meta.Duration <= 0) throw new Error(`Motion Duration must be positive: ${motionPath}`);
  if (typeof meta.Fps !== 'number' || !Number.isFinite(meta.Fps) || meta.Fps <= 0 || meta.Fps > 240) throw new Error(`Motion Fps must be in (0, 240]: ${motionPath}`);
  if (meta.Loop !== true) throw new Error(`Idle motion must declare Meta.Loop=true: ${motionPath}`);
  if (meta.CurveCount !== motion.Curves.length) throw new Error(`Motion CurveCount does not match Curves: ${motionPath}`);
  for (const [index, curve] of motion.Curves.entries()) {
    if (!['Parameter', 'PartOpacity'].includes(curve?.Target) || typeof curve.Id !== 'string' || !Array.isArray(curve.Segments)) {
      throw new Error(`Invalid motion curve at index ${index}: ${motionPath}`);
    }
    if (curve.Target === 'Parameter') {
      if (!parameterIds) {
        throw new Error('Cannot validate motion parameter IDs: export-status.json.parameterIds or referenced CDI3 Parameters[].Id metadata is required.');
      }
      if (!parameterIds.has(curve.Id)) throw new Error(`Motion references unknown parameter ${curve.Id}: ${motionPath}`);
    }
    if (curve.Segments.length < 2 || curve.Segments.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new Error(`Invalid curve segment data at index ${index}: ${motionPath}`);
    }
    const firstTime = curve.Segments[0];
    if (firstTime < 0 || firstTime > meta.Duration) throw new Error(`Curve starts outside motion duration: ${motionPath}`);
    let previous = firstTime;
    let offset = 2;
    while (offset < curve.Segments.length) {
      const kind = curve.Segments[offset];
      const width = kind === 1 ? 7 : [0, 2, 3].includes(kind) ? 3 : 0;
      if (!width || offset + width > curve.Segments.length) throw new Error(`Invalid curve segment encoding at index ${index}: ${motionPath}`);
      const time = curve.Segments[offset + width - 2];
      if (time < previous || time > meta.Duration) throw new Error(`Curve key times are not ordered/in duration: ${motionPath}`);
      previous = time;
      offset += width;
    }
  }
  for (const key of ['TotalSegmentCount', 'TotalPointCount']) {
    if (meta[key] != null && (!Number.isFinite(meta[key]) || meta[key] < 0)) throw new Error(`Invalid ${key}: ${motionPath}`);
  }
}

async function readParameterIds(sourceRoot, status, model) {
  const ids = new Set();
  const statusIds = status?.parameterIds;
  if (Array.isArray(statusIds)) {
    for (const id of statusIds) if (typeof id === 'string' && id) ids.add(id);
  } else if (statusIds && typeof statusIds === 'object') {
    for (const id of Object.values(statusIds)) if (typeof id === 'string' && id) ids.add(id);
  }

  const displayInfo = model?.FileReferences?.DisplayInfo;
  if (typeof displayInfo === 'string' && displayInfo.toLowerCase().endsWith('.cdi3.json')) {
    const cdiPath = await safeSourceFile(sourceRoot, displayInfo);
    const cdi = await readJson(cdiPath);
    for (const entry of cdi?.Parameters ?? []) {
      if (typeof entry?.Id === 'string' && entry.Id) ids.add(entry.Id);
    }
  }
  return ids.size ? ids : null;
}

async function copyAsset(sourcePath, outputRoot, relativeName) {
  const destination = resolve(outputRoot, relativeName);
  if (!inside(outputRoot, destination)) throw new Error(`Destination path escapes runtime directory: ${relativeName}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
  const bytes = await readFile(destination);
  return { file: relativeName.split(sep).join('/'), sha256: sha256(bytes), bytes: bytes.length };
}

function minimalPreset(name, modelId) {
  return {
    Version: 1,
    Name: name,
    ModelID: modelId,
    FileReferences: { Icon: '', Model: 'model.model3.json', IdleAnimation: '', IdleAnimationWhenTrackingLost: '' },
    Hotkeys: [],
    ParameterSettings: [],
  };
}

export async function packageVts(options) {
  const sourceRoot = await realpath(resolve(options['--export']));
  const outputRoot = resolve(options['--output']);
  if (inside(sourceRoot, outputRoot) || inside(outputRoot, sourceRoot)) throw new Error('Output and export directories must not overlap.');
  try { await lstat(outputRoot); throw new Error(`Output already exists; refusing to overwrite: ${outputRoot}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const modelPath = join(sourceRoot, 'model.model3.json');
  const modelBytes = await readFile(modelPath);
  const model = JSON.parse(modelBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const statusPath = join(sourceRoot, 'export-status.json');
  let status = null;
  try { status = await readJson(statusPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const meta = exportMetadata(status);
  const references = gatherReferences(model);
  const parameterIds = await readParameterIds(sourceRoot, status, model);
  const fingerprint = createHash('sha256');
  fingerprint.update('VTuberTailor-runtime-export-v1\0');
  fingerprint.update('model.model3.json\0');
  fingerprint.update(modelBytes);
  for (const { file } of [...references].sort((a, b) => a.file.localeCompare(b.file))) {
    const sourceFile = await safeSourceFile(sourceRoot, file);
    fingerprint.update('\0');
    fingerprint.update(file.replaceAll('\\', '/'));
    fingerprint.update('\0');
    fingerprint.update(await readFile(sourceFile));
  }
  meta.sourceFingerprint ??= fingerprint.digest('hex');
  if (options['--qa-report']) {
    const qaPath = resolve(options['--qa-report']);
    const qaInfo = await stat(qaPath);
    if (!qaInfo.isFile()) throw new Error('--qa-report must be a JSON file (for example .../native-report.json), not a directory');
    const qa = await readJson(qaPath);
    const qaStatus = qa.status ?? qa.result ?? qa.outcome;
    const qaFingerprint = qa.sourceFingerprint ?? qa.exportFingerprint ?? qa.fingerprint;
    if (qaStatus !== 'passed' || qaFingerprint !== meta.sourceFingerprint) {
      throw new Error('QA report must have status "passed" and exactly match this export fingerprint.');
    }
  }
  const presetBytes = options['--preset'] ? await readFile(resolve(options['--preset'])) : null;
  const preset = presetBytes
    ? JSON.parse(presetBytes.toString('utf8').replace(/^\uFEFF/, ''))
    : minimalPreset(options['--name'], randomUUID().replaceAll('-', ''));
  if (!preset.FileReferences || typeof preset.FileReferences !== 'object') throw new Error('Preset must contain a FileReferences object.');
  const modelId = randomUUID().replaceAll('-', '');
  preset.Name = options['--name'];
  preset.ModelID = modelId;
  preset.FileReferences = { ...preset.FileReferences, Model: 'model.model3.json' };
  const files = [];
  await mkdir(outputRoot, { recursive: false });
  try {
    const seen = new Set();
    for (const { file } of references) {
      if (seen.has(file)) continue;
      seen.add(file);
      const sourceFile = await safeSourceFile(sourceRoot, file);
      files.push(await copyAsset(sourceFile, outputRoot, file));
    }
    if (options['--icon']) {
      const iconPath = resolve(options['--icon']);
      const iconExt = extname(iconPath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg'].includes(iconExt)) throw new Error('--icon must be a PNG or JPEG file.');
      const iconInfo = await lstat(iconPath);
      if (!iconInfo.isFile()) throw new Error('--icon must be a regular file.');
      const iconName = `icon${iconExt === '.jpeg' ? '.jpg' : iconExt}`;
      files.push(await copyAsset(iconPath, outputRoot, iconName));
      preset.FileReferences = { ...preset.FileReferences, Icon: iconName };
    }
    const addMotion = async (flag) => {
      const motionPath = options[flag];
      if (!motionPath) return;
      const bytes = await readFile(resolve(motionPath));
      const motion = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      validateMotion(motion, parameterIds, motionPath);
      const packageName = flag === '--idle' ? 'idle.motion3.json' : 'idle-lost.motion3.json';
      files.push(await copyAsset(resolve(motionPath), outputRoot, packageName));
      const presetReference = flag === '--idle' ? 'IdleAnimation' : 'IdleAnimationWhenTrackingLost';
      preset.FileReferences[presetReference] = packageName;
      return { presetReference, curves: motion.Curves.length, duration: motion.Meta.Duration, loop: motion.Meta.Loop };
    };
    const idle = await addMotion('--idle');
    const idleLost = await addMotion('--idle-lost');
    // model3 may have optional fields; preserve all existing content, changing only supplied motion refs.
    const modelOutput = jsonBytes(model);
    await writeFile(join(outputRoot, 'model.model3.json'), modelOutput, { flag: 'wx' });
    files.push({ file: 'model.model3.json', sha256: sha256(modelOutput), bytes: modelOutput.length });
    const presetOutput = jsonBytes(preset);
    await writeFile(join(outputRoot, 'model.vtube.json'), presetOutput, { flag: 'wx' });
    files.push({ file: 'model.vtube.json', sha256: sha256(presetOutput), bytes: presetOutput.length });
    const receipt = {
      schemaVersion: 1,
      modelName: preset.Name,
      modelId,
      sourceExport: sourceRoot,
      sourceRevision: meta.sourceRevision,
      sourceFingerprint: meta.sourceFingerprint,
      sourceModelSha256: sha256(modelBytes),
      sourcePresetSha256: presetBytes ? sha256(presetBytes) : null,
      presetSource: presetBytes ? basename(resolve(options['--preset'])) : null,
      presetSettingsPreserved: Boolean(presetBytes),
      trackingMappingsConfigured: presetBytes ? Array.isArray(preset.ParameterSettings) && preset.ParameterSettings.length > 0 : false,
      trackingMappingStatus: presetBytes ? 'preserved-from-preset' : 'not-configured',
      runtimeReferences: references.map(({ file, label }) => ({ file, label })),
      runtimeFiles: files,
      idleMotion: idle ?? null,
      idleLostMotion: idleLost ?? null,
      qa: options['--qa-report'] ? { report: resolve(options['--qa-report']), status: 'passed', matchedFingerprint: true } : { status: 'not-provided' },
      installed: false,
      vtsLaunched: false,
      visualVtsVerified: false,
    };
    const receiptBytes = jsonBytes(receipt);
    await writeFile(join(outputRoot, 'package-provenance.json'), receiptBytes, { flag: 'wx' });
    return receipt;
  } catch (error) {
    // Do not leave a partial runtime package that looks deliverable.
    const { rm } = await import('node:fs/promises');
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n\n${HELP}`); process.exitCode = 2; return; }
  if (options.help) { console.log(HELP); return; }
  try {
    const receipt = await packageVts(options);
    console.log(JSON.stringify({ output: resolve(options['--output']), modelName: receipt.modelName, modelId: receipt.modelId, runtimeFiles: receipt.runtimeFiles.length, trackingMappingStatus: receipt.trackingMappingStatus, qa: receipt.qa.status }, null, 2));
  } catch (error) { console.error(`package-vts failed: ${error.message}`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
