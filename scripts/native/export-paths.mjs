import { isAbsolute, relative, resolve, sep } from 'node:path';

export function assertRecordedMocPath(status, exportDir, mocPath) {
  if (!Object.hasOwn(status, 'moc3')) return;
  if (typeof status.moc3 !== 'string' || !status.moc3 ||
      (Object.hasOwn(status, 'outputDirectory') && (typeof status.outputDirectory !== 'string' || !status.outputDirectory))) {
    throw new Error('export-status MOC path disagrees with model.model3.json.');
  }
  // The recorded root describes metadata only; the verifier reads the moved export.
  const recordedRoot = resolve(status.outputDirectory || exportDir);
  const recordedRelative = relative(recordedRoot, resolve(recordedRoot, status.moc3));
  const actualRelative = relative(resolve(exportDir), resolve(mocPath));
  const samePath = process.platform === 'win32'
    ? recordedRelative.toLowerCase() === actualRelative.toLowerCase()
    : recordedRelative === actualRelative;
  if (!recordedRelative || isAbsolute(recordedRelative) || recordedRelative === '..' ||
      recordedRelative.startsWith(`..${sep}`) || !samePath) {
    throw new Error('export-status MOC path disagrees with model.model3.json.');
  }
}
