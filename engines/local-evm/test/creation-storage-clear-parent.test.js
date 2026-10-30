// Fabricated result-consistency controls over independently authenticated
// synthetic proofs. These frames are not an execution or client oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressFromString, createContractAddress, createContractAddress2 } from '@ethereumjs/util';
import { validateInputFacts } from '../input-facts.js';
import { validateCreationAttempts } from '../creation-attempt-validation.js';
import { validateExecutionChanges, validateExecutionLifecycle } from '../execution-changes.js';
import { canonicalStateChanges, validateQueryMutation } from '../preview-mutations.js';
import { ethereumNetworkCommon } from '../ethereum-network.js';
import { EMPTY_STORAGE_ROOT } from '../verified-state-proof.js';
import { amsterdamExecutionFixture } from './amsterdam-execution-fixture.js';
import { feeFixture, TX_SENDER, TARGET, bytes, word } from './fee-fixture.js';

const SCOPE = 'Demanded proof-verified inputs and local overlay writes only; no recomputed post-state root or complete-effect proof.';
const BASIS = 'contract_creation_storage_clear', INIT = '0x00', SALT = word(123), RUNTIME = '0x00';
const snapshot = accounts => ({ scope: SCOPE, accounts: accounts.sort((a, b) => a.address.localeCompare(b.address)) });
const senderRow = () => ({ address: TX_SENDER, nonce: { before: '0x1', after: '0x2' } });
const targetOf = (kind, root = false) => kind === 'CREATE2'
  ? createContractAddress2(createAddressFromString(TARGET), bytes(SALT), bytes(INIT)).toString()
  : createContractAddress(createAddressFromString(root ? TX_SENDER : TARGET), root ? 1n : 7n).toString();
async function packet({ fork = 'amsterdam', kind = 'CREATE2', root = false, endowment = 0, runtime = RUNTIME, childError = null, rootError = null } = {}) {
  const target = targetOf(kind, root), options = { target: { nonce: 7n, balance: 1000n, code: kind === 'CREATE2' ? '0xf5' : '0xf0' },
    accounts: { [target]: { nonce: 0n, balance: 17n, code: '0x', storage: { [word(0)]: 999n, [word(991)]: 123456n } } } };
  const f = fork === 'amsterdam' ? await amsterdamExecutionFixture({ ...options, priced: false })
    : await feeFixture({ ...options, fork, baseFee: 0n, maxFee: 0n, priorityFee: 0n });
  const common = f.common ?? ethereumNetworkCommon(f.header);
  for (const address of [TX_SENDER, TARGET, target]) await f.inputs.getAccount(address);
  const inputs = f.inputs.snapshotInputs();
  await validateInputFacts({ inputs, inputEvidence: f.inputs.snapshotEvidence(), stateRoot: f.header.stateRoot, chainId: Number(common.chainId()) });
  const proof = inputs.provenance.find(row => row.account === target).accountProof;
  const frame = (type, from, to, depth, input, output, error, value = 0) => ({ type, from, caller: from, to, executionAddress: to,
    value: '0x' + value.toString(16), input, output, error, gas: '0x10000', gasUsed: '0x1', depth, calls: [],
    ...(fork === 'amsterdam' ? { creationAttempts: [] } : type === 'CREATE2' ? { creationSalt: SALT } : {}) });
  const child = frame(kind, root ? TX_SENDER : TARGET, target, root ? 0 : 1, INIT, childError ? '0x' : runtime, childError, endowment);
  const trace = root ? child : frame('CALL', TX_SENDER, TARGET, 0, '0x', '0x', rootError);
  const entry = { position: 0, type: kind, pc: 0, nonceBefore: '0x7', nonceAfter: '0x8', value: child.value,
    input: INIT, salt: kind === 'CREATE2' ? SALT : null, target,
    targetBefore: { exists: true, nonce: '0x0', codeHash: proof.codeHash, storageRoot: proof.storageRoot },
    disposition: 'entered', result: childError ? '0x0' : '0x' + BigInt(target).toString(16) };
  if (!root) { trace.calls.push(child); if (fork === 'amsterdam') trace.creationAttempts.push(entry); }
  const rows = [senderRow()];
  if (!root && !rootError) rows.push({ address: TARGET, nonce: { before: '0x7', after: '0x8' },
    ...(!childError && endowment ? { balance: { before: '0x3e8', after: '0x' + (1000 - endowment).toString(16) } } : {}) });
  if (!childError && !rootError) {
    rows.push({ address: target, nonce: { before: '0x0', after: '0x1' }, reset: { basis: BASIS, initialStorageRoot: proof.storageRoot },
      ...(runtime === '0x' ? {} : { code: { before: '0x', after: runtime } }),
      ...(endowment ? { balance: { before: '0x11', after: '0x' + (17 + endowment).toString(16) } } : {}),
      storage: [{ slot: word(0), before: word(0), after: word(999) }, { slot: word(2), before: word(0), after: word(42) }] });
    if (root && endowment) rows[0].balance = { before: '0x' + BigInt(inputs.accounts[TX_SENDER].balance).toString(16),
      after: '0x' + (BigInt(inputs.accounts[TX_SENDER].balance) - BigInt(endowment)).toString(16) };
  }
  const output = { execution: { status: (root ? childError : rootError) ? 'reverted' : 'success', error: root ? childError : rootError }, trace, logs: [] };
  return { output, changes: snapshot(rows), inputs, common, sender: TX_SENDER, destination: root ? null : TARGET,
    selfdestructOnlyCreated: fork !== 'shanghai', target, entry, child, proof };
}
function reject(p, mutate, lifecycleOnly = false) {
  const copy = structuredClone({ output: p.output, changes: p.changes, inputs: p.inputs }); mutate(copy);
  assert.throws(() => (lifecycleOnly ? validateExecutionLifecycle : validateExecutionChanges)({ ...p, ...copy }));
}

test('committed root CREATE and internal CREATE/CREATE2 bind nonempty original roots and zero-before writes on all supported fork families', async () => {
  for (const fork of ['shanghai', 'cancun', 'prague', 'osaka', 'amsterdam']) for (const [root, kind] of [[true, 'CREATE'], [false, 'CREATE'], [false, 'CREATE2']]) {
    const p = await packet({ fork, root, kind, endowment: 5 });
    assert.notEqual(p.proof.storageRoot, EMPTY_STORAGE_ROOT);
    assert.deepEqual(p.inputs.accounts[p.target].storage, {}, 'old storage remains undemanded');
    assert.doesNotThrow(() => validateExecutionChanges(p), `${fork}/${root}/${kind}`);
    assert.equal(validateExecutionLifecycle(p).storageCleared.has(p.target), true);
  }
});

test('missing/wrong reset root, wrong basis/target, nonzero baselines and invented state fail closed', async () => {
  for (const p of [await packet(), await packet({ fork: 'osaka' }), await packet({ root: true, kind: 'CREATE' })]) {
    for (const mutate of [
      x => { delete x.changes.accounts.find(row => row.address === p.target).reset; },
      x => { x.changes.accounts.find(row => row.address === p.target).reset.initialStorageRoot = word(3); },
      x => { x.changes.accounts.find(row => row.address === p.target).reset.basis = 'shanghai_selfdestruct_deletion'; },
      x => { x.changes.accounts.find(row => row.address === p.target).address = TARGET; },
      x => { x.changes.accounts.find(row => row.address === p.target).storage[0].before = word(999); },
      x => { x.changes.accounts.find(row => row.address === p.target).nonce.after = '0x2'; },
      x => { x.changes.accounts.find(row => row.address === p.target).code.after = '0x6000'; },
      x => { const row = x.changes.accounts.find(row => row.address === p.target); row.balance = { before: '0x11', after: '0x12' }; },
    ]) reject(p, mutate);
    assert.throws(() => validateExecutionChanges({ ...p, common: undefined }));
  }
});

test('target derivation binds historical CREATE2 salt and CREATE creator nonce instead of trusting matching forged rows', async () => {
  for (const kind of ['CREATE', 'CREATE2']) {
    const p = await packet({ fork: 'osaka', kind });
    reject(p, x => { x.output.trace.calls[0].to = TX_SENDER; x.output.trace.calls[0].executionAddress = TX_SENDER; });
    if (kind === 'CREATE2') {
      reject(p, x => { delete x.output.trace.calls[0].creationSalt; });
      reject(p, x => { x.output.trace.calls[0].creationSalt = word(124); });
      reject(p, x => { x.output.trace.calls[0].creationSalt = '0x00'; });
    } else reject(p, x => { x.output.trace.calls[0].creationSalt = SALT; });
    reject(p, x => { x.output.trace.creationSalt = SALT; });
  }
  const p = await packet();
  reject(p, x => { x.output.trace.creationAttempts[0].targetBefore.storageRoot = EMPTY_STORAGE_ROOT; });
  reject(p, x => { x.output.trace.calls[0].creationSalt = SALT; });
});

test('constructor failure and ancestor rollback retain no reset; forged retained reset remains invalid', async () => {
  for (const fork of ['osaka', 'amsterdam']) for (const failure of ['constructor', 'ancestor']) {
    const p = await packet({ fork, ...(failure === 'constructor' ? { childError: 'revert' } : { rootError: 'revert' }) });
    assert.doesNotThrow(() => validateExecutionChanges(p));
    assert.equal(validateExecutionLifecycle(p).storageCleared.size, 0);
    reject(p, x => { x.changes.accounts.push({ address: p.target, nonce: { before: '0x0', after: '0x1' },
      reset: { basis: BASIS, initialStorageRoot: p.proof.storageRoot } }); });
  }
});

test('Amsterdam target chronology changes to empty only after entry and rolls back on failed creation', async () => {
  const p = await packet({ childError: 'revert' });
  const second = structuredClone(p.entry); second.position = 1; second.nonceBefore = '0x8'; second.nonceAfter = '0x9';
  p.output.trace.creationAttempts.push(second); p.output.trace.calls.push(structuredClone(p.child));
  p.changes.accounts.find(row => row.address === TARGET).nonce.after = '0x9';
  assert.doesNotThrow(() => validateExecutionChanges(p));
  reject(p, x => { x.output.trace.creationAttempts[1].targetBefore.storageRoot = EMPTY_STORAGE_ROOT; });
  const success = await packet();
  const collision = structuredClone(success.entry); collision.position = 1; collision.nonceBefore = '0x8'; collision.nonceAfter = '0x9';
  collision.targetBefore.nonce = '0x1'; collision.targetBefore.storageRoot = EMPTY_STORAGE_ROOT;
  collision.targetBefore.codeHash = '0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a';
  collision.disposition = 'collision'; collision.result = '0x0';
  success.output.trace.creationAttempts.push(collision);
  success.changes.accounts.find(row => row.address === TARGET).nonce.after = '0x9';
  assert.doesNotThrow(() => validateExecutionChanges(success));
  reject(success, x => { x.output.trace.creationAttempts[1].targetBefore.storageRoot = p.proof.storageRoot; });
});

test('created SELFDESTRUCT composes with the immutable nonempty root using each fork finalizer basis', async () => {
  for (const fork of ['shanghai', 'cancun', 'osaka', 'amsterdam']) {
    const p = await packet({ fork, runtime: '0x' });
    p.child.selfdestruct = { beneficiary: p.target };
    const index = p.changes.accounts.findIndex(row => row.address === p.target);
    if (fork === 'amsterdam') {
      p.output.lifecycle = { finalizedClearings: [{ address: p.target, scope: 'code_nonce_and_entire_storage_preserving_balance', initialStorageRoot: p.proof.storageRoot, preservedBalance: '0x11' }] };
      p.changes.accounts[index] = { address: p.target, reset: { basis: 'same_invocation_created_contract_clearing_eip8246', initialStorageRoot: p.proof.storageRoot } };
    } else {
      p.output.lifecycle = { finalizedDeletions: [{ address: p.target, scope: 'entire_account_including_code_and_storage', initialStorageRoot: p.proof.storageRoot }] };
      p.changes.accounts[index] = { address: p.target, existence: { before: true, after: false, basis: fork === 'shanghai' ? 'shanghai_selfdestruct_deletion' : 'same_invocation_created_contract_deletion' }, balance: { before: '0x11', after: '0x0' } };
    }
    assert.doesNotThrow(() => validateExecutionChanges(p), fork);
    reject(p, x => { const list = x.output.lifecycle.finalizedClearings ?? x.output.lifecycle.finalizedDeletions; list[0].initialStorageRoot = EMPTY_STORAGE_ROOT; });
    reject(p, x => { x.output.trace.calls[0].error = 'revert'; });
  }
});

test('carried original creation-clear rows stay neutral, while new retained query clears remain mutations', async () => {
  const p = await packet(); validateExecutionChanges(p);
  const before = structuredClone(p.changes), after = structuredClone(before);
  after.accounts.find(row => row.address === TX_SENDER).nonce.after = '0x3';
  const output = { execution: { status: 'success' }, trace: { ...p.output.trace, calls: [], creationAttempts: [] }, logs: [] };
  assert.doesNotThrow(() => validateExecutionLifecycle({ ...p, output, changes: after, startingChanges: before }));
  assert.equal(validateQueryMutation({ before, after, sender: TX_SENDER, nonceBefore: '2', senderExistedBefore: true }).status, 'verified');
  assert.throws(() => validateExecutionLifecycle({ ...p, output, changes: after }));
  assert.throws(() => validateQueryMutation({ before: snapshot([]), after: p.changes, sender: TX_SENDER, nonceBefore: '1', senderExistedBefore: true }));
  const wrong = structuredClone(after); wrong.accounts.find(row => row.address === p.target).reset.initialStorageRoot = word(77);
  assert.throws(() => validateExecutionLifecycle({ ...p, output, changes: wrong, startingChanges: before }));
  assert.throws(() => validateQueryMutation({ before, after: wrong, sender: TX_SENDER, nonceBefore: '2', senderExistedBefore: true }));
});

test('creation-clear canonical shape never authorizes a reset on its own', async () => {
  const p = await packet(), changes = structuredClone(p.changes);
  assert.deepEqual(canonicalStateChanges(changes), changes);
  for (const mutate of [
    row => { delete row.nonce; }, row => { row.nonce.before = '0x1'; },
    row => { row.code.before = '0x6000'; }, row => { row.existence = { before: false, after: true, basis: 'internal_contract_creation' }; },
  ]) { const copy = structuredClone(changes); mutate(copy.accounts.find(row => row.address === p.target)); assert.throws(() => canonicalStateChanges(copy)); }
});
