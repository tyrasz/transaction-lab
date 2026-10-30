import { canonicalStateChanges } from './preview-mutations.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from './verified-state-proof.js';
import { isDeepStrictEqual, types } from 'node:util';
import { createAddressFromString, createContractAddress } from '@ethereumjs/util';
import { existingDelegationTarget } from './sender-delegation.js';
import { deriveAuthorizationPreparation } from './authorization-validation.js';
import { deriveVerifiedFees, revertedFeeRows } from './fee-validation.js';
import { validateCreationAttempts } from './creation-attempt-validation.js';

const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/, DATA = /^0x(?:[0-9a-f]{2})*$/;
const ZERO = '0x' + '00'.repeat(32);
const need = value => { if (!value) throw new Error('Local execution changes do not match their input facts and completed trace.'); };
const hex = value => '0x' + BigInt(value).toString(16);

const DELETION_BASIS = 'same_invocation_created_contract_deletion';
const SHANGHAI_DELETION_BASIS = 'shanghai_selfdestruct_deletion';
const AMSTERDAM_CLEARING_BASIS = 'same_invocation_created_contract_clearing_eip8246';
const EMPTY_CLEANUP_BASIS = 'eip161_empty_account_cleanup';
const RIPEMD160 = '0x0000000000000000000000000000000000000003';
const cleanupRow = address => ({ address, existence: { before: true, after: false, basis: EMPTY_CLEANUP_BASIS } });
function fields(value, required, optional = []) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value); need(required.every(key => keys.includes(key)));
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(typeof key === 'string' && [...required, ...optional].includes(key) && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
}
function boundedArray(value, maximum) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value) && Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(i)); need(descriptor?.enumerable && Object.hasOwn(descriptor, 'value')); }
}
function ownData(value, key) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value));
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor) need(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  return descriptor?.value;
}
function deployableFact(inputs, address) {
  const initial = inputs.accounts?.[address], proof = inputs.provenance?.find(item => item.account === address)?.accountProof;
  need(initial && typeof initial.exists === 'boolean' && proof && proof.exists === initial.exists && proof.storageRoot === EMPTY_STORAGE_ROOT && proof.codeHash === EMPTY_CODE_HASH && proof.nonceRaw === '0');
  if (initial.exists) need(initial.nonce === '0' && initial.code === '0x' && BigInt(initial.balance) >= 0n && Object.values(initial.storage).every(value => value === ZERO));
  return initial;
}
function emptyFact(inputs, address) {
  const initial = inputs.accounts?.[address];
  if (!initial?.exists || initial.nonce !== '0' || initial.balance !== '0' || initial.code !== '0x') return null;
  const proof = inputs.provenance?.find(item => item.account === address)?.accountProof;
  need(proof?.exists === true && proof.nonceRaw === '0' && proof.balanceRaw === '0' && proof.codeHash === EMPTY_CODE_HASH && typeof proof.storageRoot === 'string' && WORD.test(proof.storageRoot));
  return proof;
}

/** Check invocation-local lifecycle evidence without assuming a query starts
 * from the immutable base. Net query effects are validated separately. This is
 * trace/result consistency, not an independent replay or post-state-root proof. */
export function validateExecutionLifecycle({ output, inputs, destination, changes, startingChanges, selfdestructOnlyCreated = true, fees = null, common, rootNoncePrepared = false, authorizationHaltSender = null }) {
  need(typeof selfdestructOnlyCreated === 'boolean');
  const clearsCreated = common?.isActivatedEIP(8246) === true;
  const amsterdamAttempts = common?.isActivatedEIP(7928) === true;
  let creationAttempts = new Map();
  const created = new Map(), destructed = new Set(), eligibleTouches = new Set(), justifiedTouches = new Set(); let frames = 0;
  const lifecycle = output === null ? undefined : ownData(output, 'lifecycle');
  const complete = ['success', 'reverted', 'failed'].includes(output?.execution?.status);
  if (!complete) { need(lifecycle === undefined); return { created, creationAttempts, deleted: new Set(), cleared: new Set(), emptyDeleted: new Set() }; }
  const rows = new Map(changes ? canonicalStateChanges(changes).accounts.map(row => [row.address, row]) : []);
  const priorRows = new Map(startingChanges ? canonicalStateChanges(startingChanges).accounts.map(row => [row.address, row]) : []);
  // Only value transfers are reconstructed, from the already-bound complete
  // trace and authenticated starting balances. This is a consistency check,
  // not a second EVM. It prevents invented positive balances hiding cleanup.
  const balances = new Map();
  function balance(address) {
    if (!balances.has(address)) {
      const initial = inputs.accounts?.[address], prior = priorRows.get(address); need(initial && typeof initial.exists === 'boolean');
      balances.set(address, prior?.existence?.after === false ? 0n : prior?.balance ? BigInt(prior.balance.after) : initial.exists ? BigInt(initial.balance) : 0n);
    }
    return balances.get(address);
  }
  function transfer(from, to, value) {
    const source = balance(from), target = balance(to); need(value <= source);
    if (from !== to) { need(target + value < (1n << 256n)); balances.set(from, source - value); balances.set(to, target + value); }
  }
  function walk(frame, retained, depth, parent = null, inheritedStatic = false) {
    need(frame && !types.isProxy(frame) && ++frames <= 1000 && depth <= 32);
    for (const key of ['calls', 'type', 'error', 'output', 'to', 'executionAddress', 'from', 'caller', 'depth', 'value']) ownData(frame, key);
    boundedArray(frame.calls, 1000);
    if (!amsterdamAttempts) need(ownData(frame, 'creationAttempts') === undefined);
    need(['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL', 'CREATE', 'CREATE2'].includes(frame.type));
    const isStatic = inheritedStatic || frame.type === 'STATICCALL';
    // Static mode propagates through every descendant, including delegated
    // code. CREATE and value-bearing CALL trap before entering a child frame;
    // CALLCODE may carry value because it does not transfer native balance.
    if (isStatic) {
      need(!['CREATE', 'CREATE2'].includes(frame.type));
      if (['CALL', 'STATICCALL'].includes(frame.type)) need(frame.value === '0x0');
    }
    need(frame.error === null || (typeof frame.error === 'string' && frame.error.length > 0));
    need(typeof frame.output === 'string' && DATA.test(frame.output));
    need(frame.depth === depth && typeof frame.from === 'string' && ADDRESS.test(frame.from) && typeof frame.caller === 'string' && ADDRESS.test(frame.caller));
    // Bind every ancestor, not only frames carrying SELFDESTRUCT. Otherwise a
    // forged middle CALL could launder its descendant's execution address.
    if (parent) {
      need(frame.from === parent.executionAddress);
      need(frame.caller === (frame.type === 'DELEGATECALL' ? parent.caller : parent.executionAddress));
      if (frame.type === 'DELEGATECALL') need(frame.value === parent.value);
    } else need(frame.from === frame.caller);
    if (['CREATE', 'CREATE2'].includes(frame.type)) {
      need(frame.to === frame.executionAddress);
      need((typeof frame.to === 'string' && ADDRESS.test(frame.to)) || (frame.to === null && frame.error !== null));
      if (!amsterdamAttempts && frame.error === 'create collision') {
        // Historical creation enters a frame before the collision check. Its
        // initial authenticated namespace and bound starting overlay must not
        // authorize a storage-only collision either. A previously successful
        // creation, authorization, or the outer sender nonce can independently
        // supply a genuine nonce/code collision.
        const initial = inputs.accounts?.[frame.to], prior = priorRows.get(frame.to);
        const proof = inputs.provenance?.find(item => item.account === frame.to)?.accountProof;
        need(initial && proof && proof.exists === initial.exists);
        const reset = prior?.existence?.after === false || prior?.reset !== undefined;
        const nonce = prior?.existence?.after === false ? 0n : BigInt(prior?.nonce?.after ?? (initial.exists ? initial.nonce : '0'));
        const code = prior?.existence?.after === false ? '0x' : prior?.code?.after ?? (initial.exists ? initial.code : '0x');
        need(reset || nonce > 0n || code !== '0x' || created.has(frame.to) || frame.to === output.trace.from || proof.storageRoot === EMPTY_STORAGE_ROOT);
      }
    } else {
      need(typeof frame.to === 'string' && ADDRESS.test(frame.to));
      if (['DELEGATECALL', 'CALLCODE'].includes(frame.type)) need(parent && frame.executionAddress === parent.executionAddress);
      else need(frame.executionAddress === frame.to);
    }
    const commits = retained && frame.error === null;
    // CREATE increments its creator before entering the constructor. A child
    // revert or collision retains that increment when its parent commits;
    // a reverted parent discards it. Do not count the root transaction CREATE.
    if (!amsterdamAttempts && depth > 0 && retained && ['CREATE', 'CREATE2'].includes(frame.type)) {
      creationAttempts.set(frame.from, (creationAttempts.get(frame.from) ?? 0) + 1);
    }
    if (depth === 0) justifiedTouches.add(frame.from); // Root nonce is outside its message checkpoint.
    if (commits && frame.type !== 'DELEGATECALL') {
      justifiedTouches.add(frame.from); justifiedTouches.add(frame.executionAddress);
      need(typeof frame.value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(frame.value) && frame.value.length <= 66);
      if (frame.type === 'STATICCALL') need(frame.value === '0x0');
      if (frame.type === 'CALLCODE') need(BigInt(frame.value) <= balance(frame.executionAddress));
      else transfer(frame.from, frame.executionAddress, BigInt(frame.value));
      if (['CALL', 'STATICCALL'].includes(frame.type)) {
        eligibleTouches.add(frame.executionAddress);
      }
    }
    // The pinned RIPEMD160 implementation has only success/OOG outcomes after
    // account touches. Do not use ambiguous pre-touch failures as evidence.
    if (['CALL', 'STATICCALL'].includes(frame.type) && frame.executionAddress === RIPEMD160 && [null, 'out of gas'].includes(frame.error)) {
      justifiedTouches.add(RIPEMD160); eligibleTouches.add(RIPEMD160);
    }
    if (['CREATE', 'CREATE2'].includes(frame.type) && commits) {
      need(typeof frame.to === 'string' && ADDRESS.test(frame.to) && frame.executionAddress === frame.to && !created.has(frame.to));
      created.set(frame.to, { frame, basis: depth === 0 && destination === null ? 'top_level_contract_creation' : 'internal_contract_creation' });
    }
    const selfdestruct = ownData(frame, 'selfdestruct');
    if (selfdestruct !== undefined) {
      fields(selfdestruct, ['beneficiary']);
      need(typeof selfdestruct.beneficiary === 'string' && ADDRESS.test(selfdestruct.beneficiary) && frame.error === null);
      need(typeof frame.executionAddress === 'string' && ADDRESS.test(frame.executionAddress));
      need(!isStatic);
      if (parent) need(frame.from === parent.executionAddress);
      if (['DELEGATECALL', 'CALLCODE'].includes(frame.type)) need(parent && frame.executionAddress === parent.executionAddress);
      else need(frame.executionAddress === frame.to);
      if (commits) destructed.add(frame.executionAddress);
      if (selfdestruct.beneficiary !== frame.executionAddress && (commits || selfdestruct.beneficiary === RIPEMD160)) {
        justifiedTouches.add(selfdestruct.beneficiary); eligibleTouches.add(selfdestruct.beneficiary);
      }
    }
    for (const child of frame.calls) walk(child, commits, depth + 1, frame, isStatic);
    // SELFDESTRUCT is terminal in its own frame, after all entered children.
    // Amsterdam never burns a self-beneficiary balance. Earlier forks retain
    // their immediate burn and end-of-invocation whole-account deletion rules.
    if (selfdestruct !== undefined && commits) {
      if (selfdestruct.beneficiary !== frame.executionAddress) transfer(frame.executionAddress, selfdestruct.beneficiary, balance(frame.executionAddress));
      else if (!clearsCreated && (!selfdestructOnlyCreated || created.has(frame.executionAddress))) balances.set(frame.executionAddress, 0n);
    }
  }
  if (fees) {
    const before = balance(fees.sender), debit = fees.plan.totalUpfrontDebit ?? fees.plan.upfrontGasDebit;
    need(before >= debit); balances.set(fees.sender, before - debit);
  }
  if (authorizationHaltSender !== null) {
    // This exception is supplied only after the parent derives an actual
    // authorization OOG from verified facts, never from a child phase claim.
    need(amsterdamAttempts && rootNoncePrepared && ADDRESS.test(authorizationHaltSender) && output.trace === null);
    need(output.execution.status === 'failed' && output.execution.error === 'out of gas');
    need(output.execution.executionGasUsed === '0' && output.execution.returnData === '0x' && output.logs.length === 0);
    justifiedTouches.add(authorizationHaltSender);
  } else {
    walk(output.trace, true, 0);
    if (amsterdamAttempts) creationAttempts = validateCreationAttempts({ output, inputs, startingChanges, rootNoncePrepared, fees, common });
  }
  if (fees) {
    // Refund and tip are sequential account updates before lifecycle deletion.
    // A pending-deletion coinbase receives its credit and then burns it.
    for (const [address, amount] of [[fees.sender, BigInt(fees.accounting.senderRefund)], [fees.plan.coinbase, BigInt(fees.accounting.coinbaseTip)]]) {
      const next = balance(address) + amount; need(next < (1n << 256n)); balances.set(address, next);
      justifiedTouches.add(address); eligibleTouches.add(address);
    }
  }
  const cleared = new Set(clearsCreated ? [...destructed].filter(address => created.has(address)).sort() : []);
  const deleted = new Set(clearsCreated ? [] : [...destructed].filter(address => !selfdestructOnlyCreated || created.has(address)).sort());
  const deletionBasis = selfdestructOnlyCreated ? DELETION_BASIS : SHANGHAI_DELETION_BASIS;
  if (lifecycle !== undefined) { fields(lifecycle, [], ['finalizedDeletions', 'finalizedClearings', 'emptyAccountCleanup']); need(Object.keys(lifecycle).length > 0); }
  if (cleared.size === 0) need(lifecycle?.finalizedClearings === undefined);
  else {
    need(output.execution.status === 'success' && lifecycle); boundedArray(lifecycle.finalizedClearings, 128);
    need(lifecycle.finalizedClearings.length === cleared.size && changes !== undefined);
    for (const [index, address] of [...cleared].entries()) {
      const row = lifecycle.finalizedClearings[index]; fields(row, ['address', 'scope', 'initialStorageRoot', 'preservedBalance']);
      const initial = inputs.accounts?.[address], proof = inputs.provenance?.find(item => item.account === address)?.accountProof;
      need(initial && proof && proof.exists === initial.exists && typeof proof.storageRoot === 'string' && WORD.test(proof.storageRoot));
      need(row.address === address && row.scope === 'code_nonce_and_entire_storage_preserving_balance' && row.initialStorageRoot === proof.storageRoot);
      const preserved = balance(address); need(row.preservedBalance === hex(preserved));
      const prior = priorRows.get(address);
      // A disposable continuation may recreate a previously cleared namespace.
      // Its starting overlay is separately bound to the original result. A
      // nonempty immutable namespace cannot become deployable by assertion.
      const clearedNamespace = prior?.existence?.after === false || (prior?.reset &&
        prior.reset.initialStorageRoot === proof.storageRoot && !prior.storage &&
        (prior.nonce?.after ?? hex(initial.exists ? initial.nonce : '0')) === '0x0' &&
        (prior.code?.after ?? (initial.exists ? initial.code : '0x')) === '0x');
      if (!clearedNamespace) deployableFact(inputs, address);
      const before = initial.exists ? BigInt(initial.balance) : 0n;
      const expected = { address };
      if (preserved === 0n) {
        if (initial.exists) expected.existence = { before: true, after: false, basis: AMSTERDAM_CLEARING_BASIS };
      } else if (!initial.exists) expected.existence = { before: false, after: true, basis: 'positive_native_funding_of_proof_absent_account' };
      else {
        if (initial.nonce !== '0') expected.nonce = { before: hex(initial.nonce), after: '0x0' };
        if (initial.nonce !== '0' || initial.code !== '0x' || proof.storageRoot !== EMPTY_STORAGE_ROOT) expected.reset = { basis: AMSTERDAM_CLEARING_BASIS, initialStorageRoot: proof.storageRoot };
        if (initial.code !== '0x') expected.code = { before: initial.code, after: '0x' };
      }
      if (before !== preserved) expected.balance = { before: hex(before), after: hex(preserved) };
      need(isDeepStrictEqual(rows.get(address), Object.keys(expected).length > 1 ? expected : undefined));
    }
  }
  if (deleted.size === 0) need(lifecycle?.finalizedDeletions === undefined);
  else {
    need(output.execution.status === 'success' && lifecycle); boundedArray(lifecycle.finalizedDeletions, 128);
    need(lifecycle.finalizedDeletions.length === deleted.size);
    for (const [index, address] of [...deleted].entries()) {
      const row = lifecycle.finalizedDeletions[index]; fields(row, ['address', 'scope', 'initialStorageRoot']);
      const initial = inputs.accounts?.[address], proof = inputs.provenance?.find(item => item.account === address)?.accountProof;
      need(initial && proof && proof.exists === initial.exists && typeof proof.storageRoot === 'string' && WORD.test(proof.storageRoot));
      need(row.address === address && row.scope === 'entire_account_including_code_and_storage' && row.initialStorageRoot === proof.storageRoot);
      if (selfdestructOnlyCreated) deployableFact(inputs, address);
      else {
        const prior = priorRows.get(address);
        // A disposable after-query can start with a creation made by the
        // original invocation. Its base proof may still prove absence. A
        // carried deletion alone can never justify executing deleted code.
        const priorCreation = prior?.existence?.after !== false && prior?.nonce?.before === '0x0' && BigInt(prior.nonce.after) > 0n &&
          (['internal_contract_creation', 'top_level_contract_creation'].includes(prior.existence?.basis) || Boolean(prior.code));
        need(created.has(address) || priorCreation || (initial.exists && initial.code !== '0x' && prior?.existence?.after !== false));
        if (created.has(address) || priorCreation) deployableFact(inputs, address);
      }
      // Snapshots remain relative to the immutable base, including in queries.
      // Absent -> created -> deleted leaves no net row; existing deletion
      // removes the entire namespace, not an enumeration of known slots.
      const expected = initial.exists ? { address, existence: { before: true, after: false, basis: deletionBasis }, ...(BigInt(initial.balance) > 0n ? { balance: { before: hex(initial.balance), after: '0x0' } } : {}) } : undefined;
      need(changes !== undefined && isDeepStrictEqual(rows.get(address), expected));
    }
  }
  for (const address of deleted) balances.set(address, 0n);
  const requiredCleanup = new Set();
  for (const address of eligibleTouches) {
    if (!emptyFact(inputs, address) || deleted.has(address) || cleared.has(address) || created.has(address)) continue;
    const prior = priorRows.get(address), after = rows.get(address);
    if (prior?.existence?.after === false || (prior?.nonce && BigInt(prior.nonce.after) > 0n) || prior?.code) continue;
    if (address === (authorizationHaltSender ?? output.trace.from)) {
      // The one permitted non-creation nonce is the exact root caller nonce.
      const before = prior?.nonce ? BigInt(prior.nonce.after) : 0n;
      need(after?.nonce?.after === hex(before + 1n)); continue;
    }
    need(!after?.nonce && !after?.code);
    const expectedBalance = balance(address);
    if (expectedBalance > 0n) { need(after?.balance?.after === hex(expectedBalance) && after.existence?.after !== false); continue; }
    need(!after?.balance);
    requiredCleanup.add(address);
  }
  const emptyDeleted = new Set(), cleanup = lifecycle?.emptyAccountCleanup;
  if (cleanup !== undefined) {
    fields(cleanup, ['basis', 'scope', 'touchedAccounts', 'deletions']);
    const cleanupScope = !fees ? 'unsigned_message_touches_no_fee_settlement'
      : fees.accounting.kind === 'eip4844' ? 'unsigned_eip4844_transaction_touches' : 'unsigned_eip1559_transaction_touches';
    need(cleanup.basis === 'eip161_transaction_end' && cleanup.scope === cleanupScope);
    boundedArray(cleanup.touchedAccounts, 128); boundedArray(cleanup.deletions, 128); need(cleanup.deletions.length > 0);
    let previous = '';
    for (const address of cleanup.touchedAccounts) {
      need(typeof address === 'string' && ADDRESS.test(address) && address > previous && inputs.accounts?.[address] && justifiedTouches.has(address)); previous = address;
    }
    const touched = new Set(cleanup.touchedAccounts); previous = '';
    for (const row of cleanup.deletions) {
      fields(row, ['address', 'scope', 'initialStorageRoot']);
      need(typeof row.address === 'string' && ADDRESS.test(row.address) && row.address > previous && touched.has(row.address) && requiredCleanup.has(row.address)); previous = row.address;
      const proof = emptyFact(inputs, row.address);
      need(proof && row.scope === 'entire_account_including_code_and_storage' && row.initialStorageRoot === proof.storageRoot);
      need(isDeepStrictEqual(rows.get(row.address), cleanupRow(row.address)));
      emptyDeleted.add(row.address);
    }
  }
  need(isDeepStrictEqual([...emptyDeleted].sort(), [...requiredCleanup].sort()));
  // Bind unpriced transfers as well as fee settlement. Snapshots are relative
  // to the immutable proof state, so also retain prior balance rows which a
  // disposable query never visits; omitting such a row must not erase an
  // original effect. A proven deletion is already masked by balance().
  const balanceRows = map => [...map.values()].filter(row => row.balance).map(row => row.address);
  for (const address of new Set([...balances.keys(), ...balanceRows(rows), ...balanceRows(priorRows)])) {
    const fact = inputs.accounts[address]; need(fact && typeof fact.exists === 'boolean');
    const before = fact.exists ? BigInt(fact.balance) : 0n;
    const after = deleted.has(address) || emptyDeleted.has(address) ? 0n : balance(address);
    need(isDeepStrictEqual(rows.get(address)?.balance, before === after ? undefined : { before: hex(before), after: hex(after) }));
  }
  // New clearing/reset evidence requires the current invocation's exact
  // creation/SELFDESTRUCT intersection. An unchanged earlier row may be carried
  // by a query; its starting overlay is validated by the enclosing parent.
  for (const row of rows.values()) if (row.reset?.basis === AMSTERDAM_CLEARING_BASIS || row.existence?.basis === AMSTERDAM_CLEARING_BASIS) {
    need(clearsCreated && (cleared.has(row.address) || isDeepStrictEqual(row, priorRows.get(row.address))));
  }
  return { created, creationAttempts, deleted, cleared, emptyDeleted };
}

/** Bind the bounded overlay schema to the worker's immutable input facts and
 * committed creation frames. This is result-consistency validation, not an
 * independent EVM execution or a recomputed post-state-root proof. */
export function validateExecutionChanges({ changes, inputs, output, sender, destination, selfdestructOnlyCreated = true, common, request, header }) {
  const snapshot = canonicalStateChanges(changes), complete = ['success', 'reverted', 'failed'].includes(output?.execution?.status);
  // This entrypoint validates the first invocation over immutable proven state.
  // Finalized deletion occurs only at transaction end, so no surviving later
  // incarnation can be justified here. Internal state continuations carry reset
  // provenance, but the public single-call host must never accept it as input.
  need(snapshot.accounts.every(row => row.reset === undefined));
  const topCreation = destination === null, senderAddress = sender.toLowerCase(), senderInitial = inputs?.accounts?.[senderAddress];
  const preparation = complete && request ? deriveAuthorizationPreparation({ request, header, inputs, common }) : null;
  if (preparation) need(isDeepStrictEqual(output.authorizationProcessing, preparation.processing));
  else need(output?.authorizationProcessing === undefined);
  const chainId = common ? Number(common.chainId()) : 1; need(chainId === 1 || chainId === 11155111);
  const fees = request && header ? deriveVerifiedFees({ request, header, inputs, output, chainId }) : null;
  if (!fees) need(output?.feeAccounting === undefined);
  // Derive the root CREATE address from independently reverified initial facts,
  // never from the worker's trace or its claimed after-nonce. An unfinished
  // frame may not have resolved a destination yet.
  if (topCreation && output?.trace) {
    const root = output.trace;
    need(root.type === 'CREATE' && root.from === senderAddress && root.caller === senderAddress);
    need(root.to === root.executionAddress);
    if (complete || root.to !== null) {
      need(senderInitial && typeof senderInitial.exists === 'boolean');
      const nonce = senderInitial.exists ? BigInt(senderInitial.nonce) : 0n;
      need(root.to === createContractAddress(createAddressFromString(senderAddress), nonce).toString());
    }
  }
  const authorizationHaltSender = preparation?.processing.preparation?.phase === 'authorization_out_of_gas' ? senderAddress : null;
  const { created, creationAttempts, deleted, cleared, emptyDeleted } = validateExecutionLifecycle({ output, inputs, destination, changes: snapshot, startingChanges: preparation?.snapshot, selfdestructOnlyCreated, fees, common, rootNoncePrepared: Boolean(preparation), authorizationHaltSender });
  if (!complete) { need(snapshot.accounts.length === 0); return; }
  need(senderInitial && typeof senderInitial.exists === 'boolean');
  if (authorizationHaltSender === null) need(output.trace.from === senderAddress && output.trace.caller === senderAddress);
  const senderCode = senderInitial.exists ? senderInitial.code : '0x';
  const delegated = common && existingDelegationTarget(senderCode, common) !== null;
  need(senderCode === '0x' || delegated);
  // Amsterdam's independently checked nonce-write ledger includes collisions
  // without a child message; older forks retain entered-frame accounting.
  if (delegated) need([1n, 11155111n].includes(common.chainId()));
  const senderNonce = senderInitial.exists ? BigInt(senderInitial.nonce) : 0n;
  const nonceAfter = (preparation?.accounts.get(senderAddress).current.nonce ?? senderNonce + 1n) + (delegated || preparation ? BigInt(creationAttempts.get(senderAddress) ?? 0) : 0n);
  need(senderNonce < (1n << 64n) - 1n && nonceAfter < (1n << 64n));
  need(isDeepStrictEqual(snapshot.accounts.find(row => row.address === senderAddress)?.nonce,
    { before: hex(senderNonce), after: hex(nonceAfter) }));
  if (['reverted', 'failed'].includes(output.execution.status)) {
    const address = sender.toLowerCase(), initial = inputs.accounts?.[address];
    need(initial && typeof initial.exists === 'boolean');
    const nonce = initial.exists ? BigInt(initial.nonce) : 0n;
    const row = { address, ...(!initial.exists ? { existence: { before: false, after: true, basis: 'unsigned_sender_nonce_materialization' } } : {}), nonce: { before: hex(nonce), after: hex(nonce + 1n) } };
    need([...emptyDeleted].every(account => account === RIPEMD160 || account === fees?.plan.coinbase));
    const preparedRows = revertedFeeRows({ baseRows: preparation?.snapshot.accounts ?? [row], fees, inputs });
    need(isDeepStrictEqual(snapshot.accounts, [...emptyDeleted].map(cleanupRow).concat(preparedRows.filter(item => !emptyDeleted.has(item.address))).sort((a, b) => a.address.localeCompare(b.address))));
  }
  const rows = new Map(snapshot.accounts.map(row => [row.address, row]));
  // EVM execution changes nonces only for the outer sender, successfully
  // prepared authorizations, new contracts and entered creation attempts whose
  // parent commits. In particular, a recovered but skipped authority earns no
  // nonce change. Check missing rows too, so omission cannot hide increments.
  const nonceAccounts = new Set([senderAddress, ...rows.keys(), ...created.keys(), ...creationAttempts.keys(), ...(preparation?.accounts.keys() ?? [])]);
  for (const address of nonceAccounts) {
    if (deleted.has(address) || cleared.has(address) || emptyDeleted.has(address)) continue;
    const initial = inputs.accounts?.[address]; need(initial && typeof initial.exists === 'boolean');
    const before = initial.exists ? BigInt(initial.nonce) : 0n;
    let after = preparation?.accounts.get(address)?.current.nonce ?? before + (address === senderAddress ? 1n : 0n);
    if (created.has(address)) after = 1n;
    after += BigInt(creationAttempts.get(address) ?? 0);
    need(after < (1n << 64n));
    need(isDeepStrictEqual(rows.get(address)?.nonce, before === after ? undefined : { before: hex(before), after: hex(after) }));
  }
  for (const row of snapshot.accounts) {
    const initial = inputs.accounts?.[row.address];
    need(initial && typeof initial.exists === 'boolean');
    for (const name of ['balance', 'nonce']) if (row[name]) need(row[name].before === hex(initial.exists ? initial[name] : '0'));
    if (cleared.has(row.address)) continue; // Exact whole-clearing row was independently derived above.
    if (row.existence?.basis === EMPTY_CLEANUP_BASIS) {
      need(emptyDeleted.has(row.address) && initial.exists);
    } else if ([DELETION_BASIS, SHANGHAI_DELETION_BASIS].includes(row.existence?.basis)) {
      need(deleted.has(row.address) && initial.exists && row.existence.basis === (selfdestructOnlyCreated ? DELETION_BASIS : SHANGHAI_DELETION_BASIS));
    } else if (row.existence) {
      need(initial.exists === false);
      if (['internal_contract_creation', 'top_level_contract_creation'].includes(row.existence.basis)) need(created.get(row.address)?.basis === row.existence.basis);
      if (row.existence.basis === 'unsigned_sender_nonce_materialization') need(row.address === sender.toLowerCase());
      if (row.existence.basis === 'eip7702_authorization_materialization') need(preparation?.applied.has(row.address));
    } else need(initial.exists);
    if (row.code) {
      if (preparation?.applied.has(row.address)) need(row.code.before === (initial.exists ? initial.code : '0x') && row.code.after === preparation.accounts.get(row.address).current.code);
      else need(created.has(row.address) && row.code.after === created.get(row.address).frame.output && (!initial.exists || initial.code === '0x'));
    }
    for (const slot of row.storage ?? []) {
      need(slot.before === (initial.exists ? initial.storage?.[slot.slot] : ZERO));
      if (!initial.exists) need(created.has(row.address) || preparation?.applied.has(row.address));
    }
  }
  for (const address of preparation?.applied ?? []) {
    const { initial, current } = preparation.accounts.get(address), row = rows.get(address);
    const nonce = current.nonce + BigInt(creationAttempts.get(address) ?? 0);
    need(nonce < (1n << 64n));
    need(isDeepStrictEqual(row?.nonce, { before: hex(initial.nonce), after: hex(nonce) }));
    const code = initial.code === current.code ? undefined : { before: initial.code, after: current.code };
    need(isDeepStrictEqual(row.code, code));
    if (!initial.exists) need(isDeepStrictEqual(row.existence, { before: false, after: true, basis: 'eip7702_authorization_materialization' }));
    else need(row.existence === undefined);
  }
  for (const [address, { frame, basis }] of created) {
    const initial = deployableFact(inputs, address), row = rows.get(address);
    if (deleted.has(address) || cleared.has(address)) {
      // Its exact whole-account row was checked with the fork-specific basis.
      continue;
    }
    need(row?.nonce?.before === '0x0' && BigInt(row.nonce.after) > 0n);
    if (!initial.exists) need(row.existence?.basis === basis);
    if (frame.output !== '0x') need(row.code?.after === frame.output);
    else need(!row.code);
  }
}
