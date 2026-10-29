import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from './verify.mjs';
import { nativeRow, parsePhase, feeAccounting } from './checks.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const capture = path.join(root, 'research/native-balance-v029/capture');
const read = p => JSON.parse(fs.readFileSync(path.join(capture, p)));

test('artifact-only verification re-proves the six cases and twenty native pairs without executing EVM', async () => {
  const r = await verify();
  assert.equal(r.cases, 6); assert.equal(r.nativePairs, 20); assert.equal(r.proofCalls, 21); assert.equal(r.inputRecords, 42);
  assert.equal(r.scope.evmExecuted, false); assert.equal(r.scope.independentClient, false);
});
test('capture byte tampering rejects against the unchanged external seal', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'native-audit-'));
  try {
    fs.cpSync(capture, temporary, { recursive: true });
    fs.appendFileSync(path.join(temporary, 'inputs/001.json'), ' ');
    await assert.rejects(verify({ root, capture: temporary }));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('parsed result cannot diverge from retained stdout and failed processes cannot supply results', () => {
  const phase = read('results/001-product.json'); assert.equal(parsePhase(phase).id, 'fee_transfer_unused_accounts');
  const altered = structuredClone(phase); altered.result.id = 'different'; assert.throws(() => parsePhase(altered));
  const failed = structuredClone(phase); failed.process.status = 1; assert.throws(() => parsePhase(failed));
  failed.result = null; assert.equal(parsePhase(failed), null);
  const raw = structuredClone(phase); raw.stdout.base64 = Buffer.from('{}').toString('base64'); assert.throws(() => parsePhase(raw));
});
test('native amount, unit, account and state-mutation tampering are rejected', () => {
  const input = read('inputs/001.json'), p = read('results/001-product.json').result.attempt.preview;
  const query = input.queries[1], honest = p.measurements[1], args = [query, 9n, 132n, p.original.changes];
  assert.doesNotThrow(() => nativeRow(honest, ...args));
  for (const mutate of [
    r => { r.values[0].afterRaw = '133'; r.values[0].deltaRaw = '124'; },
    r => { r.values[0].unit.scale = '1000000'; },
    r => { r.identity.account = input.request.from; },
    r => { r.after.output = p.original.output; },
    r => { r.after.changesAfter.accounts = []; },
  ]) { const row = structuredClone(honest); mutate(row); assert.throws(() => nativeRow(row, ...args)); }
});
test('fee arithmetic independently rejects altered execution charge, blob burn and refund', () => {
  for (const id of ['001', '004']) {
    const input = read(`inputs/${id}.json`), output = read(`results/${id}-product.json`).result.attempt.preview.original.output;
    assert.doesNotThrow(() => feeAccounting(input, output));
    for (const name of ['gasCharge', 'senderRefund', ...(id === '004' ? ['blobFeeBurn', 'totalFeeCharge'] : [])]) {
      const changed = structuredClone(output); changed.feeAccounting[name] = String(BigInt(changed.feeAccounting[name]) + 1n);
      assert.throws(() => feeAccounting(input, changed));
    }
  }
});
