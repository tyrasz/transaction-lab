// Fabricated parent-consistency regressions over independently reverified
// synthetic MPT proofs. No VM/client execution, captured observation, or
// independent-client agreement is claimed by these declared frame records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString, createContractAddress, createContractAddress2 } from '@ethereumjs/util';
import { validateInputFacts } from '../input-facts.js';
import { validateCreationAttempts } from '../creation-attempt-validation.js';
import { validateExecutionChanges, validateExecutionLifecycle } from '../execution-changes.js';
import { ethereumNetworkCommon } from '../ethereum-network.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { amsterdamExecutionFixture } from './amsterdam-execution-fixture.js';
import { feeFixture, TX_SENDER, TARGET, bytes, word } from './fee-fixture.js';

const scope = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const snapshot = accounts => ({ scope, accounts: accounts.sort((a, b) => a.address.localeCompare(b.address)) });
const callerNonce = { address: TX_SENDER, nonce: { before: '0x1', after: '0x2' } };
const salt = word(123), init = '0x00';
const rootTarget = createContractAddress(createAddressFromString(TX_SENDER), 1n).toString();
function targetOf(kind, creator = TARGET) {
  return kind === 'CREATE2'
    ? createContractAddress2(createAddressFromString(creator), bytes(salt), bytes(init)).toString()
    : createContractAddress(createAddressFromString(creator), 7n).toString();
}
const variants = {
  storage: { nonce: 0n, balance: 17n, code: '0x', storage: { [word(99)]: 9n, [word(991)]: 11n } },
  nonce: { nonce: 1n, balance: 17n, code: '0x', storage: { [word(991)]: 11n } },
  code: { nonce: 0n, balance: 17n, code: '0x00', storage: { [word(991)]: 11n } },
  empty: { nonce: 0n, balance: 17n, code: '0x' },
};
async function facts({ fork = 'amsterdam', variant = 'storage', target = rootTarget, creatorCode = '0x00' } = {}) {
  const options = { target: { nonce: 7n, balance: 1000n, code: creatorCode },
    accounts: variant === 'absent' ? {} : { [target]: variants[variant] } };
  const f = fork === 'amsterdam' ? await amsterdamExecutionFixture({ ...options, priced: false })
    : await feeFixture({ ...options, fork, baseFee: 0n, maxFee: 0n, priorityFee: 0n });
  delete f.request.executionProfile; delete f.request.fees;
  f.common ??= ethereumNetworkCommon(f.header);
  for (const account of [TX_SENDER, TARGET, target]) await f.inputs.getAccount(account);
  const inputs = f.inputs.snapshotInputs(), inputEvidence = f.inputs.snapshotEvidence();
  await validateInputFacts({ inputs, inputEvidence, stateRoot: f.header.stateRoot, chainId: Number(f.common.chainId()) });
  return { ...f, inputs, inputEvidence, target };
}
function frame(f, { type = 'CREATE', from = TX_SENDER, to = f.target, depth = 0,
  error = 'create collision', output = '0x', calls = [], attempts = [], input = init } = {}) {
  return { type, from, caller: from, to, executionAddress: to, value: '0x0', input,
    output, error, gas: '0x10000', gasUsed: error === null ? '0x1' : '0x10000', depth, calls,
    ...(f.common.isActivatedEIP(7928) ? { creationAttempts: attempts } : type === 'CREATE2' ? { creationSalt: salt } : {}) };
}
function rootPacket(f, success = false) {
  const trace = frame(f, { error: success ? null : 'create collision', output: success ? '0x00' : '0x' });
  const rows = [structuredClone(callerNonce)];
  if (success) rows.push({ address: f.target,
    ...(!f.inputs.accounts[f.target].exists ? { existence: { before: false, after: true, basis: 'top_level_contract_creation' } } : {}),
    nonce: { before: '0x0', after: '0x1' }, code: { before: '0x', after: '0x00' } });
  return { output: { execution: { status: success ? 'success' : 'failed', error: trace.error }, trace, logs: [] },
    inputs: f.inputs, changes: snapshot(rows), sender: TX_SENDER, destination: null, common: f.common };
}
function internalPacket(f, kind, { reverted = false } = {}) {
  const child = frame(f, { type: kind, from: TARGET, depth: 1 });
  const trace = frame(f, { type: 'CALL', to: TARGET, input: '0x', error: reverted ? 'revert' : null, calls: [child] });
  return { output: { execution: { status: reverted ? 'reverted' : 'success', error: trace.error }, trace, logs: [] },
    inputs: f.inputs, changes: snapshot([structuredClone(callerNonce),
      ...(!reverted ? [{ address: TARGET, nonce: { before: '0x7', after: '0x8' } }] : [])]),
    sender: TX_SENDER, destination: TARGET, common: f.common };
}

test('storage-only target facts are proof-bound even when every storage slot is undemanded', async () => {
  const f = await facts();
  const provenance = f.inputs.provenance.find(row => row.account === f.target);
  assert.equal(f.inputs.accounts[f.target].nonce, '0');
  assert.equal(f.inputs.accounts[f.target].code, '0x');
  assert.deepEqual(f.inputs.accounts[f.target].storage, {});
  assert.equal(provenance.accountProof.codeHash, EMPTY_CODE_HASH);
  assert.notEqual(provenance.accountProof.storageRoot, EMPTY_STORAGE_ROOT);
  assert(f.inputEvidence.every(row => row.request.method !== 'eth_getProof' || row.request.params[1].length === 0));
  for (const mutate of [
    p => { p.inputs.provenance.find(row => row.account === f.target).accountProof.storageRoot = EMPTY_STORAGE_ROOT; },
    p => { p.inputs.accounts[f.target].nonce = '1'; p.inputs.provenance.find(row => row.account === f.target).accountProof.nonceRaw = '1'; },
    p => { p.inputEvidence.find(row => row.request.method === 'eth_getProof' && row.request.params[0] === f.target).result.accountProof = []; },
  ]) {
    const p = structuredClone({ inputs: f.inputs, inputEvidence: f.inputEvidence, stateRoot: f.header.stateRoot, chainId: Number(f.common.chainId()) });
    mutate(p); await assert.rejects(validateInputFacts(p));
  }
});

test('root CREATE storage-only collision cannot pass the empty-frame shortcut on historical or Amsterdam forks', async () => {
  for (const fork of ['shanghai', 'osaka', 'amsterdam']) {
    const f = await facts({ fork }), p = rootPacket(f);
    assert.throws(() => validateExecutionChanges(p), fork);
    assert.throws(() => validateExecutionLifecycle(p), fork);
    if (fork === 'amsterdam') assert.throws(() => validateCreationAttempts(p));
  }
});

test('historical internal CREATE and CREATE2 storage-only collisions are rejected even under root rollback', async () => {
  for (const fork of ['shanghai', 'osaka']) for (const kind of ['CREATE', 'CREATE2']) {
    const f = await facts({ fork, target: targetOf(kind) });
    for (const reverted of [false, true]) {
      const p = internalPacket(f, kind, { reverted });
      assert.throws(() => validateExecutionChanges(p), `${fork}/${kind}/${reverted}`);
    }
  }
});

test('genuine nonce or code collision predicates remain accepted with nonempty storage', async () => {
  for (const fork of ['osaka', 'amsterdam']) for (const variant of ['nonce', 'code']) {
    const f = await facts({ fork, variant });
    assert.doesNotThrow(() => validateExecutionChanges(rootPacket(f)), `${fork}/${variant}/root`);
    if (fork === 'osaka') {
      const nested = await facts({ fork, variant, target: targetOf('CREATE2') });
      assert.doesNotThrow(() => validateExecutionChanges(internalPacket(nested, 'CREATE2')));
    }
  }
});

test('absent and prefunded empty targets retain accepted successful root creation', async () => {
  for (const fork of ['osaka', 'amsterdam']) for (const variant of ['absent', 'empty']) {
    const f = await facts({ fork, variant });
    assert.doesNotThrow(() => validateExecutionChanges(rootPacket(f, true)), `${fork}/${variant}`);
  }
});

test('Amsterdam no-child ledger cannot authorize storage-only collision with a genuine creator nonce increment', async () => {
  for (const kind of ['CREATE', 'CREATE2']) {
    const f = await facts({ target: targetOf(kind), creatorCode: kind === 'CREATE' ? '0xf0' : '0xf5' });
    const proof = f.inputs.provenance.find(row => row.account === f.target).accountProof;
    const entry = { position: 0, type: kind, pc: 0, nonceBefore: '0x7', nonceAfter: '0x8',
      value: '0x0', input: init, salt: kind === 'CREATE2' ? salt : null, target: f.target,
      targetBefore: { exists: true, nonce: '0x0', codeHash: proof.codeHash, storageRoot: proof.storageRoot },
      disposition: 'collision', result: '0x0' };
    const trace = frame(f, { type: 'CALL', to: TARGET, input: '0x', error: null, attempts: [entry] });
    const p = { output: { execution: { status: 'success' }, trace, logs: [] }, inputs: f.inputs, common: f.common };
    assert.throws(() => validateCreationAttempts(p));
  }
});

test('query starting reset masks the old storage root, while carried authorization nonce or code still collides', async () => {
  const f = await facts(), proof = f.inputs.provenance.find(row => row.account === f.target).accountProof;
  const success = rootPacket(f, true);
  const startingChanges = snapshot([{ address: f.target,
    reset: { basis: 'same_invocation_created_contract_clearing_eip8246', initialStorageRoot: proof.storageRoot } }]);
  assert.doesNotThrow(() => validateCreationAttempts({ ...success, startingChanges }));
  assert.doesNotThrow(() => validateCreationAttempts(success), 'Entered creation clears a storage-only namespace in chronology');
  assert.throws(() => validateExecutionChanges(success), 'A surviving storage clear still requires the exact proof-bound reset row');
  const wrong = structuredClone(startingChanges); wrong.accounts[0].reset.initialStorageRoot = word(987);
  assert.throws(() => validateCreationAttempts({ ...success, startingChanges: wrong }));
  const failed = rootPacket(f);
  for (const fork of ['amsterdam', 'osaka']) {
    const g = fork === 'amsterdam' ? f : await facts({ fork });
    const packet = fork === 'amsterdam' ? failed : rootPacket(g);
    const prepared = snapshot([{ address: g.target, nonce: { before: '0x0', after: '0x1' },
      code: { before: '0x', after: '0xef0100' + TARGET.slice(2) } }]);
    assert.doesNotThrow(() => validateExecutionLifecycle({ ...packet, startingChanges: prepared }));
  }
});
