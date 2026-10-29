import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { verifyStateProof } from './verified-state-proof.js';
import { createAuthenticatedAncestry } from './authenticated-ancestry.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i;
const ZERO = '0x' + '00'.repeat(32);
export const RPC_STATE_INPUT_LIMITS = Object.freeze({ accounts: 128, slots: 1024, calls: 256,
  responseBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, codeBytes: 131072,
  reads: 200000, requestMs: 25000, wallMs: 240000 });
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const collectors = new WeakSet();
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const isRpcStateInputs = value => collectors.has(value);
const fail = (code, message) => { throw new RpcStateInputError(code, message); };
export class RpcStateInputError extends Error {
  constructor(code, message) { super(message); this.name = 'RpcStateInputError'; this.code = code; }
}
function fields(value, allowed) {
  if (!plain(value)) fail('RPC_STATE_INPUT_INVALID', 'A plain input object is required.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || (allowed && !allowed.includes(key)) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('RPC_STATE_INPUT_INVALID', 'Unsupported input field.');
  }
}
function address(value) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) fail('RPC_STATE_INPUT_INVALID', 'A full state address is required.');
  return value.toLowerCase();
}
function word(value) {
  if (typeof value !== 'string' || !WORD.test(value)) fail('RPC_STATE_INPUT_INVALID', 'A full 32-byte state word is required.');
  return value.toLowerCase();
}

/** Immutable initial-state facts. This collector has no write, trace, override,
 * poststate, or VM checkpoint input. The supplied header is a trust anchor;
 * its authenticity and chain membership must be established by the caller. */
export function createRpcStateInputs(options) {
  fields(options, ['chainId', 'blockHash', 'header', 'rpc', 'limits', 'now']);
  const { chainId, rpc, now = () => performance.now() } = options;
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || typeof rpc?.call !== 'function' || typeof now !== 'function') fail('RPC_STATE_INPUT_INVALID', 'Explicit chain and read-only transport are required.');
  const blockHash = word(options.blockHash); fields(options.header);
  if (word(options.header.hash) !== blockHash) fail('RPC_STATE_INPUT_INVALID', 'The header must match the pinned block hash.');
  const stateRoot = word(options.header.stateRoot), limits = { ...RPC_STATE_INPUT_LIMITS };
  if (options.limits !== undefined) {
    fields(options.limits, Object.keys(limits));
    for (const [key, value] of Object.entries(options.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) fail('RPC_STATE_INPUT_INVALID', 'Input-state budgets may only be tightened.');
      limits[key] = value;
    }
  }
  let headerText;
  try { headerText = JSON.stringify(options.header); } catch { fail('RPC_STATE_INPUT_INVALID', 'Header must be a bounded JSON value.'); }
  if (Buffer.byteLength(headerText) > 128 * 1024) fail('RPC_STATE_INPUT_INVALID', 'Header exceeds its input bound.');
  const context = { chainId, blockHash, stateRoot, header: JSON.parse(headerText),
    selector: { blockHash, requireCanonical: true }, stateRootTrust: 'caller_supplied_header',
    provenance: 'verified_eip1186_proofs_and_code_hash', expectedOutputsUsed: false };
  const facts = new Map(), evidence = [], reads = new Map();
  let ancestry = null;
  let failure = null, totalBytes = 0, slotCount = 0, readCount = 0, started = null, pending = Promise.resolve();
  function live() {
    if (failure) throw new RpcStateInputError(failure.code, failure.message);
    started ??= now();
    if (now() - started >= limits.wallMs) fail('RPC_STATE_INPUT_LIMIT', 'Input-state collection exceeded its wall-time budget.');
  }
  function rememberFailure(error) {
    failure ??= error instanceof RpcStateInputError ? { code: error.code, message: error.message }
      : { code: 'RPC_STATE_INPUT_UNAVAILABLE', message: 'Pinned input state could not be verified.' };
    return new RpcStateInputError(failure.code, failure.message);
  }
  function schedule(operation) {
    const result = pending.then(async () => { try { live(); return await operation(); } catch (error) { throw rememberFailure(error); } });
    pending = result.catch(() => {}); return result;
  }
  function demand(kind, account, slot) {
    if (++readCount > limits.reads) fail('RPC_STATE_INPUT_LIMIT', 'Input-state read budget was exhausted.');
    const key = `${kind}:${account}:${slot ?? ''}`;
    if (!reads.has(key)) reads.set(key, { kind, account, ...(slot ? { slot } : {}) });
  }
  async function call(method, params) {
    live();
    if (!['eth_getProof', 'eth_getCode', 'eth_getBlockByHash'].includes(method)) fail('RPC_STATE_INPUT_INVALID', 'Only proof, code and authenticated ancestor reads are permitted.');
    if (evidence.length >= limits.calls || totalBytes >= limits.totalBytes) fail('RPC_STATE_INPUT_LIMIT', 'Input-state RPC budget was exhausted.');
    const request = { method, params: structuredClone(params) }, requestText = JSON.stringify(request);
    const entry = { id: evidence.length + 1, request, requestText, requestSha256: sha(requestText), status: 'pending',
      representation: 'parsed_rpc_result_not_wire_bytes' };
    evidence.push(entry);
    const began = now(), timeoutMs = Math.max(1, Math.min(limits.requestMs, limits.wallMs - (began - started)));
    const controller = new AbortController(); let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new RpcStateInputError('RPC_STATE_INPUT_TIMEOUT', 'Pinned input-state read timed out.')); }, timeoutMs);
      });
      // The optional third argument lets transports cancel I/O; correctness
      // does not depend on cancellation. Late resolutions cannot update facts.
      const raw = await Promise.race([Promise.resolve().then(() => rpc.call(method, structuredClone(params), { signal: controller.signal })), deadline]);
      if (controller.signal.aborted || now() - began >= timeoutMs) fail('RPC_STATE_INPUT_TIMEOUT', 'Pinned input-state read timed out.');
      live();
      const serialized = JSON.stringify(raw);
      if (typeof serialized !== 'string') fail('RPC_STATE_INPUT_UNAVAILABLE', 'Pinned input-state read returned no JSON result.');
      const bytes = Buffer.byteLength(serialized); entry.resultBytes = bytes; entry.resultSha256 = sha(serialized);
      totalBytes += bytes;
      if (bytes > limits.responseBytes || totalBytes > limits.totalBytes) fail('RPC_STATE_INPUT_LIMIT', 'Pinned input-state result exceeded its byte budget.');
      entry.result = JSON.parse(serialized); entry.status = 'received';
      return { result: structuredClone(entry.result), evidenceId: entry.id };
    } catch (error) {
      const safe = error instanceof RpcStateInputError ? error : new RpcStateInputError('RPC_STATE_INPUT_UNAVAILABLE', 'Required pinned input-state read failed.');
      entry.status = 'unavailable'; entry.error = { code: safe.code, message: safe.message }; throw safe;
    } finally { clearTimeout(timer); controller.abort(); entry.durationMs = Math.max(0, now() - began); }
  }
  async function proof(account, slots, code) {
    const read = await call('eth_getProof', [account, slots, context.selector]);
    let verified;
    try { verified = await verifyStateProof({ stateRoot, address: account, storageKeys: slots, proof: read.result, ...(code === undefined ? {} : { code }) }); }
    catch { evidence[read.evidenceId - 1].verification = 'rejected'; delete evidence[read.evidenceId - 1].result; fail('RPC_STATE_INPUT_INVALID_PROOF', 'Pinned state proof did not verify against the selected root.'); }
    live(); evidence[read.evidenceId - 1].verification = 'verified'; return { verified, read };
  }
  async function load(account, slots = []) {
    if (facts.has(account)) return facts.get(account);
    if (facts.size >= limits.accounts) fail('RPC_STATE_INPUT_LIMIT', 'Input-state account budget was exhausted.');
    const initial = await proof(account, slots), codeRead = await call('eth_getCode', [account, context.selector]);
    if (typeof codeRead.result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(codeRead.result) || codeRead.result.length > limits.codeBytes * 2 + 2) {
      delete evidence[codeRead.evidenceId - 1].result; fail('RPC_STATE_INPUT_UNAVAILABLE', 'Pinned account code is missing, malformed or too large.');
    }
    let verified;
    try { verified = await verifyStateProof({ stateRoot, address: account, storageKeys: slots, proof: initial.read.result, code: codeRead.result }); }
    catch { evidence[codeRead.evidenceId - 1].verification = 'rejected'; delete evidence[codeRead.evidenceId - 1].result; fail('RPC_STATE_INPUT_INVALID_PROOF', 'Pinned code does not match its verified account proof.'); }
    live(); evidence[codeRead.evidenceId - 1].verification = 'verified';
    const entry = { account: structuredClone(verified.account), code: verified.code.bytes,
      storage: new Map(verified.storage.map(row => [row.key, { value: row.valueWord, exists: row.exists, evidenceId: initial.read.evidenceId }])),
      proofEvidenceId: initial.read.evidenceId, codeEvidenceId: codeRead.evidenceId };
    if (verified.status !== 'verified' || verified.code.status !== 'verified' || typeof entry.code !== 'string') fail('RPC_STATE_INPUT_INVALID_PROOF', 'Verified account code was not established.');
    facts.set(account, entry); return entry;
  }
  const collector = Object.freeze({
    context: freeze(structuredClone(context)),
    blockchain: Object.freeze({ getBlock(number) { return schedule(async () => {
      if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) number = BigInt(number);
      if (chainId !== 1 || typeof number !== 'bigint' || BigInt(context.header.number) > BigInt(Number.MAX_SAFE_INTEGER)) fail('RPC_STATE_INPUT_INVALID', 'Authenticated ancestry requires an exact Ethereum block number.');
      demand('blockhash', number.toString());
      ancestry ??= createAuthenticatedAncestry(context.header);
      while (ancestry.peek(number) === null) {
        const nextHash = ancestry.nextHash();
        if (nextHash === null) fail('RPC_STATE_INPUT_LIMIT', 'The authenticated ancestry bound was exhausted.');
        const read = await call('eth_getBlockByHash', [nextHash, false]);
        try { ancestry.accept(read.result, read.evidenceId); }
        catch { evidence[read.evidenceId - 1].verification = 'rejected'; delete evidence[read.evidenceId - 1].result; fail('RPC_STATE_INPUT_INVALID_ANCESTRY', 'Ancestor header did not match its committed parent link.'); }
        live(); evidence[read.evidenceId - 1].verification = 'verified';
      }
      const hash = ancestry.record(number);
      return { hash: () => Uint8Array.from(Buffer.from(hash.slice(2), 'hex')) };
    }); } }),
    getAccount(rawAddress) { return schedule(async () => { const key = address(rawAddress); demand('account', key); return structuredClone((await load(key)).account); }); },
    getCode(rawAddress) { return schedule(async () => { const key = address(rawAddress); demand('code', key); return (await load(key)).code; }); },
    getStorage(rawAddress, rawSlot) { return schedule(async () => {
      const key = address(rawAddress), slot = word(rawSlot); demand('storage', key, slot);
      let entry = facts.get(key);
      if (entry?.storage.has(slot)) return entry.storage.get(slot).value;
      if (slotCount >= limits.slots) fail('RPC_STATE_INPUT_LIMIT', 'Input-state slot budget was exhausted.');
      slotCount++;
      if (!entry) entry = await load(key, [slot]);
      else if (entry.account.exists) {
        const result = await proof(key, [slot], entry.code);
        if (!isDeepStrictEqual(result.verified.account, entry.account)) fail('RPC_STATE_INPUT_INVALID_PROOF', 'Repeated proof disagrees with the verified starting account.');
        const observed = result.verified.storage.find(row => row.key === slot);
        if (!observed) fail('RPC_STATE_INPUT_INVALID_PROOF', 'The requested storage word was not proven.');
        entry.storage.set(slot, { value: observed.valueWord, exists: observed.exists, evidenceId: result.read.evidenceId });
      } else entry.storage.set(slot, { value: ZERO, exists: false, evidenceId: entry.proofEvidenceId });
      const observed = entry.storage.get(slot);
      if (!observed) fail('RPC_STATE_INPUT_INVALID_PROOF', 'The requested storage word was not proven.');
      return observed.value;
    }); },
    snapshotInputs() {
      const accounts = {};
      for (const [key, entry] of facts) accounts[key] = entry.account.exists ? { exists: true, nonce: entry.account.nonceRaw, balance: entry.account.balanceRaw,
        code: entry.code, storage: Object.fromEntries([...entry.storage].map(([slot, row]) => [slot, row.value])) } : { exists: false };
      return { status: failure ? 'unavailable' : 'available', context: structuredClone(context), accounts,
        ...(ancestry ? { ancestry: ancestry.snapshot() } : {}),
        provenance: [...facts].map(([account, entry]) => ({ account, accountProof: structuredClone(entry.account), proofEvidenceId: entry.proofEvidenceId,
          codeEvidenceId: entry.codeEvidenceId, storage: [...entry.storage].map(([key, value]) => ({ key, ...value })) })),
        coverage: 'Only demanded, proof-verified initial accounts and storage keys; unrequested storage is unknown.', ...(failure ? { failure: structuredClone(failure) } : {}) };
    },
    snapshotEvidence() { return structuredClone(evidence); },
    snapshotUsage() { return { status: failure ? 'unavailable' : 'available', calls: evidence.length, observedResultBytes: totalBytes,
      retainedResultBytes: evidence.reduce((sum, row) => sum + (Object.hasOwn(row, 'result') ? row.resultBytes : 0), 0),
      accounts: facts.size, slots: slotCount, reads: readCount, distinctReads: reads.size, limits: { ...limits }, ...(failure ? { failure: structuredClone(failure) } : {}) }; },
    snapshotReads() { return { total: readCount, distinct: reads.size, reads: structuredClone([...reads.values()]) }; },
  });
  collectors.add(collector); return collector;
}
