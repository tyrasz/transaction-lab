// Artifact-only supplement: no producer imports, subprocesses or EVM execution.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const CAPTURE_MANIFEST_SHA = 'df41304fda31c7fe06112352efb79b0734dc00c4fd9c09c08072f6985746cdd1';
const hash = b => createHash('sha256').update(b).digest('hex');
const parse = b => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
const quantity = v => { assert.equal(typeof v, 'string'); assert.match(v, /^0x[0-9a-f]+$/i); return BigInt(v); };
const hash32 = v => { assert.match(v, /^0x[0-9a-f]{64}$/); return v; };
export function savedChannels(input, count, expected, result, body) {
  assert.equal(body, input.prefixBodies[count - 1]);
  assert.equal(result.receipts.length, count);
  assert(result.rejected === undefined || Array.isArray(result.rejected) && result.rejected.length === 0);
  assert.equal(expected.steps.length, input.requests.length);
  const end = expected.steps[count - 1];
  const channels = { stateRoot: hash32(result.stateRoot) === hash32(end.stateRoot), logsHash: hash32(result.logsHash) === hash32(end.logsHash), gas: quantity(result.gasUsed) === BigInt(end.cumulativeGasUsed), receiptStatus: true };
  for (let i = 0; i < count; i++) {
    const r = result.receipts[i], e = expected.steps[i];
    assert.equal(e.status, 'derived');
    assert.equal(r.transactionHash, input.signed[i].hash);
    assert.equal(quantity(r.transactionIndex), BigInt(i));
    assert.equal(quantity(r.type), 2n);
    assert([0n, 1n].includes(quantity(r.status)));
    assert.deepEqual(r.logs, []); // These declared products emit no committed logs.
    channels.gas &&= quantity(r.gasUsed) === BigInt(e.gasUsed) && quantity(r.cumulativeGasUsed) === BigInt(e.cumulativeGasUsed);
    channels.receiptStatus &&= (quantity(r.status) === 1n) === (e.execution.status === 'success');
  }
  return channels;
}
export function diagnose(capture) {
  const manifestBytes = fs.readFileSync(path.join(capture, 'manifest.json'));
  assert.equal(hash(manifestBytes), CAPTURE_MANIFEST_SHA);
  const manifest = parse(manifestBytes), entries = new Map(manifest.files.map(f => [f.path, f]));
  const read = p => { const f = entries.get(p); assert.equal(f?.kind, 'file'); const b = fs.readFileSync(path.join(capture, p)); assert.equal(b.length, f.bytes); assert.equal(hash(b), f.sha256); return b; };
  const json = p => parse(read(p));
  const rawResult = p => { const raw = json(p); assert.equal(raw.process.status, 0); assert.equal(raw.process.signal, null); assert.equal(raw.process.error, null); for (const stream of [raw.stdout, raw.stderr]) { const b = Buffer.from(stream.base64, 'base64'); assert.equal(b.toString('base64'), stream.base64); assert.equal(b.length, stream.bytes); assert.equal(hash(b), stream.sha256); } return raw; };
  const plan = json('plan.json'), original = json('results.json'), rows = [];
  for (let i = 0; i < plan.declarations.length; i++) {
    const base = String(i + 1).padStart(3, '0'), input = json(`inputs/${base}.json`);
    const expectedPath = `expectations/${base}.json`, expectedRaw = rawResult(expectedPath), seal = json(expectedPath + '.seal.json');
    assert.equal(hash(read(expectedPath)), seal.sha256); assert.equal(read(expectedPath).length, seal.bytes);
    const expected = parse(Buffer.from(expectedRaw.stdout.base64, 'base64'));
    assert.deepEqual(expected, expectedRaw.result); assert.equal(expected.id, input.id);
    for (let count = 1; count <= input.requests.length; count++) {
      const prefix = `geth/${base}-${String(count).padStart(2, '0')}`, raw = rawResult(prefix + '-process.json');
      const channels = savedChannels(input, count, expected, json(prefix + '/result.json'), json(prefix + '/body.rlp'));
      const emptyTraceFiles = input.signed.slice(0, count).map((tx, j) => `${prefix}/trace-${j}-${tx.hash}.json`).filter(p => read(p).length === 0);
      const stderr = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw.stderr.base64, 'base64'));
      const tracerFailureCount = stderr.split('incorrect number of top-level calls').length - 1;
      assert.equal(tracerFailureCount, count - 1); assert.equal(emptyTraceFiles.length, count - 1);
      rows.push({ id: input.id, prefix: count, originalStatus: original.rows.find(r => r.id === input.id && r.prefix === count).status, channels, rootReturnAvailableForWholePrefix: emptyTraceFiles.length === 0, emptyTraceFiles, tracerFailureCount, transactionCount: count, processExit: raw.process.status, stateRoot: json(prefix + '/result.json').stateRoot });
    }
  }
  assert.equal(rows.length, 15);
  return { schemaVersion: 1, scope: 'post_capture_artifact_only_diagnostic_not_reclassification', captureManifestSha256: CAPTURE_MANIFEST_SHA, originalCounts: original.counts, noExecution: true, independentClientExecution: 'previously_saved_geth_only', originalOutcomeUnchanged: true, rows, totals: { prefixes: rows.length, transactionReceipts: rows.reduce((n, r) => n + r.transactionCount, 0), fourChannelAgreements: rows.filter(r => Object.values(r.channels).every(Boolean)).length, emptyTraceFiles: rows.reduce((n, r) => n + r.emptyTraceFiles.length, 0), originalWholePrefixReturnAvailable: rows.filter(r => r.rootReturnAvailableForWholePrefix).length } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(diagnose(path.join(path.dirname(fileURLToPath(import.meta.url)), 'capture')), null, 2));
