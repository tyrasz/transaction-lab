import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual, types } from 'node:util';
import { InputError } from './validate.js';
import { executeIsolatedEthereumPreview } from '../engines/local-evm/isolated-call.js';
import { compilePreviewQueries } from '../engines/local-evm/preview-queries.js';
import { verifyEthereumHeader } from '../engines/local-evm/ethereum-header.js';
import { normalizeEvmContext, EVM_CONTEXT_LIMITS } from '../engines/evm-context.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i;
const NUMBER = /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/i, DATA = /^0x(?:[0-9a-f]{2})*$/i;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/, MAX = (1n << 256n) - 1n;
const WALL = 145000, DRAIN = 25000, FINAL_RESERVE = 25000, RESPONSE = 96 * 1024 * 1024;
const failure = code => ({ code, message: ({
  LOCAL_PREVIEW_SOURCE_CHANGED: 'Execution sources changed; all measurements were withheld. Restart the service.',
  LOCAL_PREVIEW_CANONICAL: 'The complete selected header could not be confirmed; all measurements were withheld.',
  LOCAL_PREVIEW_CANCELLED: 'The local preview was cancelled; all measurements were withheld.',
  LOCAL_PREVIEW_BUDGET: 'The shared local preview budget was exhausted.',
  LOCAL_PREVIEW_DRAIN: 'Pending state reads could not be confirmed stopped; all measurements were withheld.',
  LOCAL_PREVIEW_OUTPUT: 'The complete API result exceeded its retained-output limit.',
  LOCAL_PREVIEW_PREPARATION: 'The selected Ethereum header or required pinned state was unavailable.',
})[code] ?? 'The local preview could not complete a valid result.' });
const stop = code => { throw Object.assign(new Error(code), { localCode: code }); };
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

export const LOCAL_CAPABILITIES = freeze({
  available: true, chainId: 1, status: 'experimental', operation: 'isolated_proof_backed_unsigned_call',
  profile: 'unsigned_unpriced_block_end', blockSelection: ['latest', 'canonical_hex_number', 'block_hash'],
  transactionContext: { optionalFields: ['accessList', 'blobVersionedHashes'], limits: EVM_CONTEXT_LIMITS, blobFeeScope: 'synthetic_zero_no_blob_fee_settlement_or_sidecar_validation' },
  internalCreation: 'CREATE_CREATE2_with_proven_empty_deployable_targets',
  topLevelCreation: 'explicit_null_destination_CREATE_with_proven_empty_deployable_target',
  selfdestruct: 'Cancun_or_later_existing_balance_transfer_and_same_invocation_created_contract_deletion',
  emptyAccountCleanup: 'EIP161_retained_unsigned_message_touches_including_RIPEMD160_exception',
  historicalBlockHashes: 'authenticated_parent_hash_chain_with_shared_input_limits',
  querySelection: 'explicit_only', queryTypes: ['balanceOf', 'allowance', 'aave_v3_user_account_data', 'morpho_blue_position'],
  limits: { queries: 8, calldataBytes: 32768, gas: 5000000, proofRpcCalls: 256, totalRpcCalls: 260,
    responseBytes: 8 * 1024 * 1024, wireBytes: 32 * 1024 * 1024, wallMs: WALL, drainMs: DRAIN, apiOutputBytes: RESPONSE },
  limitations: [
    'Only explicit query pairs are measured; automatic token discovery, native-effect summaries and sequences are not provided by this endpoint.',
    'Proofs and runtime code are checked against the selected header, whose hash is recomputed. Consensus, finality and contract identity are not independently established.',
    'Unsigned execution uses zero gas price and BASEFEE, without outer signature validation or fee settlement. Contract signature checks still execute.',
    'Explicit to:null deploys initcode with CREATE; internal CREATE and CREATE2 require a proven deployable target. Cancun-or-later SELFDESTRUCT transfers balances for preexisting contracts and finalizes deletion of contracts created in that invocation. Creation targets require proven empty initial code/storage and zero nonce. Shanghai destruction remains unsupported.',
    'Transaction-end EIP-161 cleanup removes touched empty accounts and their entire storage, including the retained RIPEMD160 touch exception. It adds no fee-related coinbase touch. Rematerializing a deleted account whose original storage trie was nonempty remains unsupported.',
    'Coded senders and KZG point evaluation remain unsupported. Blob context requires a call destination and uses zero blob base fee without sidecar or inclusion validation.',
    'In-range BLOCKHASH follows authenticated parent headers within the shared read and time budgets; missing ancestry is unavailable.',
    'The pinned EthereumJS Shanghai-through-BPO2 schedule and fixed execution/state budgets bound supported execution.',
    'Process separation and a V8 heap limit are not an OS network/filesystem sandbox or a hard total-RSS limit.',
    'No security verdict, complete economic-effect coverage or accuracy percentage is established.',
  ],
});

function record(value, allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InputError('A plain local-preview request is required.');
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) throw new InputError('Unsupported local-preview field.');
  }
}
export function validateLocalSimulation(input) {
  record(input, ['chainId', 'from', 'to', 'data', 'value', 'block', 'queries', 'accessList', 'blobVersionedHashes']);
  if (input.chainId !== 1 && input.chainId !== '1') throw new InputError('Only Ethereum chain 1 is supported.', 'UNSUPPORTED_CHAIN');
  if (typeof input.from !== 'string' || !ADDRESS.test(input.from)) throw new InputError('from must be a 20-byte hex address.');
  if (input.to !== null && (typeof input.to !== 'string' || !ADDRESS.test(input.to))) throw new InputError('to must be a 20-byte hex address, or explicit null for contract deployment.');
  if (typeof input.data !== 'string' || input.data.length > 65538 || !DATA.test(input.data)) throw new InputError('data must be even-length hexadecimal calldata of at most 32 KiB.');
  const value = input.value === undefined ? '0' : input.value;
  if (typeof value !== 'string' || !DECIMAL.test(value) || BigInt(value) > MAX) throw new InputError('value must be a canonical decimal uint256 wei string.');
  const block = input.block === undefined ? 'latest' : input.block;
  if (typeof block !== 'string' || !(block === 'latest' || NUMBER.test(block) || HASH.test(block))) throw new InputError('block must be latest, a canonical hexadecimal number, or a 32-byte block hash.');
  let queries, context;
  try { context = normalizeEvmContext(input); } catch { throw new InputError('The access list or versioned blob hashes are malformed or exceed the declared bounds.'); }
  if (input.to === null && context.blobVersionedHashes) throw new InputError('Blob context requires a call destination; contract deployment cannot carry blob hashes.');
  try { queries = compilePreviewQueries(input.queries).map(row => structuredClone(row.descriptor)); }
  catch { throw new InputError('Supply one to eight distinct canonical token or typed position queries.'); }
  return { chainId: 1, from: input.from.toLowerCase(), to: input.to === null ? null : input.to.toLowerCase(), data: input.data.toLowerCase(), value, block: block.toLowerCase(), queries, ...context };
}

function projection(core) {
  return (core?.measurements ?? []).map((row, index) => ({ index, descriptor: row.descriptor, query: row.query,
    identity: row.identity, returnBytes: row.returnBytes, status: row.status, reason: row.reason, values: row.values }));
}
/** A failed final check never leaves a nested measured preview in the response.
 * Only original execution and proof/read evidence remain, explicitly unactionable. */
export function withholdLocalSimulation(report, code) {
  const core = report.attempt?.preview;
  if (core) report.audit = { status: 'unverified_not_a_measurement', original: core.original,
    inputs: core.inputs, inputEvidence: core.inputEvidence, inputUsage: core.inputUsage, inputReads: core.inputReads };
  if (report.attempt) report.attempt = { ...report.attempt, status: 'unavailable', error: failure(code), preview: null };
  report.status = 'unavailable'; report.error = failure(code); report.execution = { status: 'unavailable' };
  report.measurements = []; report.source.canonicalStatus = 'unverified';
  return report;
}

/** rpc is the server's bounded, cancellable ProofRpcClient. No provider URL,
 * caller overrides, expected outputs, or execution traces are accepted here. */
export async function simulateLocal(input, rpc, { signal } = {}) {
  const apiRequest = validateLocalSimulation(input), started = performance.now();
  const report = { kind: 'local_proof_preview', schemaVersion: '1.0', id: randomUUID(), createdAt: new Date().toISOString(),
    apiRequest, status: 'unavailable', error: null, execution: { status: 'unavailable' }, measurements: [], attempt: null,
    source: { kind: 'proof_backed_owned_execution', profile: 'unsigned_unpriced_block_end', canonicalStatus: 'unverified',
      consensusVerified: false, originalTransactionReplay: false, blockSelection: { requested: apiRequest.block } },
    transportEvidence: [], usage: null, timing: null };
  const controller = new AbortController();
  const cancel = () => { controller.abort(); try { rpc.cancel(); } catch {} };
  const remaining = () => Math.min(WALL - (performance.now() - started), rpc.usage().remainingWallMs);
  let timer, cause = null;
  try {
    if (!rpc || !['call', 'pinBlockHash', 'snapshotEvidence', 'usage', 'cancel', 'drain'].every(name => typeof rpc[name] === 'function')) stop('LOCAL_PREVIEW_PREPARATION');
    if (signal?.aborted) stop('LOCAL_PREVIEW_CANCELLED');
    signal?.addEventListener('abort', cancel, { once: true });
    const initialRemaining = remaining();
    if (!Number.isFinite(initialRemaining) || initialRemaining <= 0) stop('LOCAL_PREVIEW_BUDGET');
    timer = setTimeout(cancel, Math.max(1, Math.floor(initialRemaining)));
    const call = async (method, params) => {
      if (controller.signal.aborted || remaining() <= 0) stop(signal?.aborted ? 'LOCAL_PREVIEW_CANCELLED' : 'LOCAL_PREVIEW_BUDGET');
      const result = await rpc.call(method, params, { signal: controller.signal });
      if (controller.signal.aborted || remaining() <= 0) stop(signal?.aborted ? 'LOCAL_PREVIEW_CANCELLED' : 'LOCAL_PREVIEW_BUDGET');
      return result;
    };
    if (await call('eth_chainId', []) !== '0x1') stop('LOCAL_PREVIEW_PREPARATION');
    const byHash = HASH.test(apiRequest.block), method = byHash ? 'eth_getBlockByHash' : 'eth_getBlockByNumber';
    const header = await call(method, [apiRequest.block, false]);
    const expectedHash = byHash ? apiRequest.block : header?.hash;
    const verified = verifyEthereumHeader({ header, expectedHash });
    if (!byHash && apiRequest.block !== 'latest' && BigInt(header.number) !== BigInt(apiRequest.block)) stop('LOCAL_PREVIEW_PREPARATION');
    const blockHash = header.hash.toLowerCase();
    report.source.blockSelection = { requested: apiRequest.block, kind: byHash ? 'pinned_hash' : apiRequest.block === 'latest' ? 'resolved_latest' : 'resolved_number',
      blockHash, blockNumber: BigInt(header.number).toString(), headerVerification: verified, header };
    rpc.pinBlockHash(blockHash, header);
    const usage = rpc.usage(), wallMs = Math.floor(remaining() - FINAL_RESERVE);
    const calls = Math.min(256, usage.limits.calls - usage.calls - 1), totalResponseBytes = Math.min(32 * 1024 * 1024, usage.limits.totalBytes - usage.observedBytes);
    if (wallMs <= 0 || calls <= 0 || totalResponseBytes <= 0) stop('LOCAL_PREVIEW_BUDGET');
    report.attempt = await executeIsolatedEthereumPreview({ request: { from: apiRequest.from, to: apiRequest.to, data: apiRequest.data, value: apiRequest.value, gas: '5000000', ...normalizeEvmContext(apiRequest) },
      header, queries: apiRequest.queries, rpc, signal: controller.signal,
      limits: { wallMs, calls, totalResponseBytes } });
    if (controller.signal.aborted || signal?.aborted) stop(signal?.aborted ? 'LOCAL_PREVIEW_CANCELLED' : 'LOCAL_PREVIEW_BUDGET');
    if (report.attempt.status !== 'completed') {
      cause = report.attempt.error?.code ?? 'LOCAL_PREVIEW_PREPARATION';
    } else {
      const confirmed = await call('eth_getBlockByNumber', ['0x' + BigInt(header.number).toString(16), false]);
      try {
        verifyEthereumHeader({ header: confirmed, expectedHash: blockHash });
        if (!isDeepStrictEqual(confirmed, header)) stop('LOCAL_PREVIEW_CANONICAL');
      } catch { stop('LOCAL_PREVIEW_CANONICAL'); }
      report.source.canonicalStatus = 'verified';
      report.status = report.attempt.preview.status; report.error = report.attempt.preview.error;
      report.execution = report.attempt.preview.original?.output?.execution ?? { status: 'unavailable' };
      report.measurements = projection(report.attempt.preview);
    }
  } catch (error) {
    cause = error?.localCode ?? (signal?.aborted ? 'LOCAL_PREVIEW_CANCELLED' : controller.signal.aborted ? 'LOCAL_PREVIEW_BUDGET' : 'LOCAL_PREVIEW_PREPARATION');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel); cancel();
    try {
      const timeoutMs = Math.max(1, Math.min(DRAIN, Math.floor(WALL + DRAIN - (performance.now() - started))));
      report.drain = await rpc.drain({ timeoutMs });
      if (!report.drain.complete || report.attempt?.broker.pendingAtReturn > 0) cause = 'LOCAL_PREVIEW_DRAIN';
    } catch { cause = 'LOCAL_PREVIEW_DRAIN'; }
    try { report.transportEvidence = rpc.snapshotEvidence(); report.usage = rpc.usage(); } catch { cause = 'LOCAL_PREVIEW_PREPARATION'; }
  }
  if (cause) withholdLocalSimulation(report, cause);
  report.timing = { totalMs: Math.max(0, performance.now() - started) };
  if (Buffer.byteLength(JSON.stringify(report)) > RESPONSE) {
    withholdLocalSimulation(report, 'LOCAL_PREVIEW_OUTPUT'); delete report.audit; report.attempt = null;
  }
  return report;
}
