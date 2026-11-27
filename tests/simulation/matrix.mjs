import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paseoPackages } from './paseo-versions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--paseo'))
  throw new Error('Use a version-specific test:simulation script to select one Paseo version');

const stableVersions = [...paseoPackages.keys()].filter(version => !version.includes('-'));
for (const paseo of stableVersions) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-maglev', join(here, 'run.mjs'),
      '--paseo', paseo, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() :
      reject(new Error(`Paseo ${paseo} simulation ${signal ? `received ${signal}` : `exited ${code}`}`)));
  });
}
