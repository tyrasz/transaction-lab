import { canonicalStateChanges } from './preview-mutations.js';
import { EMPTY_CODE_HASH, EMPTY_STORAGE_ROOT } from './verified-state-proof.js';
import { isDeepStrictEqual } from 'node:util';
import { createAddressFromString, createContractAddress } from '@ethereumjs/util';

const ADDRESS = /^0x[0-9a-f]{40}$/, DATA = /^0x(?:[0-9a-f]{2})*$/;
const ZERO = '0x' + '00'.repeat(32);
const need = value => { if (!value) throw new Error('Local execution changes do not match their input facts and completed trace.'); };
const hex = value => '0x' + BigInt(value).toString(16);

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
  const created = new Map(); let frames = 0;
  function walk(frame, retained, depth) {
    need(frame && ++frames <= 1000 && depth <= 32 && Array.isArray(frame.calls));
    need(['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL', 'CREATE', 'CREATE2'].includes(frame.type));
    need(frame.error === null || typeof frame.error === 'string');
    need(typeof frame.output === 'string' && DATA.test(frame.output));
    const commits = retained && frame.error === null;
    if (['CREATE', 'CREATE2'].includes(frame.type) && commits) {
      need(typeof frame.to === 'string' && ADDRESS.test(frame.to) && frame.executionAddress === frame.to && !created.has(frame.to));
      created.set(frame.to, { frame, basis: depth === 0 && topCreation ? 'top_level_contract_creation' : 'internal_contract_creation' });
    }
    for (const child of frame.calls) walk(child, commits, depth + 1);
  }
  walk(output.trace, true, 0);
  const rows = new Map(snapshot.accounts.map(row => [row.address, row]));
  for (const row of snapshot.accounts) {
    const initial = inputs.accounts?.[row.address];
    need(initial && typeof initial.exists === 'boolean');
    for (const name of ['balance', 'nonce']) if (row[name]) need(row[name].before === hex(initial.exists ? initial[name] : '0'));
    if (row.existence) {
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
    const initial = inputs.accounts?.[address], row = rows.get(address);
    const proof = inputs.provenance?.find(item => item.account === address)?.accountProof;
    need(initial && proof && proof.storageRoot === EMPTY_STORAGE_ROOT && proof.codeHash === EMPTY_CODE_HASH && proof.nonceRaw === '0');
    need(row?.nonce?.before === '0x0' && BigInt(row.nonce.after) > 0n);
    if (!initial.exists) need(row.existence?.basis === basis);
    if (frame.output !== '0x') need(row.code?.after === frame.output);
    else need(!row.code);
  }
}
