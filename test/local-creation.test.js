import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateLocal, validateLocalSimulation } from '../src/local-simulation.js';
import { ProofRpcClient } from '../src/proof-rpc.js';
import { lifecycleFixture, initcode, createdAddress, RUNTIME, FACTORY, SENDER, word } from '../engines/local-evm/test/lifecycle-fixture.js';

// Real API adapter, bounded proof transport and child execution, with declared
// synthetic authenticated state. These controls are not public-chain samples.
const target = createdAddress({ creator: SENDER, nonce: 1n });
const query = { to: FACTORY, data: '0x70a08231' + target.slice(2).padStart(64, '0') };
async function fixture({ data = '0x' + initcode(), finalMismatch = false, missingTarget = false } = {}) {
  const f = await lifecycleFixture({ code: '0x602a60005260206000f3' }), wire = [];
  const input = { chainId: 1, from: SENDER, to: null, data, value: '5', block: f.header.hash, queries: [query] };
  const rpc = new ProofRpcClient({ url: 'https://fixture.invalid', fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); wire.push(request); let result;
    if (request.method === 'eth_chainId') result = '0x1';
    else if (request.method === 'eth_getBlockByHash') result = f.header;
    else if (request.method === 'eth_getBlockByNumber') result = finalMismatch ? { ...f.header, size: '0x123456' } : f.header;
    else {
      if (missingTarget && request.params[0] === target) throw new Error('missing synthetic target proof');
      result = await f.rpc.call(request.method, request.params);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  } });
  return { input, rpc, wire, header: f.header };
}

test('public API admits only explicit null CREATE, rejects blob creation and preserves access-list occurrences', () => {
  const input = { chainId: 1, from: SENDER, to: null, data: '0x', queries: [query] };
  const accessList = [{ address: target, storageKeys: [word(0), word(0)] }, { address: target, storageKeys: [] }];
  assert.equal(validateLocalSimulation(input).to, null);
  assert.deepEqual(validateLocalSimulation({ ...input, accessList }).accessList, accessList);
  for (const change of [{ to: undefined }, { to: '' }, { salt: word(1) }, { blobVersionedHashes: ['0x01' + '11'.repeat(31)] }]) {
    assert.throws(() => validateLocalSimulation({ ...input, ...change }));
  }
});

test('actual API returns proof-backed root deployment and keeps disposable getter queries independent', async () => {
  const f = await fixture(), result = await simulateLocal(f.input, f.rpc);
  assert.equal(result.status, 'complete'); assert.equal(result.execution.status, 'success');
  assert.equal(result.apiRequest.to, null); assert.equal(result.source.canonicalStatus, 'verified');
  const original = result.attempt.preview.original, created = original.changes.accounts.find(row => row.address === target);
  assert.equal(original.output.trace.type, 'CREATE'); assert.equal(original.output.trace.to, target);
  assert.deepEqual(created.existence, { before: false, after: true, basis: 'top_level_contract_creation' });
  assert.deepEqual(created.code, { before: '0x', after: '0x' + RUNTIME });
  assert.deepEqual(created.balance, { before: '0x0', after: '0x5' });
  assert.deepEqual(created.storage, [{ slot: word(0), before: word(0), after: word(42) }]);
  assert.equal(original.output.profile.operation, 'create');
  assert.equal(result.measurements[0].values[0].deltaRaw, '0');
  assert.equal(result.measurements[0].identity.account, target);
  assert.deepEqual(result.attempt.preview.measurements[0].after.changesBefore, original.changes);
  assert.equal(result.attempt.broker.pendingAtReturn, 0);
  assert.equal(f.wire.at(-1).method, 'eth_getBlockByNumber');
});

test('constructor revert leaves only the sender nonce and honest unchanged getter pair', async () => {
  const f = await fixture({ data: '0x602a60005560006000fd' }), result = await simulateLocal(f.input, f.rpc);
  assert.equal(result.status, 'complete'); assert.equal(result.execution.status, 'reverted');
  assert.equal(result.attempt.preview.original.output.trace.to, target);
  assert.deepEqual(result.attempt.preview.original.changes.accounts, [{ address: SENDER, nonce: { before: '0x1', after: '0x2' } }]);
  assert.equal(result.measurements[0].values[0].deltaRaw, '0');
});

test('new contract getter is unavailable before deployment instead of inventing a zero balance', async () => {
  const f = await fixture(); f.input.queries = [{ ...query, to: target }];
  const result = await simulateLocal(f.input, f.rpc);
  assert.equal(result.status, 'partial'); assert.equal(result.execution.status, 'success');
  assert.equal(result.measurements[0].status, 'unavailable'); assert.equal(result.measurements[0].values, null);
  assert.equal(result.attempt.preview.measurements[0].before.values, null);
  assert.equal(result.attempt.preview.measurements[0].after, null);
});

test('missing deployment proof never retains deployment effects or measurements', async () => {
  const f = await fixture({ missingTarget: true }), result = await simulateLocal(f.input, f.rpc);
  assert.equal(result.execution.status, 'unavailable');
  assert.equal(result.measurements.some(row => row.status === 'measured'), false);
  const original = result.attempt.preview?.original ?? result.audit?.original;
  if (original) assert.deepEqual(original.changes.accounts, []);
});

test('full final-header mismatch withholds otherwise successful deployment measurements', async () => {
  const f = await fixture({ finalMismatch: true }), result = await simulateLocal(f.input, f.rpc);
  assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'LOCAL_PREVIEW_CANONICAL');
  assert.equal(result.execution.status, 'unavailable'); assert.deepEqual(result.measurements, []);
  assert.equal(result.attempt.preview, null); assert.equal(result.source.canonicalStatus, 'unverified');
});
