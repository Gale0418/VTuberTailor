import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('explicit and default help work before resolving Node or running setup', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../scripts/tailor.ps1', import.meta.url));
  const pwsh = process.env.VTUBERTAILOR_PWSH || 'pwsh.exe';
  for (const args of [[], ['help'], ['setup', '--help']]) {
    const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-File', script, ...args], { encoding: 'utf8', windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^VTuberTailor\s/m, `missing help for ${JSON.stringify(args)}`);
    assert.match(result.stdout, /setup \[-NodePath/);
  }
});
