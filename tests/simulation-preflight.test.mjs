import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('simulation cannot report another operating system as tested or count unrun cases as passed', async () => {
  const reportDir = await mkdtemp(join(tmpdir(), 'compact-preflight-'));
  let report;
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'simulation/run.mjs');
    const expected = process.platform === 'win32' ? 'linux' : 'win32';
    await assert.rejects(promisify(execFile)(process.execPath, [file, '--expect-platform', expected,
      '--report-dir', reportDir], { timeout: 15_000, windowsHide: true }), error => error.code === 1);
    report = JSON.parse(await readFile(join(reportDir, 'report.json'), 'utf8'));
    assert.equal(report.platform, process.platform);
    assert.equal(report.result, 'failed');
    assert.match(report.error, /Native OS mismatch/);
    assert(report.checks.every(check => check.result === 'not-run'));
    assert.deepEqual(report.requests, []);
    assert.match(await readFile(join(reportDir, 'junit.xml'), 'utf8'), /<failure>/);
  } finally {
    if (report?.root && dirname(report.root) === tmpdir()) await rm(report.root, { recursive: true, force: true });
    await rm(reportDir, { recursive: true, force: true });
  }
});
