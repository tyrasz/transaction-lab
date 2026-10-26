import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { verify } from './verify.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));

async function isolated(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transaction-lab-pilot-baseline-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.copyFile(path.join(here, 'archive-manifest.json'), path.join(directory, 'archive-manifest.json'));
  await fs.cp(path.join(here, 'repository'), path.join(directory, 'repository'), { recursive: true });
  return directory;
}

test('unchanged pilot audit reproduces from a separate temporary archive without live sources', async t => {
  const result = await verify({ directory: await isolated(t) });
  assert.equal(result.verified, true);
  assert.equal(result.sourceFiles, 34);
  assert.equal(result.originalPilotFiles, 14);
  assert.equal(result.retainedBytes, 1400139);
  assert.equal(result.originalAuditResult.counts.rpc, 39);
  assert.equal(result.originalAuditResult.reportStatus, 'enumeration_inconclusive');
});

test('changed archived source fails before running the original audit', async t => {
  const directory = await isolated(t);
  const filename = path.join(directory, 'repository/src/config.js');
  await fs.chmod(filename, 0o600); await fs.appendFile(filename, '\n// synthetic mutation\n');
  await assert.rejects(verify({ directory }), /src\/config.js/);
});

test('missing original evidence cannot be supplied from the live repository', async t => {
  const directory = await isolated(t);
  await fs.unlink(path.join(directory, 'repository/reports/coverage-evaluation-v2/2026-10-26T07-52-08.304Z-60177bf2/rpc.json'));
  await assert.rejects(verify({ directory }), /ENOENT/);
});
