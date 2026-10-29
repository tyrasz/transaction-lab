// Preparation only. These controls never invoke ethereumjsObservation, a VM,
// Geth, or the freeze/dispatch entry points.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDS, SYSTEM_SCAFFOLDING, declaration } from './cases.mjs';
import { declaration as originalDeclaration } from './cases-before-system-scaffolding.mjs';
import { sha, save, sourcePaths } from './archive.mjs';
import { LIMITS, SCOPE, validTime, validProcess, validProcessBounds, rawBytes, observation, scanOutput, OutputBoundsError, compare, readSealedObservation } from './run.mjs';
const clone = v => structuredClone(v);
const pack = value => { const b = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); return { bytes: b.length, sha256: sha(b), base64: b.toString('base64') }; };
const processRaw = () => ({ process: { status: 0, signal: null, error: null, timeoutMs: 15000, wallElapsedMs: 2, elapsedMs: 2 }, stdout: pack({ fabricated: true }), stderr: pack('') });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'amsterdam-diagnostic-preparation-'));
const q = n => '0x' + BigInt(n).toString(16), ZERO32 = '0x' + '00'.repeat(32), ZERO_BLOOM = '0x' + '00'.repeat(256);
async function sample() {
  const input = await declaration(0);
  // Deliberately fabricated expected values: tests exercise binding/classifier,
  // not the outcomes of either fixed diagnostic transaction.
  const expected = { id: input.id, transactionHash: input.transactionHash, initialStateRoot: input.initialStateRoot,
    stateRoot: ZERO32, execution: { logsHash: ZERO32 }, receipt: { status: 1 }, gas: { totalGasSpent: '15000', txRegularGas: '15000', txStateGas: '0' } };
  const receipt = { type: '0x2', blockNumber: input.environment.currentNumber, transactionHash: input.transactionHash, transactionIndex: '0x0', status: '0x1',
    gasUsed: q(15000), cumulativeGasUsed: q(15000), logs: [], logsBloom: ZERO_BLOOM };
  const outputs = { result: { stateRoot: ZERO32, logsHash: ZERO32, receipts: [receipt], gasUsed: q(15000), logsBloom: ZERO_BLOOM,
    currentBaseFee: '0x7', currentDifficulty: null, requests: [], blobGasUsed: '0x0' }, body: input.transactionBody, allocation: clone(input.allocation) };
  return { input, expected, outputs, raw: processRaw() };
}
test('fixed two signed declarations preserve every original field and disclose exactly four STOP rows', async () => {
  assert.deepEqual(IDS, ['stop_baseline', 'post_target_call_oog']);
  for (let i = 0; i < IDS.length; i++) {
    const input = await declaration(i), before = await originalDeclaration(i);
    assert.equal(input.id, before.id); assert.equal(input.chainId, 11155111); assert.equal(input.fork, 'Amsterdam');
    for (const key of ['sender', 'transaction', 'signedBytes', 'transactionHash', 'transactionBody', 'environment']) assert.deepEqual(input[key], before[key]);
    assert.deepEqual(input.originalAllocation, before.allocation); assert.equal(input.originalStateRoot, before.initialStateRoot);
    assert.notEqual(input.initialStateRoot, input.originalStateRoot);
    const additions = Object.keys(input.allocation).filter(k => !Object.hasOwn(before.allocation, k)); assert.deepEqual(additions.sort(), [...SYSTEM_SCAFFOLDING].sort());
    for (const [address, row] of Object.entries(before.allocation)) assert.deepEqual(input.allocation[address], row);
    for (const address of SYSTEM_SCAFFOLDING) assert.deepEqual(input.allocation[address], { nonce: '0x1', balance: '0x0', code: '0x00', storage: {} });
  }
  assert.equal(SCOPE.canonicalConsensusEstablished, false); assert.equal(SCOPE.finalNegativeStateGasTested, false);
  assert.equal(SCOPE.automaticExecutionPathEquivalenceClaimed, false);
});
test('fabricated bound result matches all five named fields and separates block dimensions from scalar gas', async () => {
  const { input, expected, raw, outputs } = await sample();
  assert.equal(compare(input, expected, raw, outputs).status, 'matched');
  expected.gas.blockGasSpent = '999999'; assert.equal(compare(input, expected, raw, outputs).status, 'matched');
  expected.gas.txStateGas = '16000'; assert.equal(compare(input, expected, raw, outputs).channels.blockGas, false);
});
test('valid disagreements remain mismatched, malformed/rejected/unbound evidence never matches', async () => {
  const { input, expected, raw, outputs } = await sample();
  for (const mutate of [o => { o.result.stateRoot = '0x' + '11'.repeat(32); }, o => { o.result.logsHash = '0x' + '22'.repeat(32); },
    o => { o.result.receipts[0].status = '0x0'; }, o => { o.result.receipts[0].gasUsed = o.result.receipts[0].cumulativeGasUsed = q(15001); }, o => { o.result.gasUsed = q(15001); }]) {
    const o = clone(outputs); mutate(o); assert.equal(compare(input, expected, raw, o).status, 'mismatched');
  }
  for (const mutate of [o => { o.body = '0x'; }, o => { o.result.receipts = []; }, o => { o.result.receipts[0].transactionHash = ZERO32; },
    o => { o.result.receipts[0].type = '0x4'; }, o => { o.result.receipts[0].blockNumber = '0x1'; }, o => { o.result.rejected = [{ index: 0, error: 'rejected' }]; },
    o => { o.result.requests = ['0x01']; }, o => { o.allocation[SYSTEM_SCAFFOLDING[0]].code = '0x01'; }, o => { o.result.gasUsed = 15000; }, o => { o.result.currentDifficulty = '0x0'; }]) {
    const o = clone(outputs); mutate(o); assert.equal(compare(input, expected, raw, o).status, 'unavailable');
  }
});
test('clean process identity, exact raw bytes and fatal UTF8 decoding are required for observations', () => {
  const raw = processRaw(); assert.deepEqual(observation(raw), { fabricated: true });
  for (const patch of [{ status: 1 }, { signal: 'SIGKILL' }, { error: { code: 'X' } }]) assert.equal(validProcess({ ...raw, process: { ...raw.process, ...patch } }), false);
  for (const patch of [{ bytes: raw.stdout.bytes + 1 }, { sha256: '0'.repeat(64) }, { base64: raw.stdout.base64 + '!' }]) assert.throws(() => rawBytes({ ...raw.stdout, ...patch }));
  const invalid = Buffer.from([255]); assert.throws(() => observation({ ...raw, stdout: { bytes: 1, sha256: sha(invalid), base64: invalid.toString('base64') } }));
});
test('individual and aggregate process/time bounds fail closed including late successful close', () => {
  const raw = processRaw(); assert(validProcessBounds(raw));
  for (const patch of [{ timeoutMs: 0 }, { timeoutMs: 15001 }, { elapsedMs: 15001 }, { wallElapsedMs: -1 }, { wallElapsedMs: Infinity }, { error: { code: 'ENOBUFS' } }]) assert.equal(validProcessBounds({ ...raw, process: { ...raw.process, ...patch } }), false);
  assert.equal(validProcessBounds({ ...raw, stdout: { ...raw.stdout, bytes: LIMITS.processBytes + 1 } }), false);
  assert(validTime(60000, 60000, LIMITS.totalMs)); assert(!validTime(60001, 3, LIMITS.totalMs)); assert(!validTime(1, NaN, LIMITS.totalMs));
});
test('file stat bounds retain all observed metadata before any oversized body can be read', () => {
  const dir = temp();
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), '{}'); assert.equal(scanOutput(dir, 0).totalBytes, 2);
    assert.throws(() => scanOutput(dir, LIMITS.totalOutputBytes), error => error instanceof OutputBoundsError && error.totalBytes === LIMITS.totalOutputBytes + 2);
    const fd = fs.openSync(path.join(dir, 'oversize.json'), 'wx'); fs.ftruncateSync(fd, LIMITS.outputFileBytes + 1); fs.closeSync(fd);
    assert.throws(() => scanOutput(dir, 0), error => error instanceof OutputBoundsError && error.files.length === 2 && error.totalBytes === LIMITS.outputFileBytes + 3);
    fs.unlinkSync(path.join(dir, 'oversize.json')); fs.symlinkSync('a.json', path.join(dir, 'link'));
    assert.throws(() => scanOutput(dir, 0), OutputBoundsError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('durable observation seal rejects later byte substitution', () => {
  const dir = temp();
  try { const id = save(path.join(dir, 'o.json'), processRaw()); save(path.join(dir, 'o.json.seal.json'), { ...id, at: 'synthetic' });
    assert.equal(sha(readSealedObservation(dir, 'o.json').bytes), id.sha256);
    fs.appendFileSync(path.join(dir, 'o.json'), ' '); assert.throws(() => readSealedObservation(dir, 'o.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('declared source closure contains both dependency trees, original inputs and protocol parser sources', () => {
  const root = path.resolve(import.meta.dirname, '../..'), paths = sourcePaths(root);
  assert(paths.includes('engines/local-evm/ethereum-state-gas.js')); assert(paths.includes('engines/fixture-evm/state-test.js'));
  assert(paths.includes('research/amsterdam-state-gas-diagnostic-v031/cases-before-system-scaffolding.mjs'));
  assert(paths.some(p => p.startsWith('engines/local-evm/node_modules/'))); assert(paths.some(p => p.startsWith('engines/fixture-evm/node_modules/')));
  assert(!paths.some(p => p.includes('/capture/'))); assert.equal(new Set(paths).size, paths.length);
});
