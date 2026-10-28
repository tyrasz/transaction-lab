import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInputFacts } from '../input-facts.js';
import { createRpcStateInputs } from '../rpc-state-inputs.js';
import { proofFixture, A, B, C, word } from './proof-fixture.js';

async function fixture() {
  const root = await proofFixture({ requested: [] }), blockHash = word(999);
  const inputs = createRpcStateInputs({ chainId: 1, blockHash,
    header: { hash: blockHash, stateRoot: root.input.stateRoot, number: '0x123' },
    rpc: { async call(method, params) {
      const f = await proofFixture({ address: params[0], requested: method === 'eth_getProof' ? params[1] : [] });
      return method === 'eth_getProof' ? f.input.proof : f.input.code;
    } },
  });
  await inputs.getStorage(A, word(0)); // Account proof itself carries a slot.
  await inputs.getStorage(A, word(2)); // A separate proof establishes zero.
  await inputs.getCode(B);
  await inputs.getStorage(C, word(8)); // First absent proof explicitly requests a slot.
  await inputs.getStorage(C, word(9)); // Another zero follows the same exclusion.
  return { inputs: inputs.snapshotInputs(), inputEvidence: inputs.snapshotEvidence(), stateRoot: root.input.stateRoot };
}
const invalid = promise => assert.rejects(promise);

test('initial facts reconstruct exact existing, missing-slot and absent-account provenance', async () => {
  const f = await fixture(), cache = new Map(); let checks = 0;
  assert.equal(await validateInputFacts({ ...f, cache, check: () => checks++ }), true);
  assert(checks > 10);
  assert.equal(await validateInputFacts({ ...f, cache }), true);
  assert.deepEqual(f.inputs.accounts[C], { exists: false });
  assert.equal(f.inputs.accounts[A].storage[word(2)], word(0));
  assert.equal(f.inputs.accounts[A].storage[word(1)], undefined);
});

test('coordinated normalized account and provenance substitutions cannot replace the actual proof', async () => {
  const original = await fixture();
  for (const mutate of [
    f => { f.inputs.accounts[A].nonce = '0'; f.inputs.provenance[0].accountProof.nonceRaw = '0'; },
    f => { f.inputs.accounts[A].balance = '0'; f.inputs.provenance[0].accountProof.balanceRaw = '0'; },
    f => { f.inputs.accounts[A].code = '0x'; },
    f => { f.inputs.accounts[C] = { exists: true, nonce: '0', balance: '0', code: '0x', storage: {} }; },
    f => { f.inputs.provenance.find(row => row.account === C).accountProof.exists = true; },
    f => { delete f.inputs.accounts[A]; },
    f => { f.inputs.accounts[word(7).slice(0, 42)] = { exists: false }; },
  ]) { const f = structuredClone(original); mutate(f); await invalid(validateInputFacts(f)); }
});

test('proof and code IDs bind method, address, ordered keys and exact canonical selector', async () => {
  const original = await fixture();
  for (const mutate of [
    f => { f.inputs.provenance[0].proofEvidenceId = 2; },
    f => { f.inputs.provenance[0].codeEvidenceId = 5; },
    f => { f.inputEvidence[0].request.params[0] = B; },
    f => { f.inputEvidence[0].request.params[1] = [word(1)]; },
    f => { f.inputEvidence[0].request.params[2] = { blockHash: word(998), requireCanonical: true }; },
    f => { f.inputEvidence[1].request.params[1].requireCanonical = false; },
    f => { f.inputEvidence[0].verification = 'rejected'; },
    f => { delete f.inputEvidence[0].result; },
    f => { f.stateRoot = word(1); f.inputs.context.stateRoot = word(1); },
    f => { f.inputEvidence[0].result.accountProof = []; },
  ]) { const f = structuredClone(original); mutate(f); await invalid(validateInputFacts(f)); }
});

test('storage facts cannot substitute values, existence, evidence, keys or initial requested inventory', async () => {
  const original = await fixture();
  for (const mutate of [
    f => { f.inputs.accounts[A].storage[word(0)] = word(8); f.inputs.provenance[0].storage[0].value = word(8); },
    f => { f.inputs.provenance[0].storage[1].exists = true; },
    f => { f.inputs.provenance[0].storage[1].evidenceId = 1; },
    f => { f.inputs.provenance[0].storage[1].key = word(1); },
    f => { f.inputs.provenance[0].storage.push({ ...f.inputs.provenance[0].storage[0] }); },
    f => { f.inputs.provenance[0].storage.shift(); delete f.inputs.accounts[A].storage[word(0)]; },
    f => { f.inputs.provenance.find(row => row.account === C).storage[1].value = word(1); },
    f => { f.inputs.provenance.find(row => row.account === C).storage[1].evidenceId = 1; },
  ]) { const f = structuredClone(original); mutate(f); await invalid(validateInputFacts(f)); }
});

test('failed incomplete loads remain empty facts instead of becoming zero accounts', async () => {
  const f = await fixture();
  const empty = { ...f, inputs: { ...f.inputs, status: 'unavailable', accounts: {}, provenance: [], failure: { code: 'RPC_STATE_INPUT_UNAVAILABLE', message: 'Pinned read failed.' } } };
  assert.equal(await validateInputFacts(empty), true);
  empty.inputs.accounts[C] = { exists: false };
  await invalid(validateInputFacts(empty));
});

test('cached results cannot authorize a changed proof or code and external cache entries are ignored', async () => {
  const f = await fixture(), cache = new Map([['forged', { status: 'verified' }]]);
  await validateInputFacts({ ...f, cache });
  const changed = structuredClone(f); changed.inputEvidence[1].result = '0x600200';
  await invalid(validateInputFacts({ ...changed, cache }));
  const proof = structuredClone(f); proof.inputEvidence[0].result.balance = '0x0';
  await invalid(validateInputFacts({ ...proof, cache }));
});

test('parent cancellation is checked across proof awaits and input mutation cannot race verification', async () => {
  const f = await fixture(); let count = 0;
  const cancelled = Object.assign(new Error('parent deadline'), { code: 'DEADLINE' });
  await assert.rejects(validateInputFacts({ ...f, check() { if (++count === 4) throw cancelled; } }), error => error === cancelled);
  const original = structuredClone(f);
  const promise = validateInputFacts(f);
  f.inputs.accounts[A].nonce = '0'; f.inputEvidence[0].result.accountProof = [];
  assert.equal(await promise, true, 'the validated packet was detached before its first await');
  await invalid(validateInputFacts(f));
  assert.equal(await validateInputFacts(original), true);
});

test('descriptors, proxies and malformed provenance cannot invoke caller input traps', async () => {
  const f = await fixture(); let traps = 0;
  const options = { ...f }; Object.defineProperty(options, 'inputs', { enumerable: true, get() { traps++; return f.inputs; } });
  await invalid(validateInputFacts(options));
  const proxy = new Proxy(f.inputs, { getPrototypeOf() { traps++; return Object.prototype; } });
  await invalid(validateInputFacts({ ...f, inputs: proxy }));
  const nested = structuredClone(f); Object.defineProperty(nested.inputs.provenance[0], 'account', { enumerable: true, get() { traps++; return A; } });
  await invalid(validateInputFacts(nested));
  const custom = structuredClone(f); Object.setPrototypeOf(custom.inputs.provenance, {}); await invalid(validateInputFacts(custom));
  assert.equal(traps, 0);
});
