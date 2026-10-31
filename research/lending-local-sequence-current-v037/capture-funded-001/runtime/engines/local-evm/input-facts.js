import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { decode, encode, fields } from './isolated-protocol.js';
import { EMPTY_CODE_HASH, verifyStateProof } from './verified-state-proof.js';

const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/;
const ZERO = '0x' + '00'.repeat(32);
const MAX_BYTES = 64 * 1024 * 1024;
// A caller supplies cache identity, never cached verification claims. Values
// remain private so populating or mutating that Map cannot authorize facts.
const caches = new WeakMap();
export class InputFactsError extends Error {
  constructor() { super('Local initial facts do not match their joined proof and code evidence.'); this.name = 'InputFactsError'; this.code = 'LOCAL_INPUT_FACTS_INVALID'; }
}
const need = value => { if (!value) throw new InputFactsError(); };
function record(value, names) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
  need(isDeepStrictEqual(Object.keys(value).sort(), [...names].sort()));
}
const same = (a, b) => need(isDeepStrictEqual(a, b));

/** Reconstruct only the sparse initial facts actually claimed by a worker.
 * The parent must first join each evidence result to its actual transport
 * reply and bind the context/header. This independently verifies all referenced
 * account/storage proofs and code hashes; execution outputs never enter here.
 * Unreferenced failed/incomplete reads remain evidence, not invented facts.
 * chainId is the parent's expected network, never a value selected from the
 * worker's claimed context. State-root proofs alone do not attest a network. */
export async function validateInputFacts(options) {
  fields(options, ['inputs', 'inputEvidence', 'stateRoot', 'cache', 'check', 'chainId'], ['inputs', 'inputEvidence', 'stateRoot']);
  let { inputs, inputEvidence, stateRoot, cache = new Map(), check = () => {}, chainId = 1 } = options;
  need(chainId === 1 || chainId === 11155111);
  need(typeof check === 'function'); check();
  need(cache !== null && typeof cache === 'object' && !types.isProxy(cache) && Object.getPrototypeOf(cache) === Map.prototype);
  // Snapshot all caller-controlled JSON before the first await. Encoding also
  // rejects accessors, proxies, sparse arrays and custom object prototypes.
  const copy = decode(encode({ inputs, inputEvidence, stateRoot }, MAX_BYTES), MAX_BYTES);
  ({ inputs, inputEvidence, stateRoot } = copy);
  need(typeof stateRoot === 'string' && WORD.test(stateRoot));
  need(inputs && typeof inputs === 'object' && inputs.context?.chainId === chainId);
  need(inputs.context.stateRoot === stateRoot && typeof inputs.context.blockHash === 'string' && WORD.test(inputs.context.blockHash));
  const selector = { blockHash: inputs.context.blockHash, requireCanonical: true };
  same(inputs.context.selector, selector);
  need(Array.isArray(inputEvidence) && inputEvidence.length <= 256);
  need(inputs.accounts && !Array.isArray(inputs.accounts) && Object.getPrototypeOf(inputs.accounts) === Object.prototype);
  need(Array.isArray(inputs.provenance) && inputs.provenance.length <= 128 && Object.keys(inputs.accounts).length <= 128);
  if (!caches.has(cache)) caches.set(cache, new Map());
  const verifiedCache = caches.get(cache);
  function evidence(id, method, account) {
    need(Number.isSafeInteger(id) && id > 0 && id <= inputEvidence.length);
    const row = inputEvidence[id - 1];
    need(row?.id === id && row.status === 'received' && row.verification === 'verified' && Object.hasOwn(row, 'result'));
    record(row.request, ['method', 'params']);
    need(row.request.method === method && Array.isArray(row.request.params));
    const params = row.request.params;
    need(params.length === (method === 'eth_getProof' ? 3 : 2) && params[0] === account);
    same(params.at(-1), selector);
    if (method === 'eth_getProof') need(Array.isArray(params[1]) && params[1].length <= 64 && params[1].every(key => typeof key === 'string' && WORD.test(key)) && new Set(params[1]).size === params[1].length);
    return row;
  }
  async function verified(proofId, account, code) {
    check();
    const proof = evidence(proofId, 'eth_getProof', account);
    const args = { stateRoot, address: account, storageKeys: proof.request.params[1], proof: proof.result, code };
    const key = createHash('sha256').update(encode(args, 8 * 1024 * 1024)).digest('hex');
    let result = verifiedCache.get(key);
    if (result === undefined) {
      try { result = await verifyStateProof(args); }
      catch { throw new InputFactsError(); }
      check();
      if (verifiedCache.size < 512) verifiedCache.set(key, result);
    }
    check();
    return result;
  }
  const accounts = {}, seen = new Set(); let slots = 0;
  for (const item of inputs.provenance) {
    check();
    const derived = item !== null && typeof item === 'object' && Object.hasOwn(item, 'codeDerivation');
    record(item, ['account', 'accountProof', 'proofEvidenceId', 'codeEvidenceId', 'storage', ...(derived ? ['codeDerivation'] : [])]);
    const account = item.account;
    need(typeof account === 'string' && ADDRESS.test(account) && !seen.has(account)); seen.add(account);
    let code;
    if (derived) {
      need(item.codeEvidenceId === null && ['verified_account_absence', 'verified_account_empty_code_hash'].includes(item.codeDerivation));
      code = '0x';
    } else {
      code = evidence(item.codeEvidenceId, 'eth_getCode', account).result;
      need(item.codeEvidenceId > item.proofEvidenceId);
    }
    // Derivation never bypasses verification: explicit empty runtime must hash
    // to the authenticated account, and absence must be cryptographically proven.
    const initial = await verified(item.proofEvidenceId, account, code);
    if (derived) {
      need(initial.account.codeHash === EMPTY_CODE_HASH);
      need(item.codeDerivation === (initial.account.exists ? 'verified_account_empty_code_hash' : 'verified_account_absence'));
    }
    same(item.accountProof, initial.account);
    need(initial.code.status === 'verified' && typeof initial.code.bytes === 'string');
    need(Array.isArray(item.storage) && item.storage.length <= 1024);
    const storage = {}, seenSlots = new Set();
    for (const slot of item.storage) {
      check(); record(slot, ['key', 'value', 'exists', 'evidenceId']);
      need(++slots <= 1024 && typeof slot.key === 'string' && WORD.test(slot.key) && !seenSlots.has(slot.key)); seenSlots.add(slot.key);
      let expected;
      if (!initial.account.exists && slot.evidenceId === item.proofEvidenceId) {
        // A proven absent account has no storage trie; each demanded slot is
        // independently zero by the same exclusion, without an extra RPC.
        expected = { value: ZERO, exists: false };
      } else {
        const proof = slot.evidenceId === item.proofEvidenceId ? initial : await verified(slot.evidenceId, account, code);
        same(proof.account, initial.account);
        const found = proof.storage.find(row => row.key === slot.key);
        need(found !== undefined); expected = { value: found.valueWord, exists: found.exists };
      }
      same({ value: slot.value, exists: slot.exists }, expected);
      storage[slot.key] = expected.value;
    }
    // Initial load may request a slot with its account proof. It cannot then
    // disappear from that loaded account's claimed sparse inventory.
    for (const slot of initial.storage) {
      const found = item.storage.find(row => row.key === slot.key);
      need(found && found.evidenceId === item.proofEvidenceId && found.value === slot.valueWord && found.exists === slot.exists);
    }
    accounts[account] = initial.account.exists ? { exists: true, nonce: initial.account.nonceRaw,
      balance: initial.account.balanceRaw, code: initial.code.bytes, storage } : { exists: false };
  }
  same(inputs.accounts, accounts); check();
  return true;
}
