// Experimental message execution. No provider trace, expected output, signature,
// transaction broadcast, or transaction fee settlement enters this module.
import { performance } from 'node:perf_hooks';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createEVM, EVMError } from '@ethereumjs/evm';
import { bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { ethereumCommon, ethereumContextProfile } from './ethereum-profile.js';
import { normalizeEvmContext } from '../evm-context.js';

export const EXECUTION_LIMITS = Object.freeze({ gas: 5000000, steps: 1000000, frames: 1000, depth: 32, logs: 2000, memoryBytes: 1048576, returnBytes: 1048576, calldataBytes: 32768, traceBytes: 8388608, wallMs: 10000 });
export const ETHEREUM_EXECUTION_LIMITS = Object.freeze({ ...EXECUTION_LIMITS, wallMs: 120000 });
const ADDRESS = /^0x[0-9a-f]{40}$/i, WORD = /^0x[0-9a-f]{64}$/i, BYTES = /^0x(?:[0-9a-f]{2})*$/i;
const CORE_WRITER = '0x3333333333333333333333333333333333333333';
const UINT256_MAX = (1n << 256n) - 1n;
const activeManagers = new WeakSet();
const evmErrors = new Set(Object.values(EVMError.errorMessages));
const callOpcodes = new Map([[0xf1, 'CALL'], [0xf2, 'CALLCODE'], [0xf4, 'DELEGATECALL'], [0xfa, 'STATICCALL']]);
const createOpcodes = new Map([[0xf0, 'CREATE'], [0xf5, 'CREATE2']]);
const hex = value => '0x' + BigInt(value).toString(16);
const address = value => typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null;
const quantity = value => typeof value === 'bigint' && value >= 0n && value <= UINT256_MAX ? value : typeof value === 'string' && value.length <= 80 && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) && BigInt(value) <= UINT256_MAX ? BigInt(value) : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
class ExecutionError extends Error {
  constructor(code, message, status = 'unavailable') { super(message); this.code = code; this.status = status; }
}
const reject = (code, message, status) => { throw new ExecutionError(code, message, status); };
function supportedAddress(value, chainId) {
  const target = typeof value === 'string' ? address(value) : value?.toString?.();
  if (!target || !ADDRESS.test(target)) return;
  const n = BigInt(target);
  // Official HyperCore reads start at0x0800. Reserve the whole0x08xx band,
  // including unknown future entries, instead of interpreting them as EOAs.
  if (chainId === 999 && n >= 0x800n && n <= 0x8ffn) reject('LOCAL_HYPERCORE_UNSUPPORTED', 'HyperCore read precompile execution is unsupported.', 'unsupported');
  if (chainId === 999 && target.toLowerCase() === CORE_WRITER) reject('LOCAL_COREWRITER_UNSUPPORTED', 'CoreWriter execution and HyperCore effects are unsupported.', 'unsupported');
  if (n === 10n) reject('LOCAL_BLOB_UNSUPPORTED', 'The KZG point-evaluation precompile is outside this local engine profile.', 'unsupported');
}
function safeFailure(error) {
  if (error instanceof ExecutionError) return { status: error.status, error: { code: error.code, message: error.message } };
  if (error?.code === 'LOCAL_STATE_MISSING') return { status: 'unavailable', error: { code: 'LOCAL_STATE_MISSING', message: 'Required local input state was not supplied.' } };
  if (error?.code === 'LOCAL_STATE_UNSUPPORTED') return { status: 'unsupported', error: { code: 'LOCAL_STATE_UNSUPPORTED', message: 'The supplied sparse state adapter does not support this state change.' } };
  return { status: 'unavailable', error: { code: 'LOCAL_EXECUTION_FAILED', message: 'Local execution could not complete; arbitrary host error details are omitted.' } };
}

/** Execute real bytecode against the supplied manager. Completed message calls
 * retain their state; infrastructure/unsupported/limit failures roll it back.
 * The supplied manager and blockchain must themselves bound asynchronous I/O.
 * `now` is an internal deterministic test clock, never a public request field. */
export async function executeUnsignedCall({ request, block, stateManager, blockchain, chainId = 999, limits: requestedLimits = {}, now = () => performance.now() }) {
  const ceilings = chainId === 1 ? ETHEREUM_EXECUTION_LIMITS : EXECUTION_LIMITS;
  const limits = { ...ceilings }, startedAt = now();
  const usage = { steps: 0, frames: 0, maxDepth: 0, logOpcodes: 0, retainedTraceBytes: 0 };
  const semantics = {
    kind: 'unsigned_message', signatureVerification: false, transactionNonceValidation: false,
    callerNonce: 'runCall_increments_once_including_EVM_revert', gasBudget: 'message_execution_only_intrinsic_transaction_gas_not_subtracted',
    gasUsed: 'execution_gas_before_transaction_refund_and_intrinsic_gas', gasPrice: '0', feeSettlement: false,
    warmAddresses: 'sender_destination_coinbase_and_Ethereum_precompiles_1_to_10_no_access_list',
    logs: 'committed_root_result_only_no_duplicated_descendant_log_arrays', callTree: 'entered_messages_only',
    chainScope: 'Ethereum_Cancun_rules_with_chainId999_not_full_HyperEVM_equivalence',
    lifecycle: chainId === 1 ? 'no_lifecycle_operation_encountered' : 'CREATE_CREATE2_SELFDESTRUCT_unsupported', deadline: 'cooperative_until_final_atomic_commit_no_forceful_IO_cancellation',
  };
  let root = null, environment = null, evm, checkpointDepth = 0, ownsManager = false;
  const stack = [];
  const reserved = value => supportedAddress(value, chainId);
  function bound(name, value) { if (value > limits[name]) reject('LOCAL_RESOURCE_LIMIT', `Local execution exceeded its ${name} limit.`); }
  function clockCheck() { if (now() - startedAt >= limits.wallMs) reject('LOCAL_RESOURCE_LIMIT', 'Local execution exceeded its wallMs limit.'); }
  function retain(size) { usage.retainedTraceBytes += size; bound('traceBytes', usage.retainedTraceBytes); }
  async function restore() {
    while (checkpointDepth > 0) { await stateManager.revert(); checkpointDepth--; }
  }
  try {
    if (![1, 999].includes(chainId)) reject('LOCAL_INVALID_INPUT', 'Only the explicit Ethereum mainnet and legacy HyperEVM development profiles are supported.');
    for (const [key, value] of Object.entries(requestedLimits)) {
      if (!Object.hasOwn(ceilings, key) || !Number.isSafeInteger(value) || value <= 0 || value > ceilings[key]) reject('LOCAL_INVALID_INPUT', 'Execution limits must be positive integers no greater than the fixed ceilings.');
      limits[key] = value;
    }
    if (!stateManager || typeof stateManager !== 'object' || ['getAccount', 'putAccount', 'getCode', 'getStorage', 'checkpoint', 'commit', 'revert'].some(method => typeof stateManager[method] !== 'function')) reject('LOCAL_INVALID_INPUT', 'A compatible explicit state manager is required.');
    if (activeManagers.has(stateManager)) reject('LOCAL_STATE_BUSY', 'Concurrent execution on the same state manager is not supported.');
    let context; try { context = normalizeEvmContext(request); } catch { reject('LOCAL_INVALID_INPUT', 'Optional EVM context is malformed.'); }
    if (chainId !== 1 && Object.keys(context).length) reject('LOCAL_INVALID_INPUT', 'Optional execution context requires the Ethereum profile.');
    const topLevelCreation = chainId === 1 && request?.to === null;
    const from = address(request?.from), to = address(request?.to), value = quantity(request?.value), gasLimit = quantity(request?.gasLimit);
    if (!from || (!to && !topLevelCreation) || (topLevelCreation && context.blobVersionedHashes !== undefined) || value === null || gasLimit === null || (chainId === 999 && gasLimit === 0n) || gasLimit > BigInt(limits.gas) || typeof request?.data !== 'string' || !BYTES.test(request.data) || request.data.length > 2 + limits.calldataBytes * 2 || Object.keys(request).some(key => !['from', 'to', 'data', 'value', 'gasLimit', 'accessList', 'blobVersionedHashes'].includes(key))) reject('LOCAL_INVALID_INPUT', 'A bounded unsigned message with explicit from, destination (or Ethereum creation null), data, value and message gasLimit is required.');
    reserved(from); reserved(to);
    if (!block || ['number', 'timestamp', 'gasLimit', 'baseFeePerGas'].some(field => quantity(block[field]) === null) || quantity(block.gasLimit) === 0n || typeof block.mixHash !== 'string' || !WORD.test(block.mixHash) || !address(block.miner) || ['hash', 'parentHash'].some(field => block[field] !== undefined && (typeof block[field] !== 'string' || !WORD.test(block[field])))) reject('LOCAL_INVALID_INPUT', 'Explicit block number, timestamp, gas limit, base fee, prevRandao and coinbase are required.');
    const common = chainId === 1 ? ethereumCommon(block) : createCustomCommon({ chainId: 999, name: 'experimental-hyperevm-message' }, Mainnet, { hardfork: Hardfork.Cancun });
    const canCreate = chainId === 1 && typeof stateManager.beginContractCreation === 'function';
    let observedCreation = false, observedSelfdestruct = false;
    function describeLifecycle() {
      if (observedSelfdestruct) semantics.lifecycle = (observedCreation ? (topLevelCreation ? 'top_level_CREATE_and_' : '') + 'internal_CREATE_CREATE2_and_' : '') + 'preexisting_Cancun_SELFDESTRUCT_without_deletion_same_invocation_creation_and_Shanghai_SELFDESTRUCT_unsupported';
      else if (observedCreation) semantics.lifecycle = topLevelCreation ? 'top_level_CREATE_and_internal_CREATE_CREATE2_with_proven_deployable_targets_same_invocation_creation_and_Shanghai_SELFDESTRUCT_unsupported' : 'internal_CREATE_CREATE2_with_proven_deployable_targets_same_invocation_creation_and_Shanghai_SELFDESTRUCT_unsupported';
    }
    if (topLevelCreation && !canCreate) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'Top-level creation requires an authenticated creation-capable state manager.', 'unsupported');
    if (chainId === 1) {
      try { ethereumContextProfile(context, block, common); } catch { reject('LOCAL_INVALID_INPUT', 'Optional execution context does not match the selected fork/header.'); }
      semantics.chainScope = 'Ethereum_mainnet_pinned_timestamp_selected_fork';
      semantics.warmAddresses = topLevelCreation
        ? context.accessList ? 'sender_coinbase_fork_active_precompiles_and_declared_access_list_creation_target_warmed_by_EVM' : 'sender_coinbase_and_fork_active_precompiles_creation_target_warmed_by_EVM_no_access_list'
        : context.accessList ? 'sender_destination_coinbase_fork_active_precompiles_and_declared_access_list' : 'sender_destination_coinbase_and_fork_active_precompiles_no_access_list';
    }
    environment = { chainId, hardfork: common.hardfork(), number: quantity(block.number).toString(), timestamp: quantity(block.timestamp).toString(), gasLimit: quantity(block.gasLimit).toString(), baseFeePerGas: quantity(block.baseFeePerGas).toString(), mixHash: block.mixHash.toLowerCase(), miner: address(block.miner), ...(block.hash ? { sourceBlockHash: block.hash.toLowerCase() } : {}), ...(block.parentHash ? { sourceParentHash: block.parentHash.toLowerCase() } : {}), sourceBlockIdentityVerified: false };
    activeManagers.add(stateManager); ownsManager = true;
    const methods = new Map();
    // Bind methods to the real manager; track every nested checkpoint so a host
    // exception in an EVM event cannot leave partially applied state behind.
    const guarded = new Proxy(stateManager, { get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (!methods.has(property)) methods.set(property, async (...args) => {
        clockCheck();
        if (['getAccount', 'putAccount', 'deleteAccount', 'modifyAccountFields', 'getCode', 'putCode', 'getCodeSize', 'getStorage', 'putStorage', 'clearStorage', 'beginContractCreation'].includes(property)) reserved(args[0]);
        const result = await member.apply(target, args);
        if (property === 'checkpoint') checkpointDepth++;
        else if (property === 'commit' || property === 'revert') checkpointDepth--;
        clockCheck();
        return result;
      });
      return methods.get(property);
    } });
    const hashes = {
      async getBlock(number) {
        clockCheck();
        if (!blockchain || typeof blockchain.getBlock !== 'function') reject('LOCAL_BLOCKHASH_MISSING', 'An in-range BLOCKHASH requires an explicitly supplied block hash.', 'unsupported');
        const found = await blockchain.getBlock(number); clockCheck();
        const hash = found?.hash?.();
        if (!(hash instanceof Uint8Array) || hash.length !== 32) reject('LOCAL_BLOCKHASH_MISSING', 'An in-range BLOCKHASH requires an explicitly supplied block hash.', 'unsupported');
        return { hash: () => hash.slice() };
      },
      async putBlock() { reject('LOCAL_BLOCKCHAIN_WRITE_UNSUPPORTED', 'Block writes are unsupported.', 'unsupported'); },
      shallowCopy() { return this; },
    };
    evm = await createEVM({ common, stateManager: guarded, blockchain: hashes });
    // Each invocation is a fresh message/transaction-context boundary for
    // SSTORE refund accounting, even when the caller retains the same manager.
    stateManager.originalStorageCache?.clear();
    for (const warm of [from, ...(to ? [to] : []), address(block.miner), ...evm.precompiles.keys()]) evm.journal.addAlwaysWarmAddress(warm);
    for (const entry of context.accessList ?? []) {
      evm.journal.addAlwaysWarmAddress(entry.address);
      for (const slot of entry.storageKeys) evm.journal.addAlwaysWarmSlot(entry.address, slot);
    }
    evm.events.on('beforeMessage', message => {
      clockCheck();
      const creation = !message.to;
      if (creation && (!canCreate || (!stack.length && !topLevelCreation))) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'This profile requires an explicit supported contract creation.', 'unsupported');
      if (!creation) { reserved(message.to); reserved(message.codeAddress); }
      bound('frames', ++usage.frames); bound('depth', message.depth); usage.maxDepth = Math.max(usage.maxDepth, message.depth);
      bound('calldataBytes', message.data.length); retain(512 + message.data.length * 2);
      const parent = stack.at(-1), type = parent ? parent.pendingCall ?? (creation ? 'CREATE' : message.delegatecall ? 'DELEGATECALL' : message.isStatic ? 'STATICCALL' : 'CALL') : creation ? 'CREATE' : 'CALL';
      if (creation) { observedCreation = true; describeLifecycle(); }
      const frame = { type, from: parent?.frame.executionAddress ?? message.caller.toString(), to: creation ? null : message.codeAddress.toString(), executionAddress: creation ? null : message.to.toString(), caller: message.caller.toString(), value: hex(message.value), input: bytesToHex(message.data), gas: hex(message.gasLimit), gasUsed: null, output: null, error: null, depth: message.depth, calls: [] };
      if (parent) parent.frame.calls.push(frame); else root = frame;
      // This is the EVM's invocation-local creation set. The state manager's
      // creation marker deliberately survives copied after-state query forks.
      stack.push({ frame, pendingCall: null, createdAddresses: message.createdAddresses });
    });
    evm.events.on('newContract', event => {
      clockCheck(); const active = stack.at(-1), target = event.address.toString();
      if (!canCreate || !active || !['CREATE', 'CREATE2'].includes(active.frame.type) || active.frame.to !== null) reject('LOCAL_TRACE_INVALID', 'Creation event does not match the entered creation frame.');
      // EthereumJS does not await one-argument event listeners. The manager's
      // marker is synchronous over facts already loaded by clearStorage.
      reserved(target); stateManager.beginContractCreation(event.address, active.frame.depth === 0 ? 'top_level_contract_creation' : 'internal_contract_creation');
      active.frame.to = target; active.frame.executionAddress = target;
    });
    evm.events.on('step', step => {
      clockCheck(); bound('steps', ++usage.steps); bound('memoryBytes', step.memory.length);
      const active = stack.at(-1);
      if (createOpcodes.has(step.opcode.code) && !canCreate) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'This local profile does not support the requested lifecycle operation.', 'unsupported');
      if (step.opcode.code === 0xff) {
        // runCall applies the EIP-6780 balance transfer, but never performs VM
        // transaction-end deletion. Admit only paths that require no deletion.
        const executionAddress = step.address.toString();
        if (chainId !== 1 || !common.isActivatedEIP(6780) || !active || active.frame.executionAddress !== executionAddress || !(active.createdAddresses instanceof Set) || active.createdAddresses.has(executionAddress)) reject('LOCAL_LIFECYCLE_UNSUPPORTED', 'SELFDESTRUCT deletion or unsupported fork context is outside this local profile.', 'unsupported');
        observedSelfdestruct = true; describeLifecycle();
      }
      // On Ethereum, absent blob hashes are the empty transaction list: BLOBHASH
      // returns zero through the fork-selected EVM opcode. BLOBBASEFEE still
      // requires our explicit synthetic fee context; keep the legacy999 scope.
      if ((step.opcode.code === 0x4a || (step.opcode.code === 0x49 && chainId !== 1)) && !context.blobVersionedHashes) reject('LOCAL_BLOB_UNSUPPORTED', 'Blob transaction context is outside this local engine profile.', 'unsupported');
      if (step.opcode.code >= 0xa0 && step.opcode.code <= 0xa4) bound('logs', ++usage.logOpcodes);
      if (active) active.pendingCall = callOpcodes.get(step.opcode.code) ?? createOpcodes.get(step.opcode.code) ?? null;
      if (callOpcodes.has(step.opcode.code) && step.stack.length >= 2) reserved('0x' + (step.stack.at(-2) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0'));
    });
    evm.events.on('afterMessage', result => {
      clockCheck();
      // A final instruction can expand memory and fall off the bytecode without
      // another pre-op step event; validate its completed frame as well.
      const memoryWords = result.execResult.runState?.memoryWordCount;
      if (memoryWords !== undefined) bound('memoryBytes', memoryWords * 32n);
      const active = stack.pop();
      if (!active) reject('LOCAL_TRACE_INVALID', 'Local call-tree event nesting is inconsistent.');
      if (['CREATE', 'CREATE2'].includes(active.frame.type)) {
        const created = result.createdAddress?.toString() ?? null;
        if (active.frame.to !== null && active.frame.to !== created) reject('LOCAL_TRACE_INVALID', 'Creation result address disagrees with its entered frame.');
        active.frame.to = created; active.frame.executionAddress = created;
      }
      const output = result.execResult.returnValue;
      bound('returnBytes', output.length); retain(output.length * 2 + 128);
      active.frame.gasUsed = hex(result.execResult.executionGasUsed); active.frame.output = bytesToHex(output);
      const error = result.execResult.exceptionError?.error;
      active.frame.error = error === undefined ? null : evmErrors.has(error) ? error : 'unrecognized EVM exception';
    });
    if (chainId === 1) {
      const sender = createAddressFromString(from), account = await guarded.getAccount(sender), code = await guarded.getCode(sender);
      if (code.length) reject('LOCAL_SENDER_CODE_UNSUPPORTED', 'The unsigned reference requires a sender without runtime code.', 'unsupported');
      if ((account?.balance ?? 0n) < value) reject('LOCAL_CALL_INSUFFICIENT_BALANCE', 'The sender cannot cover the declared native value.', 'invalid');
      if ((account?.nonce ?? 0n) >= (1n << 64n) - 1n) reject('LOCAL_CALL_NONCE_OVERFLOW', 'The sender nonce cannot be incremented within uint64.', 'invalid');
    }
    await guarded.checkpoint();
    const result = await evm.runCall({ caller: createAddressFromString(from), origin: createAddressFromString(from), ...(to ? { to: createAddressFromString(to) } : {}), data: hexToBytes(request.data), value, gasLimit, gasPrice: 0n, ...(context.blobVersionedHashes ? { blobVersionedHashes: [...context.blobVersionedHashes] } : {}), block: { header: { number: quantity(block.number), timestamp: quantity(block.timestamp), gasLimit: quantity(block.gasLimit), baseFeePerGas: quantity(block.baseFeePerGas), difficulty: 0n, prevRandao: hexToBytes(block.mixHash), coinbase: createAddressFromString(address(block.miner)), getBlobGasPrice() { if (context.blobVersionedHashes) return 0n; reject('LOCAL_BLOB_UNSUPPORTED', 'Blob transaction context is unsupported.', 'unsupported'); } } } });
    clockCheck();
    if (stack.length || checkpointDepth !== 1) reject('LOCAL_TRACE_INVALID', 'Local call-tree or checkpoint completion is inconsistent.');
    const logs = (result.execResult.logs ?? []).map(([emitter, topics, data]) => ({ address: bytesToHex(emitter), topics: topics.map(bytesToHex), data: bytesToHex(data) }));
    bound('logs', logs.length); bound('returnBytes', result.execResult.returnValue.length);
    usage.retainedTraceBytes = Buffer.byteLength(JSON.stringify({ trace: root, logs }), 'utf8'); bound('traceBytes', usage.retainedTraceBytes);
    const error = root.error, status = !error ? 'success' : error === 'revert' ? 'reverted' : 'failed';
    const report = { execution: { status, executionGasUsed: result.execResult.executionGasUsed.toString(), gasRefundCounter: (result.execResult.gasRefund ?? 0n).toString(), returnData: bytesToHex(result.execResult.returnValue), error }, trace: root, logs, environment, semantics, limits, usage, stateDisposition: 'message_result_retained_in_supplied_manager' };
    clockCheck();
    // Final atomic commit is the irreversible terminal step: no subsequent
    // deadline/output validation may mislabel retained state as rolled back.
    await stateManager.commit(); checkpointDepth--;
    return report;
  } catch (error) {
    let stateDisposition = 'unchanged';
    if (checkpointDepth > 0) {
      try { await restore(); stateDisposition = 'rolled_back'; }
      catch { stateDisposition = 'rollback_failed_discard_manager'; }
    }
    const failure = stateDisposition === 'rollback_failed_discard_manager' ? { status: 'unavailable', error: { code: 'LOCAL_ROLLBACK_FAILED', message: 'Local rollback failed; discard the supplied state manager.' } } : safeFailure(error);
    for (const active of stack) active.frame.incomplete = true;
    return { execution: { ...failure, executionGasUsed: null, returnData: null }, trace: root, logs: [], environment, semantics, limits, usage, stateDisposition };
  } finally { evm?.events.removeAllListeners(); if (ownsManager) activeManagers.delete(stateManager); }
}
