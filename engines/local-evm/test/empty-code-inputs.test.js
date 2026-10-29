import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { EMPTY_CODE_HASH } from '../verified-state-proof.js';
import { proofFixture, A, B, C, word } from './proof-fixture.js';

async function fixture({ code = '0x', change, limits, rejectCode = true } = {}) {
  const initial = await proofFixture({ code, requested: [] }), calls = [], blockHash = word(999);
  const inputs = createRpcStateInputs({ chainId: 11155111, blockHash,
    header: { hash: blockHash, stateRoot: initial.input.stateRoot, number: '0x123' }, ...(limits ? { limits } : {}),
    rpc: { async call(method, params) {
      calls.push({ method, params: structuredClone(params) });
      assert.deepEqual(params.at(-1), { blockHash, requireCanonical: true });
      assert(['eth_getProof', 'eth_getCode'].includes(method));
      if (method === 'eth_getCode' && rejectCode) throw Error('Code transport deliberately unavailable');
      const f = await proofFixture({ code, address: params[0], requested: method === 'eth_getProof' ? params[1] : [] });
      const result = method === 'eth_getProof' ? f.input.proof : f.input.code;
      return change ? change({ method, result }) : result;
    } } });
  return { inputs, calls };
}

test('an empty-code commitment establishes exact code while nonempty storage remains separately proven', async () => {
  const { inputs, calls } = await fixture();
  const account = await inputs.getAccount(A);
  assert.equal(account.exists, true); assert.equal(account.nonceRaw, '3');
  assert.equal(account.balanceRaw, '123456789'); assert.equal(account.codeHash, EMPTY_CODE_HASH);
  assert.equal(await inputs.getCode(A), '0x');
  assert.deepEqual(inputs.snapshotInputs().accounts[A].storage, {});
  assert.equal(await inputs.getStorage(A, word(0)), word(7));
  assert.equal(await inputs.getStorage(A, word(1)), word((1n << 255n) + 1n));
  assert.equal(inputs.snapshotInputs().accounts[A].storage[word(2)], undefined);
  assert.deepEqual(calls.map(r => r.method), ['eth_getProof', 'eth_getProof', 'eth_getProof']);
  const provenance = inputs.snapshotInputs().provenance[0];
  assert.equal(provenance.codeEvidenceId, null);
  assert.equal(provenance.codeDerivation, 'verified_account_empty_code_hash');
  assert.equal(provenance.proofEvidenceId, 1);
  assert.equal(inputs.snapshotUsage().calls, 3);
  assert(inputs.snapshotEvidence().every(e => e.status === 'received' && e.verification === 'verified'));
});

test('account exclusion proves empty code and demanded zeros with either canonical absent-hash representation', async () => {
  for (const zeroSentinels of [false, true]) {
    const { inputs, calls } = await fixture({ change: ({ result }) => {
      if (zeroSentinels) { result.codeHash = word(0); result.storageHash = word(0); }
      return result;
    } });
    assert.equal(await inputs.getStorage(C, word(8)), word(0));
    assert.equal((await inputs.getAccount(C)).exists, false);
    assert.equal(await inputs.getCode(C), '0x');
    assert.equal(await inputs.getStorage(C, word(9)), word(0));
    assert.equal(calls.length, 1);
    assert.deepEqual(inputs.snapshotInputs().accounts[C], { exists: false });
    const p = inputs.snapshotInputs().provenance[0];
    assert.equal(p.codeDerivation, 'verified_account_absence'); assert.equal(p.codeEvidenceId, null);
    assert.equal(p.accountProof.codeHash, EMPTY_CODE_HASH);
    assert.deepEqual(p.storage.map(s => s.evidenceId), [1, 1]);
  }
});

test('a first storage demand and concurrent code/account reads share one genuine empty-code proof', async () => {
  const { inputs, calls } = await fixture();
  const [stored, code, account] = await Promise.all([inputs.getStorage(A, word(0)), inputs.getCode(A), inputs.getAccount(A)]);
  assert.equal(stored, word(7)); assert.equal(code, '0x'); assert.equal(account.exists, true);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].params[1], [word(0)]);
  assert.equal(inputs.snapshotEvidence().length, 1);
  const p = inputs.snapshotInputs(); p.provenance[0].codeDerivation = 'invented'; p.accounts[A].code = '0x01';
  assert.equal(await inputs.getCode(A), '0x');
  assert.equal(inputs.snapshotInputs().provenance[0].codeDerivation, 'verified_account_empty_code_hash');
});

test('missing or altered proofs cannot turn claimed empty code into an accepted account', async () => {
  for (const mutate of [
    r => null, r => ({ ...r, accountProof: [] }), r => ({ ...r, balance: '0x0' }),
    r => ({ ...r, codeHash: word(0) }), r => ({ ...r, codeHash: word(1) }),
  ]) {
    const { inputs, calls } = await fixture({ change: ({ result }) => mutate(result) });
    await assert.rejects(inputs.getCode(A), { code: 'RPC_STATE_INPUT_INVALID_PROOF' });
    assert.deepEqual(inputs.snapshotInputs().accounts, {});
    assert.equal(inputs.snapshotEvidence()[0].verification, 'rejected');
    assert.equal(Object.hasOwn(inputs.snapshotEvidence()[0], 'result'), false);
    await assert.rejects(inputs.getAccount(B)); assert.equal(calls.length, 1);
  }
  const { inputs, calls } = await fixture({ code: '0x600100', change: ({ result }) => ({ ...result, codeHash: EMPTY_CODE_HASH }) });
  await assert.rejects(inputs.getCode(A), { code: 'RPC_STATE_INPUT_INVALID_PROOF' });
  assert.equal(calls.length, 1); assert.deepEqual(inputs.snapshotInputs().accounts, {});
});

test('nonempty code still requires its real hash-checked read and cannot fall back after a transport failure', async () => {
  for (const rejectCode of [false, true]) {
    const { inputs, calls } = await fixture({ code: '0x600100', rejectCode });
    if (rejectCode) {
      await assert.rejects(inputs.getCode(A), { code: 'RPC_STATE_INPUT_UNAVAILABLE' });
      assert.deepEqual(inputs.snapshotInputs().accounts, {});
      await assert.rejects(inputs.getAccount(B));
    } else {
      assert.equal(await inputs.getCode(A), '0x600100');
      const p = inputs.snapshotInputs().provenance[0];
      assert.equal(p.codeEvidenceId, 2); assert.equal(Object.hasOwn(p, 'codeDerivation'), false);
    }
    assert.deepEqual(calls.map(r => r.method), ['eth_getProof', 'eth_getCode']);
  }
  const f = await fixture({ code: '0x600100', rejectCode: false, change: ({ method, result }) => method === 'eth_getCode' ? '0x' : result });
  await assert.rejects(f.inputs.getCode(A), { code: 'RPC_STATE_INPUT_INVALID_PROOF' });
  assert.deepEqual(f.inputs.snapshotInputs().accounts, {});
});

test('proof-derived code consumes real RPC/account budgets without a synthetic evidence row', async () => {
  const empty = await fixture({ limits: { calls: 1 } });
  assert.equal(await empty.inputs.getCode(A), '0x');
  await assert.rejects(empty.inputs.getCode(B), { code: 'RPC_STATE_INPUT_LIMIT' });
  assert.equal(empty.calls.length, 1); assert.equal(empty.inputs.snapshotUsage().accounts, 1);
  const code = await fixture({ code: '0x600100', limits: { calls: 1 }, rejectCode: false });
  await assert.rejects(code.inputs.getCode(A), { code: 'RPC_STATE_INPUT_LIMIT' });
  assert.deepEqual(code.inputs.snapshotInputs().accounts, {}); assert.equal(code.calls.length, 1);
});
