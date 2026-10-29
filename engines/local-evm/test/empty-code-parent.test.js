// Independent synthetic MPT packets, constructed without the RPC collector.
// No expected execution output or claimed worker verification authorizes facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { validateInputFacts } from '../input-facts.js';
import { executeIsolatedEthereumCall } from '../isolated-call.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { proofFixture, A, B, C, word } from './proof-fixture.js';
import { lifecycleFixture, SENDER, FACTORY } from './lifecycle-fixture.js';

const labels = { absent: 'verified_account_absence', empty: 'verified_account_empty_code_hash' };
const reject = promise => assert.rejects(promise, error => error.code === 'LOCAL_INPUT_FACTS_INVALID');
async function packet({ address = B, code = '0x', requested = [], later = [], legacy = false, gethAbsent = false, chainId = 1 } = {}) {
  const f = await proofFixture({ address, code, requested }), blockHash = word(9981);
  const selector = { blockHash, requireCanonical: true }, absent = address === C;
  const account = { exists: !absent, nonceRaw: address === A ? '3' : absent ? '0' : '1',
    balanceRaw: address === A ? '123456789' : absent ? '0' : '20',
    codeHash: f.input.proof.codeHash, storageRoot: f.input.proof.storageHash };
  if (gethAbsent) { assert(absent); f.input.proof.codeHash = word(0); f.input.proof.storageHash = word(0); }
  const inputEvidence = [];
  const evidence = (method, params, result) => {
    const id = inputEvidence.length + 1;
    inputEvidence.push({ id, status: 'received', verification: 'verified', request: { method, params }, result });
    return id;
  };
  const proofEvidenceId = evidence('eth_getProof', [address, requested, selector], f.input.proof);
  const item = { account: address, accountProof: account, proofEvidenceId, codeEvidenceId: null, storage: [] };
  if (legacy) item.codeEvidenceId = evidence('eth_getCode', [address, selector], f.input.code);
  else item.codeDerivation = absent ? labels.absent : labels.empty;
  const storage = {};
  const add = (key, id) => { const value = address === A ? (f.values.get(key) ?? 0n) : 0n;
    storage[key] = word(value); item.storage.push({ key, value: word(value), exists: value !== 0n, evidenceId: id }); };
  for (const key of requested) add(key, proofEvidenceId);
  for (const key of later) {
    if (absent) add(key, proofEvidenceId);
    else { const next = await proofFixture({ address, code, requested: [key] });
      assert.equal(next.input.stateRoot, f.input.stateRoot);
      add(key, evidence('eth_getProof', [address, [key], selector], next.input.proof)); }
  }
  return { stateRoot: f.input.stateRoot, chainId, inputEvidence,
    inputs: { context: { chainId, stateRoot: f.input.stateRoot, blockHash, selector },
      accounts: { [address]: absent ? { exists: false } : { exists: true, nonce: account.nonceRaw,
        balance: account.balanceRaw, code: f.input.code, storage } }, provenance: [item] } };
}

test('proof-only absent and existing-empty facts require no invented code evidence', async () => {
  for (const options of [{ address: C, later: [word(9)] }, { address: C, gethAbsent: true, requested: [word(8)] }, { address: B }]) {
    const f = await packet(options);
    assert.equal(f.inputEvidence.length, 1); assert.equal(f.inputs.provenance[0].codeEvidenceId, null);
    assert.equal(await validateInputFacts(f), true);
    assert.equal(f.inputs.provenance[0].accountProof.codeHash, EMPTY_CODE_HASH);
    assert.equal(f.inputs.provenance[0].accountProof.storageRoot, EMPTY_STORAGE_ROOT);
  }
});

test('empty-code account can retain hidden nonempty storage and separately authenticated slots', async () => {
  const hidden = await packet({ address: A });
  assert.notEqual(hidden.inputs.provenance[0].accountProof.storageRoot, EMPTY_STORAGE_ROOT);
  assert.deepEqual(hidden.inputs.accounts[A].storage, {});
  assert.equal(await validateInputFacts(hidden), true);
  const loaded = await packet({ address: A, requested: [word(0)], later: [word(2)] });
  assert.equal(loaded.inputEvidence.length, 2);
  assert(loaded.inputEvidence.every(row => row.request.method === 'eth_getProof'));
  assert.equal(loaded.inputs.accounts[A].storage[word(0)], word(7));
  assert.equal(loaded.inputs.accounts[A].storage[word(2)], word(0));
  assert.equal(loaded.inputs.accounts[A].storage[word(1)], undefined);
  assert.equal(await validateInputFacts(loaded), true);
  const forged = structuredClone(loaded);
  forged.inputs.accounts[A].storage[word(0)] = word(0); forged.inputs.provenance[0].storage[0].value = word(0);
  await reject(validateInputFacts(forged));
});

test('legacy later numeric code evidence remains accepted without a derivation key', async () => {
  for (const options of [{ address: A, code: '0x600100' }, { address: B }, { address: C, gethAbsent: true }]) {
    const f = await packet({ ...options, legacy: true });
    assert.equal(f.inputs.provenance[0].codeEvidenceId, 2);
    assert.equal(Object.hasOwn(f.inputs.provenance[0], 'codeDerivation'), false);
    assert.equal(await validateInputFacts(f), true);
  }
});

test('nonempty or corrupted proofs cannot be turned into empty runtime by coordinated claims', async () => {
  const nonempty = await packet({ address: A, code: '0x600100' });
  nonempty.inputs.accounts[A].code = '0x';
  nonempty.inputs.provenance[0].accountProof.codeHash = EMPTY_CODE_HASH;
  await reject(validateInputFacts(nonempty));
  const original = await packet({ address: B });
  for (const mutate of [
    f => { f.inputEvidence[0].result.accountProof = []; },
    f => { f.inputEvidence[0].result.accountProof[0] = '0xc0'; },
    f => { f.inputEvidence[0].result.balance = '0x15'; f.inputs.accounts[B].balance = '21'; f.inputs.provenance[0].accountProof.balanceRaw = '21'; },
    f => { f.inputEvidence[0].result.codeHash = word(0); },
    f => { f.inputEvidence[0].result.storageHash = word(0); },
    f => { f.inputs.accounts[B].code = '0x00'; },
    f => { f.inputs.provenance[0].accountProof.exists = false; f.inputs.accounts[B] = { exists: false }; f.inputs.provenance[0].codeDerivation = labels.absent; },
    f => { delete f.inputEvidence[0].result; },
    f => { f.inputEvidence[0].verification = 'rejected'; },
    f => { f.inputEvidence[0].status = 'unavailable'; },
  ]) { const f = structuredClone(original); mutate(f); await reject(validateInputFacts(f)); }
});

test('derived labels, null code IDs and exact provenance shapes are strict', async () => {
  const original = await packet();
  for (const mutate of [
    f => { f.inputs.provenance[0].codeDerivation = labels.absent; },
    f => { f.inputs.provenance[0].codeDerivation = null; },
    f => { f.inputs.provenance[0].codeDerivation = true; },
    f => { f.inputs.provenance[0].codeDerivation = 'empty'; },
    f => { f.inputs.provenance[0].codeDerivation = { toString: labels.empty }; },
    f => { f.inputs.provenance[0].codeEvidenceId = 1; },
    f => { f.inputs.provenance[0].codeEvidenceId = 'null'; },
    f => { delete f.inputs.provenance[0].codeEvidenceId; },
    f => { delete f.inputs.provenance[0].codeDerivation; },
    f => { f.inputs.provenance[0].extra = 'ignored'; },
  ]) { const f = structuredClone(original); mutate(f); await reject(validateInputFacts(f)); }
  const absent = await packet({ address: C }); absent.inputs.provenance[0].codeDerivation = labels.empty;
  await reject(validateInputFacts(absent));
  const legacy = await packet({ legacy: true }); legacy.inputs.provenance[0].codeDerivation = labels.empty;
  await reject(validateInputFacts(legacy));
});

test('derived proof IDs bind exact method, address, keys, selector and trusted network', async () => {
  const original = await packet();
  for (const mutate of [
    f => { f.inputs.provenance[0].proofEvidenceId = null; },
    f => { f.inputs.provenance[0].proofEvidenceId = '1'; },
    f => { f.inputs.provenance[0].proofEvidenceId = 0; },
    f => { f.inputs.provenance[0].proofEvidenceId = 2; },
    f => { f.inputEvidence[0].id = 2; },
    f => { f.inputEvidence[0].request.method = 'eth_getCode'; },
    f => { f.inputEvidence[0].request.params[0] = A; },
    f => { f.inputEvidence[0].request.params[1] = [word(1)]; },
    f => { f.inputEvidence[0].request.params[2].requireCanonical = false; },
    f => { f.inputEvidence[0].request.params[2].blockHash = word(8); },
    f => { f.inputs.context.chainId = 11155111; },
  ]) { const f = structuredClone(original); mutate(f); await reject(validateInputFacts(f)); }
  const sepolia = await packet({ chainId: 11155111 });
  assert.equal(await validateInputFacts(sepolia), true);
  await reject(validateInputFacts({ ...sepolia, chainId: 1 }));
});

test('cache never authorizes changed derivation, proof or explicit runtime claims', async () => {
  const f = await packet(), cache = new Map([['forged', { status: 'verified' }]]);
  assert.equal(await validateInputFacts({ ...f, cache }), true);
  assert.equal(await validateInputFacts({ ...f, cache }), true);
  for (const mutate of [
    g => { g.inputs.provenance[0].codeDerivation = labels.absent; },
    g => { g.inputEvidence[0].result.nonce = '0x2'; g.inputs.accounts[B].nonce = '2'; g.inputs.provenance[0].accountProof.nonceRaw = '2'; },
    g => { g.stateRoot = word(1); g.inputs.context.stateRoot = word(1); },
    g => { g.inputs.accounts[B].code = '0x00'; },
  ]) { const g = structuredClone(f); mutate(g); await reject(validateInputFacts({ ...g, cache })); }
});

test('derived provenance rejects accessors and snapshots input before proof awaits', async () => {
  const f = await packet(); let traps = 0;
  const hostile = structuredClone(f);
  Object.defineProperty(hostile.inputs.provenance[0], 'codeDerivation', { enumerable: true, get() { traps++; return labels.empty; } });
  await assert.rejects(validateInputFacts(hostile)); assert.equal(traps, 0);
  const good = structuredClone(f), pending = validateInputFacts(f);
  f.inputs.provenance[0].codeDerivation = labels.absent; f.inputEvidence[0].result.accountProof = [];
  assert.equal(await pending, true); await reject(validateInputFacts(f)); assert.equal(await validateInputFacts(good), true);
});

test('actual parent rejects a forged derived label from a real successful child', async t => {
  const f = await lifecycleFixture({ code: '0x00' }); f.request.value = '19';
  const fork = childProcess.fork; let intercepted = false;
  const mock = t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args), emit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message' && typeof values[0] === 'string') {
        const message = JSON.parse(values[0]);
        if (message.type === 'result') {
          assert.equal(message.result.output.execution.status, 'success');
          const sender = message.result.inputs.provenance.find(row => row.account === SENDER);
          assert.equal(sender.codeEvidenceId, null); assert.equal(sender.codeDerivation, labels.empty);
          sender.codeDerivation = labels.absent; intercepted = true; values[0] = JSON.stringify(message);
        }
      }
      return emit.call(this, event, ...values);
    };
    return child;
  });
  try {
    const result = await executeIsolatedEthereumCall({ request: f.request, header: f.header, rpc: f.rpc });
    assert.equal(intercepted, true); assert.equal(result.status, 'unavailable');
    assert.equal(result.error.code, 'LOCAL_ISOLATED_PROTOCOL'); assert.equal(result.output, null);
    assert.deepEqual(f.calls.filter(row => row.method === 'eth_getCode').map(row => row.params[0]), [FACTORY]);
  } finally { mock.mock.restore(); }
});
