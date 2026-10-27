import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrestateInputs, intrinsicCallGas } from '../prestate-inputs.js';

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
const H = '0x' + '33'.repeat(32), WORD = '0x' + '00'.repeat(32);
function fixture() {
  const envelope = { from: A, to: B, data: '0x000100ff', value: '0x0', gas: '0x186a0' };
  const pinned = { blockHash: H, requireCanonical: true };
  return {
    prestate: { [A]: { nonce: 1, balance: '0x1', code: '0x' }, [B]: { nonce: 1, balance: '0x0', code: '0x00', storage: { [WORD]: WORD } } },
    completionReads: [], envelope, pinned,
    header: { hash: H, parentHash: WORD, number: '0x10', timestamp: '0x20', gasLimit: '0x2dc6c0', baseFeePerGas: '0x5f5e100', mixHash: WORD, miner: '0x' + '00'.repeat(20) },
    prestateRequest: { method: 'debug_traceCall', params: [structuredClone(envelope), structuredClone(pinned), { tracer: 'prestateTracer', timeout: '15s', tracerConfig: { diffMode: false, disableCode: false, disableStorage: false, includeEmpty: true } }] },
  };
}
const invalid = fn => assert.throws(fn, error => error.code === 'LOCAL_INPUT_PACKET_INVALID');

test('message budget is derived from declared calldata and gas alone, with separate actual and synthetic base fee', () => {
  assert.equal(intrinsicCallGas('0x'), 21000n);
  assert.equal(intrinsicCallGas('0x000100ff'), 21040n);
  const inputs = buildPrestateInputs(fixture());
  assert.equal(inputs.request.gasLimit, '78960');
  assert.equal(inputs.profile.intrinsicGas, '21040');
  assert.equal(inputs.profile.actualBlockBaseFee, '100000000');
  assert.equal(inputs.block.baseFeePerGas, '0');
  assert.equal(inputs.profile.expectedOutputsUsed, false);
});

test('omitted account code requires its own observed completion at the exact canonical hash', () => {
  const f = fixture(); delete f.prestate[A].code;
  invalid(() => buildPrestateInputs(f));
  const completion = { address: A, field: 'code', request: { method: 'eth_getCode', params: [A, structuredClone(f.pinned)] }, result: '0x' };
  f.completionReads = [completion];
  assert.equal(buildPrestateInputs(f).accounts[A].code, '0x');
  completion.request.params[1].requireCanonical = false;
  invalid(() => buildPrestateInputs(f));
});

test('duplicate, unused and malformed completion facts are never used to repair inputs', () => {
  const f = fixture();
  const read = { address: A, field: 'nonce', request: { method: 'eth_getTransactionCount', params: [A, f.pinned] }, result: '0x1' };
  f.completionReads = [read]; invalid(() => buildPrestateInputs(f));
  delete f.prestate[A].nonce;
  f.completionReads.push(read); invalid(() => buildPrestateInputs(f));
  f.completionReads.pop(); read.result = '-1'; invalid(() => buildPrestateInputs(f));
  read.result = '0x1'; read.request.method = 'eth_getBalance'; invalid(() => buildPrestateInputs(f));
});

test('absent storage remains sparse while all-zero account existence stays unresolved', () => {
  const f = fixture(); delete f.prestate[B].storage;
  f.prestate[A] = { nonce: 0, balance: '0x0', code: '0x' };
  const inputs = buildPrestateInputs(f);
  assert.deepEqual(inputs.accounts[B].storage, {});
  assert.equal(Object.hasOwn(inputs.accounts, A), false);
  assert.equal(inputs.unresolvedAccounts[0].reason, 'empty_account_existence_unproven');
});

test('diff mode, disabled storage/code and hidden overrides cannot masquerade as input state', () => {
  for (const mutate of [
    f => f.prestateRequest.params[2].tracerConfig.diffMode = true,
    f => f.prestateRequest.params[2].tracerConfig.disableStorage = true,
    f => f.prestateRequest.params[2].tracerConfig.disableCode = true,
    f => f.prestateRequest.params[2].stateOverrides = {},
    f => f.prestateRequest.params[2].blockOverrides = { baseFee: '0x0' },
    f => f.prestateRequest.params[0].from = B,
    f => f.prestate = { pre: f.prestate, post: {} },
  ]) { const f = fixture(); mutate(f); invalid(() => buildPrestateInputs(f)); }
});

test('unrecognized envelope semantics and insufficient intrinsic gas reject before execution', () => {
  for (const mutate of [
    f => f.envelope.gasPrice = '0x0',
    f => f.envelope.accessList = [],
    f => f.envelope.value = '1',
    f => f.envelope.gas = '0x5208',
    f => f.envelope.gas = '5000001',
    f => f.envelope.data = '0x0',
    f => f.header.hash = WORD,
  ]) { const f = fixture(); mutate(f); invalid(() => buildPrestateInputs(f)); }
});

test('malformed explicit fields and duplicate slot representations remain invalid rather than completed', () => {
  for (const mutate of [
    f => f.prestate[A].balance = null,
    f => f.prestate[A].code = [],
    f => f.prestate[A].nonce = (1n << 64n).toString(),
    f => f.prestate[B].storage[WORD] = '0x1',
    f => f.prestate[B].unknown = '0x0',
  ]) { const f = fixture(); mutate(f); invalid(() => buildPrestateInputs(f)); }
});

test('post-execution channels cannot influence this input-only conversion', () => {
  const f = fixture(), original = buildPrestateInputs(f);
  f.expectedTrace = { output: '0xdead', gasUsed: '1' };
  f.expectedDiff = { post: { [A]: { balance: '0xffff' } } };
  assert.deepEqual(buildPrestateInputs(f), original);
});
