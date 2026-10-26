import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--paseo'))
  throw new Error('Use test:simulation:0.12 or test:simulation:0.13 to select one Paseo version');

for (const paseo of ['0.12.0', '0.13.0']) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-maglev', join(here, 'run.mjs'),
      '--paseo', paseo, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() :
      reject(new Error(`Paseo ${paseo} simulation ${signal ? `received ${signal}` : `exited ${code}`}`)));
  });
}
