import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function engineModuleUrls(engineRoot, packageMain = 'dist/index.js') {
  const coreRoot = resolve(engineRoot, 'packages', 'core');
  const asFileUrl = (path) => pathToFileURL(resolve(path)).href;
  return {
    entry: asFileUrl(resolve(coreRoot, packageMain)),
    projectStore: asFileUrl(resolve(coreRoot, 'dist', 'project-store.js')),
    calibrationStore: asFileUrl(resolve(coreRoot, 'dist', 'calibration-store.js')),
  };
}
