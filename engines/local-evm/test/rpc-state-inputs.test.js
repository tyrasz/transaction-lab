import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRpcStateInputs, RPC_STATE_INPUT_LIMITS } from '../rpc-state-inputs.js';
import { proofFixture, A, B, C, word } from './proof-fixture.js';

const BLOCK = word(999);
async function fixture({ change, limits, now } = {}) {
  const root = await proofFixture({ requested: [] }), records = [];
  const header = { hash: BLOCK, stateRoot: root.input.stateRoot, number: '0x123' };
  const rpc = { async call(method, params) {
    records.push({ method, params: structuredClone(params) });
    assert.ok(['eth_getProof', 'eth_getCode'].includes(method));
    assert.deepEqual(params.at(-1), { blockHash: BLOCK, requireCanonical: true });
    const result = await proofFixture({ address: params[0], requested: method === 'eth_getProof' ? params[1] : [] });
    let value = method === 'eth_getProof' ? result.input.proof : result.input.code;
    if (change) value = await change({ method, params, value, records });
    return value;
  } };
  const options = { chainId: 1, blockHash: BLOCK, header, rpc, ...(limits ? { limits } : {}), ...(now ? { now } : {}) };
  return { inputs: createRpcStateInputs(options), options, records };
}

test('lazy collection uses only canonical proof/code reads and preserves exact proven zero versus unknown slots', async () => {
  const h = await fixture(); assert.equal(h.records.length, 0);
  const account = await h.inputs.getAccount(A); assert.equal(account.exists, true); assert.equal(account.nonceRaw, '3'); assert.equal(account.balanceRaw, '123456789');
  assert.equal(await h.inputs.getCode(A), '0x600100'); assert.equal(h.records.length, 2);
  assert.deepEqual(h.inputs.snapshotInputs().accounts[A].storage, {});
  assert.equal(await h.inputs.getStorage(A, word(0)), word(7));
  assert.equal(await h.inputs.getStorage(A, word(2)), word(0));
  assert.equal(await h.inputs.getStorage(A, word(1)), word((1n << 255n) + 1n));
  assert.deepEqual(h.records.map(row => row.method), ['eth_getProof', 'eth_getCode', 'eth_getProof', 'eth_getProof', 'eth_getProof']);
  assert.equal(h.inputs.snapshotInputs().accounts[A].storage[word(3)], undefined);
  const evidence = h.inputs.snapshotEvidence(); assert.ok(evidence.every(row => row.verification === 'verified'));
  assert.ok(evidence.every(row => row.representation === 'parsed_rpc_result_not_wire_bytes'));
  assert.deepEqual(JSON.parse(evidence[0].requestText), h.records[0]);
  evidence[0].result.balance = '0x0'; account.balanceRaw = '0';
  assert.equal((await h.inputs.getAccount(A)).balanceRaw, '123456789'); assert.notEqual(h.inputs.snapshotEvidence()[0].result.balance, '0x0');
});

test('first storage demand collects only that slot; concurrent demands cannot duplicate provider reads', async () => {
  const h = await fixture();
  assert.deepEqual(await Promise.all([h.inputs.getStorage(A, word(0)), h.inputs.getStorage(A, word(0)), h.inputs.getCode(A)]), [word(7), word(7), '0x600100']);
  assert.equal(h.records.length, 2); assert.deepEqual(h.records[0].params[1], [word(0)]);
  assert.equal(h.inputs.snapshotUsage().slots, 1);
});

test('account nonexistence is proven, and its empty code/storage are not inferred from missing data', async () => {
  const h = await fixture(); assert.equal((await h.inputs.getAccount(C)).exists, false);
  assert.equal(await h.inputs.getStorage(C, word(0)), word(0)); assert.equal(await h.inputs.getCode(C), '0x');
  assert.equal(h.records.length, 1); assert.deepEqual(h.inputs.snapshotInputs().accounts[C], { exists: false });
  assert.equal((await h.inputs.getAccount(B)).exists, true);
  assert.equal(await h.inputs.getStorage(B, word(7)), word(0));
  const absent = await fixture({ change: ({ method, value }) => method === 'eth_getProof' ? null : value });
  await assert.rejects(absent.inputs.getAccount(C), { code: 'RPC_STATE_INPUT_INVALID_PROOF' });
  assert.deepEqual(absent.inputs.snapshotInputs().accounts, {});
});

test('invalid proof/code or missing storage fails closed with no retries and no trace-derived repair', async () => {
  for (const change of [
    ({ method, value }) => { if (method === 'eth_getProof') value.balance = '0x0'; return value; },
    ({ method, value }) => method === 'eth_getCode' ? '0x600200' : value,
    ({ method, value }) => { if (method === 'eth_getProof') value.accountProof = []; return value; },
  ]) {
    const h = await fixture({ change }); await assert.rejects(h.inputs.getAccount(A), { code: 'RPC_STATE_INPUT_INVALID_PROOF' });
    const before = h.records.length; await assert.rejects(h.inputs.getAccount(A)); await assert.rejects(h.inputs.getAccount(B));
    assert.equal(h.records.length, before); assert.equal(h.inputs.snapshotInputs().status, 'unavailable'); assert.deepEqual(h.inputs.snapshotInputs().accounts, {});
    assert.ok(h.inputs.snapshotEvidence().filter(row => row.verification === 'rejected').every(row => !Object.hasOwn(row, 'result')));
  }
  const h = await fixture({ change: ({ method, params, value }) => { if (method === 'eth_getProof' && params[1].length) value.storageProof = []; return value; } });
  await h.inputs.getAccount(A); await assert.rejects(h.inputs.getStorage(A, word(0)), { code: 'RPC_STATE_INPUT_INVALID_PROOF' });
  assert.equal(h.inputs.snapshotInputs().accounts[A].storage[word(0)], undefined);
});

test('provider exceptions are sanitized; timeout completion cannot mutate evidence or facts later', async () => {
  const failed = await fixture({ change() { throw new Error('https://private.example/secret'); } });
  await assert.rejects(failed.inputs.getAccount(A), { code: 'RPC_STATE_INPUT_UNAVAILABLE' });
  assert.doesNotMatch(JSON.stringify(failed.inputs.snapshotEvidence()), /private|secret/);
  let release; const result = new Promise(resolve => { release = resolve; });
  const h = await fixture({ limits: { requestMs: 10 }, change: ({ value }) => result.then(() => value) });
  await assert.rejects(h.inputs.getAccount(A), { code: 'RPC_STATE_INPUT_TIMEOUT' });
  const snapshot = h.inputs.snapshotEvidence(); release(); await delay(20);
  assert.deepEqual(h.inputs.snapshotEvidence(), snapshot); assert.deepEqual(h.inputs.snapshotInputs().accounts, {});
});

test('budgets include calls, slots, accounts, read count, result bytes and wall time without raising defaults', async () => {
  for (const [limits, first, second] of [
    [{ calls: 1 }, null, h => h.inputs.getAccount(A)],
    [{ accounts: 1 }, h => h.inputs.getAccount(A), h => h.inputs.getAccount(B)],
    [{ slots: 1 }, h => h.inputs.getStorage(A, word(0)), h => h.inputs.getStorage(A, word(1))],
    [{ reads: 1 }, h => h.inputs.getAccount(A), h => h.inputs.getAccount(A)],
    [{ responseBytes: 1 }, null, h => h.inputs.getAccount(A)],
    [{ totalBytes: 1 }, null, h => h.inputs.getAccount(A)],
  ]) {
    const h = await fixture({ limits }); if (first) await first(h);
    await assert.rejects(second(h), { code: 'RPC_STATE_INPUT_LIMIT' });
    const before = h.records.length; await assert.rejects(h.inputs.getCode(A)); assert.equal(h.records.length, before);
  }
  let time = 0; const h = await fixture({ now: () => time, limits: { wallMs: 10 } });
  await h.inputs.getAccount(A); time = 11; await assert.rejects(h.inputs.getCode(A), { code: 'RPC_STATE_INPUT_LIMIT' });
  for (const [key, max] of Object.entries(RPC_STATE_INPUT_LIMITS)) assert.throws(() => createRpcStateInputs({ ...h.options, limits: { [key]: max + 1 } }), { code: 'RPC_STATE_INPUT_INVALID' });
});

test('trace, poststate, overrides and mismatched header inputs are rejected before any reads', async () => {
  const h = await fixture();
  for (const key of ['trace', 'prestate', 'poststate', 'stateOverrides', 'expectedBalances', 'accounts']) assert.throws(() => createRpcStateInputs({ ...h.options, [key]: {} }), { code: 'RPC_STATE_INPUT_INVALID' });
  assert.throws(() => createRpcStateInputs({ ...h.options, header: { ...h.options.header, hash: word(99) } }), { code: 'RPC_STATE_INPUT_INVALID' });
  assert.throws(() => createRpcStateInputs({ ...h.options, header: { hash: BLOCK } }), { code: 'RPC_STATE_INPUT_INVALID' });
  assert.equal(h.records.length, 0);
  h.options.header.stateRoot = word(9999);
  assert.equal((await h.inputs.getAccount(A)).exists, true, 'External header mutation cannot change the pinned input context.');
});
