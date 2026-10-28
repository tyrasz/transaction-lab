import { canonicalStateChanges } from './preview-mutations.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from './verified-state-proof.js';
import { isDeepStrictEqual, types } from 'node:util';
import { createAddressFromString, createContractAddress } from '@ethereumjs/util';

const ADDRESS = /^0x[0-9a-f]{40}$/, DATA = /^0x(?:[0-9a-f]{2})*$/;
const ZERO = '0x' + '00'.repeat(32);
const need = value => { if (!value) throw new Error('Local execution changes do not match their input facts and completed trace.'); };
const hex = value => '0x' + BigInt(value).toString(16);

const DELETION_BASIS = 'same_invocation_created_contract_deletion';
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
  if (initial.exists) need(initial.nonce === '0' && initial.code === '0x' && BigInt(initial.balance) > 0n && Object.values(initial.storage).every(value => value === ZERO));
  return initial;
}

/** Check invocation-local lifecycle evidence without assuming a query starts
 * from the immutable base. Net query effects are validated separately. This is
 * trace/result consistency, not an independent replay or post-state-root proof. */
export function validateExecutionLifecycle({ output, inputs, destination }) {
  const created = new Map(), destructed = new Set(); let frames = 0;
  const lifecycle = output === null ? undefined : ownData(output, 'lifecycle');
  const complete = ['success', 'reverted', 'failed'].includes(output?.execution?.status);
  if (!complete) { need(lifecycle === undefined); return { created, deleted: new Set() }; }
  function walk(frame, retained, depth, parent = null) {
    need(frame && !types.isProxy(frame) && ++frames <= 1000 && depth <= 32);
    for (const key of ['calls', 'type', 'error', 'output', 'to', 'executionAddress', 'from', 'caller', 'depth']) ownData(frame, key);
    boundedArray(frame.calls, 1000);
    need(['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL', 'CREATE', 'CREATE2'].includes(frame.type));
    need(frame.error === null || (typeof frame.error === 'string' && frame.error.length > 0));
    need(typeof frame.output === 'string' && DATA.test(frame.output));
    need(frame.depth === depth && typeof frame.from === 'string' && ADDRESS.test(frame.from) && typeof frame.caller === 'string' && ADDRESS.test(frame.caller));
    // Bind every ancestor, not only frames carrying SELFDESTRUCT. Otherwise a
    // forged middle CALL could launder its descendant's execution address.
    if (parent) {
      need(frame.from === parent.executionAddress);
      need(frame.caller === (frame.type === 'DELEGATECALL' ? parent.caller : parent.executionAddress));
    } else need(frame.from === frame.caller);
    if (['CREATE', 'CREATE2'].includes(frame.type)) {
      need(frame.to === frame.executionAddress);
      need((typeof frame.to === 'string' && ADDRESS.test(frame.to)) || (frame.to === null && frame.error !== null));
    } else {
      need(typeof frame.to === 'string' && ADDRESS.test(frame.to));
      if (['DELEGATECALL', 'CALLCODE'].includes(frame.type)) need(parent && frame.executionAddress === parent.executionAddress);
      else need(frame.executionAddress === frame.to);
    }
    const commits = retained && frame.error === null;
    if (['CREATE', 'CREATE2'].includes(frame.type) && commits) {
      need(typeof frame.to === 'string' && ADDRESS.test(frame.to) && frame.executionAddress === frame.to && !created.has(frame.to));
      created.set(frame.to, { frame, basis: depth === 0 && destination === null ? 'top_level_contract_creation' : 'internal_contract_creation' });
    }
    const selfdestruct = ownData(frame, 'selfdestruct');
    if (selfdestruct !== undefined) {
      fields(selfdestruct, ['beneficiary']);
      need(typeof selfdestruct.beneficiary === 'string' && ADDRESS.test(selfdestruct.beneficiary) && frame.error === null);
      need(typeof frame.executionAddress === 'string' && ADDRESS.test(frame.executionAddress));
      need(frame.type !== 'STATICCALL');
      if (parent) need(frame.from === parent.executionAddress);
      if (['DELEGATECALL', 'CALLCODE'].includes(frame.type)) need(parent && frame.executionAddress === parent.executionAddress);
      else need(frame.executionAddress === frame.to);
      if (commits) destructed.add(frame.executionAddress);
    }
    for (const child of frame.calls) walk(child, commits, depth + 1, frame);
  }
  walk(output.trace, true, 0);
  const deleted = new Set([...created.keys()].filter(address => destructed.has(address)).sort());
  if (deleted.size === 0) need(lifecycle === undefined);
  else {
    need(output.execution.status === 'success'); fields(lifecycle, ['finalizedDeletions']); boundedArray(lifecycle.finalizedDeletions, 128);
    need(lifecycle.finalizedDeletions.length === deleted.size);
    for (const [index, address] of [...deleted].entries()) {
      const row = lifecycle.finalizedDeletions[index]; fields(row, ['address', 'scope', 'initialStorageRoot']);
      need(row.address === address && row.scope === 'entire_account_including_code_and_storage' && row.initialStorageRoot === EMPTY_STORAGE_ROOT);
      deployableFact(inputs, address);
    }
  }
  return { created, deleted };
}

/** Bind the bounded overlay schema to the worker's immutable input facts and
 * committed creation frames. This is result-consistency validation, not an
 * independent EVM execution or a recomputed post-state-root proof. */
export function validateExecutionChanges({ changes, inputs, output, sender, destination }) {
  const snapshot = canonicalStateChanges(changes), complete = ['success', 'reverted', 'failed'].includes(output?.execution?.status);
  const topCreation = destination === null, senderAddress = sender.toLowerCase(), senderInitial = inputs?.accounts?.[senderAddress];
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
  const { created, deleted } = validateExecutionLifecycle({ output, inputs, destination });
  if (!complete) { need(snapshot.accounts.length === 0); return; }
  need(senderInitial && typeof senderInitial.exists === 'boolean');
  const senderNonce = senderInitial.exists ? BigInt(senderInitial.nonce) : 0n;
  need(isDeepStrictEqual(snapshot.accounts.find(row => row.address === senderAddress)?.nonce,
    { before: hex(senderNonce), after: hex(senderNonce + 1n) }));
  if (['reverted', 'failed'].includes(output.execution.status)) {
    const address = sender.toLowerCase(), initial = inputs.accounts?.[address];
    need(initial && typeof initial.exists === 'boolean');
    const nonce = initial.exists ? BigInt(initial.nonce) : 0n;
    const row = { address, ...(!initial.exists ? { existence: { before: false, after: true, basis: 'unsigned_sender_nonce_materialization' } } : {}), nonce: { before: hex(nonce), after: hex(nonce + 1n) } };
    need(isDeepStrictEqual(snapshot.accounts, [row]));
  }
  const rows = new Map(snapshot.accounts.map(row => [row.address, row]));
  for (const row of snapshot.accounts) {
    const initial = inputs.accounts?.[row.address];
    need(initial && typeof initial.exists === 'boolean');
    for (const name of ['balance', 'nonce']) if (row[name]) need(row[name].before === hex(initial.exists ? initial[name] : '0'));
    if (row.existence?.basis === DELETION_BASIS) {
      need(deleted.has(row.address) && initial.exists);
    } else if (row.existence) {
      need(initial.exists === false);
      if (['internal_contract_creation', 'top_level_contract_creation'].includes(row.existence.basis)) need(created.get(row.address)?.basis === row.existence.basis);
      if (row.existence.basis === 'unsigned_sender_nonce_materialization') need(row.address === sender.toLowerCase());
    } else need(initial.exists);
    if (row.code) need(created.has(row.address) && row.code.after === created.get(row.address).frame.output && (!initial.exists || initial.code === '0x'));
    for (const slot of row.storage ?? []) {
      need(slot.before === (initial.exists ? initial.storage?.[slot.slot] : ZERO));
      if (!initial.exists) need(created.has(row.address));
    }
  }
  for (const [address, { frame, basis }] of created) {
    const initial = deployableFact(inputs, address), row = rows.get(address);
    if (deleted.has(address)) {
      if (!initial.exists) need(row === undefined);
      else need(isDeepStrictEqual(row, { address, existence: { before: true, after: false, basis: DELETION_BASIS }, balance: { before: hex(initial.balance), after: '0x0' } }));
      continue;
    }
    need(row?.nonce?.before === '0x0' && BigInt(row.nonce.after) > 0n);
    if (!initial.exists) need(row.existence?.basis === basis);
    if (frame.output !== '0x') need(row.code?.after === frame.output);
    else need(!row.code);
  }
}
