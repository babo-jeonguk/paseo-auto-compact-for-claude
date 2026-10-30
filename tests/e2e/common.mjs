// Helpers shared by the E2E scripts: options, the installed plugin and its
// GitHub revision, and the plugin's own stderr in daemon logs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export const PLUGIN = 'auto-compact-for-claude';
export const SOURCE = 'git:babo-jeonguk/paseo-auto-compact-for-claude';

// `--name value` pairs over `defaults`. Options in `required` ([name, hint]) have
// no default and are shown first by `--help`, which prints usage and exits.
export function parseOptions(script, defaults, required = []) {
  const options = new Map(defaults);
  if (process.argv.includes('--help')) {
    const named = required.map(([name, hint]) => `${name} <${hint}> `).join('');
    const rest = [...options].filter(([name]) => !required.some(([r]) => r === name))
      .map(([name, value]) => `[${name} ${value || '<path>'}]`).join(' ');
    console.log(`node --no-maglev tests/e2e/${script} ${named}${rest}`);
    process.exit(0);
  }
  for (let i = 2; i < process.argv.length; i += 2) {
    assert(options.has(process.argv[i]), `Unknown option: ${process.argv[i]}`);
    assert(process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--'), `Missing value: ${process.argv[i]}`);
    options.set(process.argv[i], process.argv[i + 1]);
  }
  for (const [name, hint] of required) assert(options.get(name), `Specify ${name} with ${hint} (see README.md)`);
  return name => options.get(name);
}

export async function installedPlugin(fixture) {
  const listed = JSON.parse(await fixture.paseo('plugin', 'ls', PLUGIN, '--json'));
  return Array.isArray(listed) ? listed.find(p => p.id === PLUGIN) ?? listed[0] : listed;
}
export const revisionOf = info => info?.installation?.currentRevision ?? info?.commit ?? info?.revision ?? '';

// The commit GitHub resolves `ref` to, or null for a non-GitHub source.
export async function remoteRevision(source, ref) {
  if (!source.startsWith('git:')) return null;
  const { stdout } = await promisify(execFile)('git', ['ls-remote', `https://github.com/${source.slice(4)}.git`, ref, `${ref}^{}`],
    { windowsHide: true, timeout: 60_000, cwd: tmpdir() });
  const rows = stdout.trim().split('\n').filter(Boolean).map(line => line.split('\t'));
  return (rows.find(([, name]) => name.endsWith('^{}')) ?? rows[0])?.[0] ?? null;
}

// The plugin's own stderr: its console.error reports and Paseo's load/hook failures for it.
export async function pluginStderr(paths) {
  return (await Promise.all(paths.map(path => readFile(path, 'utf8').catch(() => '')))).join('\n')
    .split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(entry => entry.pluginId === PLUGIN && entry.stream === 'stderr').map(entry => String(entry.message));
}
